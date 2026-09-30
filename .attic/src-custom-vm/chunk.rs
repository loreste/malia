//! Bytecode: a `Chunk` is a flat vector of `Op`s plus a constant pool.

use crate::value::Value;

/// Describes how a closure captures one upvalue from its enclosing frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpvalDesc {
    /// Capture the cell in the parent frame's local slot.
    ParentLocal(u32),
    /// Re-capture one of the parent closure's own upvalues.
    ParentUpval(u32),
}

#[derive(Clone, Debug)]
pub enum Op {
    /// Push constants[idx].
    Const(u32),
    Undefined,
    Null,
    True,
    False,
    Pop,
    /// Duplicate the top of stack.
    Dup,
    Add,
    Sub,
    Mul,
    Div,
    Rem,
    Neg,
    Not,
    /// Loose `==` / `!=`.
    Eq,
    Ne,
    /// Strict `===` / `!==`.
    Seq,
    Sne,
    Lt,
    Le,
    Gt,
    Ge,
    Jump(u32),
    /// Pop; jump if falsy.
    JumpIfFalse(u32),
    /// Pop; jump if truthy.
    JumpIfTrue(u32),
    /// Pop; jump unless Null/Undefined.
    JumpIfNotNullish(u32),
    GetLocal(u32),
    SetLocal(u32),
    /// Like GetLocal/SetLocal but through a captured-variable cell.
    GetLocalCell(u32),
    SetLocalCell(u32),
    /// Convert local slot into a cell (emitted after initializing a
    /// variable that is captured by a nested closure).
    MakeCell(u32),
    GetUpval(u32),
    SetUpval(u32),
    /// Build a closure from the prototype in constants[idx].
    Closure(u32, Box<[UpvalDesc]>),
    /// Globals by name; idx points at a String constant holding the name.
    GetGlobal(u32),
    SetGlobal(u32),
    /// Pop n values, push a new array.
    NewArray(u32),
    /// Pop n (key, value) pairs (key pushed first), push a new object.
    NewObject(u32),
    /// Property access by fixed name (constants[idx] is the name String).
    GetProp(u32),
    SetProp(u32),
    /// Computed access: obj[key].
    GetIndex,
    SetIndex,
    This,
    /// Stack: [callee, arg0..argN]
    Call(u32),
    /// Stack: [receiver, callee, arg0..argN]; receiver becomes `this`.
    CallMethod(u32),
    Return,
}

#[derive(Default)]
pub struct Chunk {
    pub code: Vec<Op>,
    pub constants: Vec<Value>,
}

impl Chunk {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_const(&mut self, v: Value) -> u32 {
        self.constants.push(v);
        (self.constants.len() - 1) as u32
    }

    /// Add a String constant with the given name, reusing an existing one.
    pub fn name_const(&mut self, name: &str) -> u32 {
        for (i, c) in self.constants.iter().enumerate() {
            if let Value::String(s) = c {
                if &**s == name {
                    return i as u32;
                }
            }
        }
        self.add_const(Value::str(name))
    }
}
