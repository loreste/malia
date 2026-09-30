//! The stack-based virtual machine: dispatch loop, call frames, operand stacks.
//!
//! Each green-thread task owns one `Vm` (its own frame stack). The dispatch
//! loop is `async` and checks a yield budget every `YIELD_EVERY` ops so that
//! CPU-bound tasks cooperatively share their OS thread with others.

use std::sync::{Arc, Mutex};

use crate::builtins;
use crate::chunk::{Op, UpvalDesc};
use crate::scheduler::RuntimeCtx;
use crate::value::{Closure, NativeResult, Object, Value};

/// How many ops a task may run before yielding to the tokio scheduler.
const YIELD_EVERY: u64 = 2048;
const MAX_FRAMES: usize = 4000;

pub struct Frame {
    pub closure: Arc<Closure>,
    pub ip: usize,
    pub slots: Vec<Value>,
    pub stack: Vec<Value>,
    pub this: Value,
}

pub struct Vm {
    pub ctx: Arc<RuntimeCtx>,
    pub frames: Vec<Frame>,
}

macro_rules! binop_num {
    ($self:ident, $op:tt) => {{
        let b = $self.pop()?;
        let a = $self.pop()?;
        $self.push(Value::Number(a.to_number() $op b.to_number()));
    }};
}

macro_rules! binop_cmp {
    ($self:ident, $op:tt) => {{
        let b = $self.pop()?;
        let a = $self.pop()?;
        let r = match (&a, &b) {
            (Value::String(x), Value::String(y)) => x $op y,
            _ => {
                let (x, y) = (a.to_number(), b.to_number());
                if x.is_nan() || y.is_nan() { false } else { x $op y }
            }
        };
        $self.push(Value::Bool(r));
    }};
}

impl Vm {
    pub fn new(ctx: Arc<RuntimeCtx>) -> Self {
        Vm {
            ctx,
            frames: Vec::new(),
        }
    }

    fn frame(&mut self) -> &mut Frame {
        self.frames.last_mut().expect("no frame")
    }

    fn push(&mut self, v: Value) {
        self.frame().stack.push(v);
    }

    fn pop(&mut self) -> Result<Value, String> {
        self.frame()
            .stack
            .pop()
            .ok_or_else(|| "stack underflow".to_string())
    }

    fn push_frame(
        &mut self,
        closure: Arc<Closure>,
        this: Value,
        args: Vec<Value>,
    ) -> Result<(), String> {
        if self.frames.len() >= MAX_FRAMES {
            return Err("stack overflow (too many nested calls)".to_string());
        }
        let proto = &closure.proto;
        let mut slots = vec![Value::Undefined; proto.nslots];
        for (i, a) in args.into_iter().enumerate().take(proto.arity) {
            slots[i] = a;
        }
        self.frames.push(Frame {
            closure,
            ip: 0,
            slots,
            stack: Vec::new(),
            this,
        });
        Ok(())
    }

    /// Entry point: run a top-level closure to completion.
    pub async fn run(
        &mut self,
        closure: Arc<Closure>,
        this: Value,
        args: Vec<Value>,
    ) -> Result<Value, String> {
        self.push_frame(closure, this, args)?;
        self.exec().await
    }

    fn fetch(&mut self) -> Op {
        let f = self.frame();
        let op = f.closure.proto.chunk.code[f.ip].clone();
        f.ip += 1;
        op
    }

    fn const_at(&self, idx: u32) -> Value {
        self.frames
            .last()
            .unwrap()
            .closure
            .proto
            .chunk
            .constants[idx as usize]
            .clone()
    }

    fn name_at(&self, idx: u32) -> Arc<str> {
        match self.const_at(idx) {
            Value::String(s) => s,
            _ => panic!("constant {idx} is not a name"),
        }
    }

    fn set_jump(&mut self, target: u32) {
        self.frame().ip = target as usize;
    }

    async fn exec(&mut self) -> Result<Value, String> {
        let mut budget: u64 = 0;
        loop {
            budget += 1;
            if budget >= YIELD_EVERY {
                budget = 0;
                tokio::task::yield_now().await;
            }
            self.ctx.ops.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let op = self.fetch();
            match op {
                Op::Const(i) => {
                    let v = self.const_at(i);
                    self.push(v);
                }
                Op::Undefined => self.push(Value::Undefined),
                Op::Null => self.push(Value::Null),
                Op::True => self.push(Value::Bool(true)),
                Op::False => self.push(Value::Bool(false)),
                Op::Pop => {
                    self.pop()?;
                }
                Op::Dup => {
                    let v = self.frame().stack.last().cloned();
                    self.push(v.ok_or("stack underflow")?);
                }
                Op::Add => {
                    let b = self.pop()?;
                    let a = self.pop()?;
                    let r = match (&a, &b) {
                        (Value::Number(x), Value::Number(y)) => Value::Number(x + y),
                        (Value::String(_), _) | (_, Value::String(_)) => {
                            Value::str(&(a.to_display() + &b.to_display()))
                        }
                        _ => Value::Number(a.to_number() + b.to_number()),
                    };
                    self.push(r);
                }
                Op::Sub => binop_num!(self, -),
                Op::Mul => binop_num!(self, *),
                Op::Div => binop_num!(self, /),
                Op::Rem => binop_num!(self, %),
                Op::Neg => {
                    let a = self.pop()?;
                    self.push(Value::Number(-a.to_number()));
                }
                Op::Not => {
                    let a = self.pop()?;
                    self.push(Value::Bool(!a.is_truthy()));
                }
                Op::Eq => {
                    let (b, a) = (self.pop()?, self.pop()?);
                    self.push(Value::Bool(a.loose_eq(&b)));
                }
                Op::Ne => {
                    let (b, a) = (self.pop()?, self.pop()?);
                    self.push(Value::Bool(!a.loose_eq(&b)));
                }
                Op::Seq => {
                    let (b, a) = (self.pop()?, self.pop()?);
                    self.push(Value::Bool(a.strict_eq(&b)));
                }
                Op::Sne => {
                    let (b, a) = (self.pop()?, self.pop()?);
                    self.push(Value::Bool(!a.strict_eq(&b)));
                }
                Op::Lt => binop_cmp!(self, <),
                Op::Le => binop_cmp!(self, <=),
                Op::Gt => binop_cmp!(self, >),
                Op::Ge => binop_cmp!(self, >=),
                Op::Jump(t) => self.set_jump(t),
                Op::JumpIfFalse(t) => {
                    if !self.pop()?.is_truthy() {
                        self.set_jump(t);
                    }
                }
                Op::JumpIfTrue(t) => {
                    if self.pop()?.is_truthy() {
                        self.set_jump(t);
                    }
                }
                Op::JumpIfNotNullish(t) => {
                    let v = self.pop()?;
                    if !matches!(v, Value::Null | Value::Undefined) {
                        self.set_jump(t);
                    }
                }
                Op::GetLocal(slot) => {
                    let v = self.frame().slots[slot as usize].clone();
                    self.push(v);
                }
                Op::SetLocal(slot) => {
                    let v = self.pop()?;
                    self.frame().slots[slot as usize] = v;
                }
                Op::GetLocalCell(slot) => {
                    let v = match &self.frame().slots[slot as usize] {
                        Value::Cell(c) => c.lock().unwrap().clone(),
                        other => other.clone(),
                    };
                    self.push(v);
                }
                Op::SetLocalCell(slot) => {
                    let v = self.pop()?;
                    match &self.frame().slots[slot as usize] {
                        Value::Cell(c) => *c.lock().unwrap() = v,
                        other => {
                            let _ = other;
                            return Err("SetLocalCell on non-cell slot".to_string());
                        }
                    }
                }
                Op::MakeCell(slot) => {
                    let slot = slot as usize;
                    let cur = std::mem::replace(&mut self.frame().slots[slot], Value::Undefined);
                    if !matches!(cur, Value::Cell(_)) {
                        self.frame().slots[slot] = Value::Cell(Arc::new(Mutex::new(cur)));
                    } else {
                        self.frame().slots[slot] = cur;
                    }
                }
                Op::GetUpval(i) => {
                    let cell = self.frames.last().unwrap().closure.upvalues[i as usize].clone();
                    let v = cell.lock().unwrap().clone();
                    self.push(v);
                }
                Op::SetUpval(i) => {
                    let v = self.pop()?;
                    let cell = self.frames.last().unwrap().closure.upvalues[i as usize].clone();
                    *cell.lock().unwrap() = v;
                }
                Op::Closure(idx, descs) => {
                    let base = match self.const_at(idx) {
                        Value::Function(c) => c,
                        _ => return Err("Closure constant is not a function".to_string()),
                    };
                    let mut upvalues = Vec::with_capacity(descs.len());
                    for d in descs.iter() {
                        let cell = match d {
                            UpvalDesc::ParentLocal(slot) => {
                                match &self.frame().slots[*slot as usize] {
                                    Value::Cell(c) => c.clone(),
                                    _ => {
                                        return Err(format!(
                                            "captured local slot {slot} is not a cell"
                                        ))
                                    }
                                }
                            }
                            UpvalDesc::ParentUpval(i) => {
                                self.frames.last().unwrap().closure.upvalues[*i as usize].clone()
                            }
                        };
                        upvalues.push(cell);
                    }
                    self.push(Value::Function(Arc::new(Closure {
                        proto: base.proto.clone(),
                        upvalues,
                    })));
                }
                Op::GetGlobal(idx) => {
                    let name = self.name_at(idx);
                    let v = self.ctx.globals.read().unwrap().get(&*name).cloned();
                    match v {
                        Some(v) => self.push(v),
                        None => return Err(format!("{name} is not defined")),
                    }
                }
                Op::SetGlobal(idx) => {
                    let name = self.name_at(idx);
                    let v = self.pop()?;
                    self.ctx.globals.write().unwrap().insert(name.to_string(), v);
                }
                Op::NewArray(n) => {
                    let mut items = Vec::with_capacity(n as usize);
                    for _ in 0..n {
                        items.push(self.pop()?);
                    }
                    items.reverse();
                    self.push(Value::Array(Arc::new(Mutex::new(items))));
                }
                Op::NewObject(n) => {
                    let mut obj = Object::default();
                    for _ in 0..n {
                        let val = self.pop()?;
                        let key = self.pop()?;
                        obj.props.insert(key.to_display(), val);
                    }
                    self.push(Value::Object(Arc::new(Mutex::new(obj))));
                }
                Op::GetProp(idx) => {
                    let name = self.name_at(idx);
                    let obj = self.pop()?;
                    let v = get_prop(&obj, &name)?;
                    self.push(v);
                }
                Op::SetProp(idx) => {
                    let name = self.name_at(idx);
                    let val = self.pop()?;
                    let obj = self.pop()?;
                    set_prop(&obj, &name, val.clone())?;
                    // Assignment is an expression: leave the value on the stack.
                    self.push(val);
                }
                Op::GetIndex => {
                    let key = self.pop()?;
                    let obj = self.pop()?;
                    let v = get_index(&obj, &key)?;
                    self.push(v);
                }
                Op::SetIndex => {
                    let val = self.pop()?;
                    let key = self.pop()?;
                    let obj = self.pop()?;
                    set_index(&obj, &key, val.clone())?;
                    // Assignment is an expression: leave the value on the stack.
                    self.push(val);
                }
                Op::This => {
                    let v = self.frames.last().unwrap().this.clone();
                    self.push(v);
                }
                Op::Call(argc) => {
                    self.do_call(argc as usize, None).await?;
                }
                Op::CallMethod(argc) => {
                    self.do_call(argc as usize, Some(true)).await?;
                }
                Op::Return => {
                    let v = self
                        .frame()
                        .stack
                        .pop()
                        .unwrap_or(Value::Undefined);
                    self.frames.pop();
                    match self.frames.last_mut() {
                        Some(caller) => caller.stack.push(v),
                        None => return Ok(v),
                    }
                }
            }
        }
    }

    /// If `is_method` is Some, the stack layout is [receiver, callee, args..]
    /// and the receiver becomes `this` for the call.
    async fn do_call(&mut self, argc: usize, is_method: Option<bool>) -> Result<(), String> {
        let method = is_method.unwrap_or(false);
        let extra = if method { 2 } else { 1 };
        let f = self.frame();
        let len = f.stack.len();
        if len < argc + extra {
            return Err("stack underflow on call".to_string());
        }
        let callee_idx = len - argc - 1;
        let callee = f.stack[callee_idx].clone();
        let this = if method {
            f.stack[callee_idx - 1].clone()
        } else {
            Value::Undefined
        };
        let args: Vec<Value> = f.stack.drain(callee_idx + 1..).collect();
        // Remove callee (and receiver for method calls).
        f.stack.truncate(callee_idx - if method { 1 } else { 0 });

        match callee {
            Value::Function(closure) => self.push_frame(closure, this, args),
            Value::Native(native) => {
                match (native.func)(self, &this, &args)? {
                    NativeResult::Value(v) => {
                        self.push(v);
                        Ok(())
                    }
                    NativeResult::Suspend(fut) => {
                        let v = fut.await?;
                        self.push(v);
                        Ok(())
                    }
                }
            }
            other => Err(format!("{} is not a function", other.to_display())),
        }
    }
}

/// Property access on any value (`.` with a fixed name).
pub fn get_prop(obj: &Value, name: &str) -> Result<Value, String> {
    match obj {
        Value::Object(o) => Ok(o.lock().unwrap().props.get(name).cloned().unwrap_or(Value::Undefined)),
        Value::Array(a) => match name {
            "length" | "len" => Ok(Value::Number(a.lock().unwrap().len() as f64)),
            "push" => Ok(builtins::array_push()),
            "pop" => Ok(builtins::array_pop()),
            "join" => Ok(builtins::array_join()),
            "includes" => Ok(builtins::array_includes()),
            _ => {
                if let Ok(i) = name.parse::<usize>() {
                    Ok(a
                        .lock()
                        .unwrap()
                        .get(i)
                        .cloned()
                        .unwrap_or(Value::Undefined))
                } else {
                    Ok(Value::Undefined)
                }
            }
        },
        Value::String(s) => match name {
            "length" | "len" => Ok(Value::Number(s.chars().count() as f64)),
            _ => Ok(Value::Undefined),
        },
        Value::Undefined | Value::Null => Err(format!(
            "cannot read property '{name}' of {}",
            obj.to_display()
        )),
        _ => Ok(Value::Undefined),
    }
}

pub fn set_prop(obj: &Value, name: &str, val: Value) -> Result<(), String> {
    match obj {
        Value::Object(o) => {
            o.lock().unwrap().props.insert(name.to_string(), val);
            Ok(())
        }
        Value::Array(a) => {
            if let Ok(i) = name.parse::<usize>() {
                let mut a = a.lock().unwrap();
                if i >= a.len() {
                    a.resize(i + 1, Value::Undefined);
                }
                a[i] = val;
                Ok(())
            } else {
                Err(format!("cannot set property '{name}' on array"))
            }
        }
        Value::Undefined | Value::Null => Err(format!(
            "cannot set property '{name}' of {}",
            obj.to_display()
        )),
        _ => Err(format!("cannot set property '{name}' on primitive")),
    }
}

pub fn get_index(obj: &Value, key: &Value) -> Result<Value, String> {
    match obj {
        Value::Array(a) => {
            let i = key.to_number();
            if i < 0.0 || i.is_nan() {
                return Ok(Value::Undefined);
            }
            Ok(a
                .lock()
                .unwrap()
                .get(i as usize)
                .cloned()
                .unwrap_or(Value::Undefined))
        }
        Value::Object(o) => Ok(o
            .lock()
            .unwrap()
            .props
            .get(&key.to_display())
            .cloned()
            .unwrap_or(Value::Undefined)),
        Value::String(s) => {
            let i = key.to_number() as usize;
            Ok(s.chars()
                .nth(i)
                .map(|c| Value::str(&c.to_string()))
                .unwrap_or(Value::Undefined))
        }
        Value::Undefined | Value::Null => Err(format!(
            "cannot index {} with {}",
            obj.to_display(),
            key.to_display()
        )),
        _ => Ok(Value::Undefined),
    }
}

pub fn set_index(obj: &Value, key: &Value, val: Value) -> Result<(), String> {
    match obj {
        Value::Array(a) => {
            let i = key.to_number();
            if i < 0.0 || i.is_nan() {
                return Err("invalid array index".to_string());
            }
            let i = i as usize;
            let mut a = a.lock().unwrap();
            if i >= a.len() {
                a.resize(i + 1, Value::Undefined);
            }
            a[i] = val;
            Ok(())
        }
        Value::Object(o) => {
            o.lock()
                .unwrap()
                .props
                .insert(key.to_display(), val);
            Ok(())
        }
        Value::Undefined | Value::Null => Err(format!(
            "cannot index {} with {}",
            obj.to_display(),
            key.to_display()
        )),
        _ => Err(format!("cannot index {}", obj.to_display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunk::Chunk;
    use crate::scheduler::RuntimeCtx;
    use crate::value::FuncProto;

    fn run_chunk(chunk: Chunk, nslots: usize) -> Value {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let ctx = RuntimeCtx::new();
            let mut vm = Vm::new(ctx);
            let proto = Arc::new(FuncProto {
                name: Some("main".into()),
                arity: 0,
                nslots,
                chunk,
            });
            let closure = Arc::new(Closure {
                proto,
                upvalues: vec![],
            });
            vm.run(closure, Value::Undefined, vec![]).await.unwrap()
        })
    }

    #[test]
    fn hand_built_arithmetic() {
        // (2 + 3) * 4 - 5 == 15
        let mut c = Chunk::new();
        let two = c.add_const(Value::Number(2.0));
        let three = c.add_const(Value::Number(3.0));
        let four = c.add_const(Value::Number(4.0));
        let five = c.add_const(Value::Number(5.0));
        c.code = vec![
            Op::Const(two),
            Op::Const(three),
            Op::Add,
            Op::Const(four),
            Op::Mul,
            Op::Const(five),
            Op::Sub,
            Op::Return,
        ];
        match run_chunk(c, 0) {
            Value::Number(n) => assert_eq!(n, 15.0),
            other => panic!("expected 15, got {other:?}"),
        }
    }

    #[test]
    fn hand_built_locals_and_jumps() {
        // slot0 = 10; if (slot0 > 5) slot0 = slot0 * 2; return slot0
        let mut c = Chunk::new();
        let ten = c.add_const(Value::Number(10.0));
        let five = c.add_const(Value::Number(5.0));
        let two = c.add_const(Value::Number(2.0));
        c.code = vec![
            Op::Const(ten),
            Op::SetLocal(0),
            Op::GetLocal(0),
            Op::Const(five),
            Op::Gt,
            Op::JumpIfFalse(10),
            Op::GetLocal(0),
            Op::Const(two),
            Op::Mul,
            Op::SetLocal(0),
            Op::GetLocal(0), // ip 10
            Op::Return,
        ];
        match run_chunk(c, 1) {
            Value::Number(n) => assert_eq!(n, 20.0),
            other => panic!("expected 20, got {other:?}"),
        }
    }
}
