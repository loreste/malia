//! Compiler: lowers the oxc AST to our bytecode.
//!
//! Supported subset (anything else is a compile error naming the construct):
//! - literals: number, string, boolean, null, undefined, template literals
//! - arithmetic / comparison / logical (`&&`, `||`, `??`) operators
//! - `let` / `const` / `var`, assignment, compound assignment, `++` / `--`
//! - `if` / `else`, `while`, `for`, `break`, `continue`, `return`
//! - function declarations & expressions, closures (cell-based upvalues),
//!   recursion
//! - object & array literals, property access/assignment, computed indexing,
//!   method calls with `this`
//!
//! Scoping model: the top level of a script is compiled with declarations
//! going to the shared global scope (so top-level bindings are visible from
//! every green thread). Inside functions, variables are local slots; a local
//! captured by a nested closure is boxed into a cell (`MakeCell`) so all
//! captures share one mutable location.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use oxc_ast::ast::*;
use oxc_span::GetSpan;

use crate::chunk::{Chunk, Op, UpvalDesc};
use crate::value::{Closure, FuncProto, Value};

type CResult<T> = Result<T, String>;

fn unsupported<T>(what: &str, span: oxc_span::Span) -> CResult<T> {
    Err(format!(
        "compile error: unsupported construct: {what} (at byte offset {})",
        span.start
    ))
}

#[derive(Clone, Copy)]
struct SlotInfo {
    slot: u32,
    is_cell: bool,
}

#[derive(Default)]
struct LoopCtx {
    breaks: Vec<usize>,
    continues: Vec<usize>,
}

struct FnState {
    name: Option<String>,
    arity: usize,
    scopes: Vec<HashMap<String, SlotInfo>>,
    next_slot: u32,
    upvals: Vec<UpvalDesc>,
    upval_names: Vec<String>,
    captured: HashSet<String>,
    chunk: Chunk,
    loops: Vec<LoopCtx>,
}

impl FnState {
    fn new(name: Option<String>, captured: HashSet<String>) -> Self {
        FnState {
            name,
            arity: 0,
            scopes: vec![HashMap::new()],
            next_slot: 0,
            upvals: Vec::new(),
            upval_names: Vec::new(),
            captured,
            chunk: Chunk::new(),
            loops: Vec::new(),
        }
    }
}

pub struct Compiler {
    fns: Vec<FnState>,
    /// REPL mode: the value of the last expression statement is returned.
    repl: bool,
}

pub fn compile_program(prog: &Program, repl: bool) -> CResult<Arc<Closure>> {
    let mut c = Compiler {
        fns: Vec::new(),
        repl,
    };
    c.compile_main(prog)
}

impl Compiler {
    fn cur(&mut self) -> &mut FnState {
        self.fns.last_mut().expect("no function being compiled")
    }

    fn emit(&mut self, op: Op) -> usize {
        let f = self.cur();
        f.chunk.code.push(op);
        f.chunk.code.len() - 1
    }

    fn patch_jump(&mut self, at: usize, target: usize) {
        let op = &mut self.cur().chunk.code[at];
        match op {
            Op::Jump(t) | Op::JumpIfFalse(t) | Op::JumpIfTrue(t) | Op::JumpIfNotNullish(t) => {
                *t = target as u32;
            }
            _ => panic!("patch_jump on non-jump op"),
        }
    }

    fn here(&self) -> usize {
        self.fns.last().unwrap().chunk.code.len()
    }

    fn add_const(&mut self, v: Value) -> u32 {
        self.cur().chunk.add_const(v)
    }

    fn name_const(&mut self, name: &str) -> u32 {
        self.cur().chunk.name_const(name)
    }

    /// True when compiling the top level of the script (declarations become
    /// globals so every green thread can see them).
    fn at_toplevel(&self) -> bool {
        self.fns.len() == 1
    }

    fn compile_main(&mut self, prog: &Program) -> CResult<Arc<Closure>> {
        self.fns.push(FnState::new(Some("main".into()), HashSet::new()));
        let n = prog.body.len();
        for (i, stmt) in prog.body.iter().enumerate() {
            let is_last = i + 1 == n;
            if self.repl && is_last {
                if let Statement::ExpressionStatement(es) = stmt {
                    self.compile_expr(&es.expression)?;
                    let state = self.fns.pop().unwrap();
                    let proto = Arc::new(FuncProto {
                        name: state.name,
                        arity: 0,
                        nslots: state.next_slot as usize,
                        chunk: state.chunk,
                    });
                    return Ok(Arc::new(Closure {
                        proto,
                        upvalues: vec![],
                    }));
                }
            }
            self.compile_stmt(stmt)?;
        }
        self.emit(Op::Undefined);
        self.emit(Op::Return);
        let state = self.fns.pop().unwrap();
        let proto = Arc::new(FuncProto {
            name: state.name,
            arity: 0,
            nslots: state.next_slot as usize,
            chunk: state.chunk,
        });
        Ok(Arc::new(Closure {
            proto,
            upvalues: vec![],
        }))
    }

    // ----- scope & name resolution -----

    fn begin_scope(&mut self) {
        self.cur().scopes.push(HashMap::new());
    }

    fn end_scope(&mut self) {
        self.cur().scopes.pop();
    }

    fn declare_local(&mut self, name: &str) -> u32 {
        let is_cell = self.fns.last().unwrap().captured.contains(name);
        let slot = self.cur().next_slot;
        self.cur().next_slot += 1;
        self.cur()
            .scopes
            .last_mut()
            .unwrap()
            .insert(name.to_string(), SlotInfo { slot, is_cell });
        slot
    }

    fn resolve_local_at(&self, depth: usize, name: &str) -> Option<SlotInfo> {
        for scope in self.fns[depth].scopes.iter().rev() {
            if let Some(si) = scope.get(name) {
                return Some(*si);
            }
        }
        None
    }

    fn resolve_upval(&mut self, depth: usize, name: &str) -> Option<u32> {
        if depth == 0 {
            return None;
        }
        if let Some(i) = self.fns[depth].upval_names.iter().position(|n| n == name) {
            return Some(i as u32);
        }
        let desc = if let Some(si) = self.resolve_local_at(depth - 1, name) {
            UpvalDesc::ParentLocal(si.slot)
        } else {
            UpvalDesc::ParentUpval(self.resolve_upval(depth - 1, name)?)
        };
        self.fns[depth].upvals.push(desc);
        self.fns[depth].upval_names.push(name.to_string());
        Some((self.fns[depth].upvals.len() - 1) as u32)
    }

    /// Emit a load of the named variable.
    fn compile_load(&mut self, name: &str) {
        let depth = self.fns.len() - 1;
        if let Some(si) = self.resolve_local_at(depth, name) {
            if si.is_cell {
                self.emit(Op::GetLocalCell(si.slot));
            } else {
                self.emit(Op::GetLocal(si.slot));
            }
        } else if let Some(i) = self.resolve_upval(depth, name) {
            self.emit(Op::GetUpval(i));
        } else {
            let idx = self.name_const(name);
            self.emit(Op::GetGlobal(idx));
        }
    }

    /// Emit a store of the value on top of stack into the named variable.
    fn compile_store(&mut self, name: &str) {
        let depth = self.fns.len() - 1;
        if let Some(si) = self.resolve_local_at(depth, name) {
            if si.is_cell {
                self.emit(Op::SetLocalCell(si.slot));
            } else {
                self.emit(Op::SetLocal(si.slot));
            }
        } else if let Some(i) = self.resolve_upval(depth, name) {
            self.emit(Op::SetUpval(i));
        } else {
            let idx = self.name_const(name);
            self.emit(Op::SetGlobal(idx));
        }
    }

    // ----- statements -----

    fn compile_stmt(&mut self, stmt: &Statement) -> CResult<()> {
        match stmt {
            Statement::ExpressionStatement(es) => {
                self.compile_expr(&es.expression)?;
                self.emit(Op::Pop);
            }
            Statement::VariableDeclaration(d) => self.compile_var_decl(d)?,
            Statement::FunctionDeclaration(f) => {
                let name = f
                    .id
                    .as_ref()
                    .map(|id| id.name.as_str().to_string())
                    .ok_or("compile error: function declaration needs a name")?;
                self.declare_binding(&name)?;
                self.compile_closure(f, Some(&name))?;
                self.store_binding(&name);
            }
            Statement::BlockStatement(b) => {
                self.begin_scope();
                for s in &b.body {
                    self.compile_stmt(s)?;
                }
                self.end_scope();
            }
            Statement::IfStatement(i) => {
                self.compile_expr(&i.test)?;
                let else_jump = self.emit(Op::JumpIfFalse(u32::MAX));
                self.compile_stmt(&i.consequent)?;
                if let Some(alt) = &i.alternate {
                    let end_jump = self.emit(Op::Jump(u32::MAX));
                    self.patch_jump(else_jump, self.here());
                    self.compile_stmt(alt)?;
                    self.patch_jump(end_jump, self.here());
                } else {
                    self.patch_jump(else_jump, self.here());
                }
            }
            Statement::WhileStatement(w) => {
                let start = self.here();
                self.compile_expr(&w.test)?;
                let exit = self.emit(Op::JumpIfFalse(u32::MAX));
                self.cur().loops.push(LoopCtx::default());
                self.compile_stmt(&w.body)?;
                self.emit(Op::Jump(start as u32));
                let end = self.here();
                self.patch_jump(exit, end);
                let lc = self.cur().loops.pop().unwrap();
                for b in lc.breaks {
                    self.patch_jump(b, end);
                }
                for c in lc.continues {
                    self.patch_jump(c, start);
                }
            }
            Statement::ForStatement(f) => {
                self.begin_scope();
                if let Some(init) = &f.init {
                    match init {
                        ForStatementInit::VariableDeclaration(d) => self.compile_var_decl(d)?,
                        other => {
                            let e = other.as_expression().ok_or(
                                "compile error: unsupported for-loop initializer",
                            )?;
                            self.compile_expr(e)?;
                            self.emit(Op::Pop);
                        }
                    }
                }
                let test_at = self.here();
                let exit = if let Some(test) = &f.test {
                    self.compile_expr(test)?;
                    Some(self.emit(Op::JumpIfFalse(u32::MAX)))
                } else {
                    None
                };
                self.cur().loops.push(LoopCtx::default());
                self.compile_stmt(&f.body)?;
                let update_at = self.here();
                if let Some(update) = &f.update {
                    self.compile_expr(update)?;
                    self.emit(Op::Pop);
                }
                self.emit(Op::Jump(test_at as u32));
                let end = self.here();
                if let Some(exit) = exit {
                    self.patch_jump(exit, end);
                }
                let lc = self.cur().loops.pop().unwrap();
                for b in lc.breaks {
                    self.patch_jump(b, end);
                }
                for c in lc.continues {
                    self.patch_jump(c, update_at);
                }
                self.end_scope();
            }
            Statement::ReturnStatement(r) => {
                if self.at_toplevel() {
                    return Err("compile error: return outside function".into());
                }
                match &r.argument {
                    Some(e) => self.compile_expr(e)?,
                    None => {
                        self.emit(Op::Undefined);
                    }
                }
                self.emit(Op::Return);
            }
            Statement::BreakStatement(_) => {
                if self.fns.last().unwrap().loops.is_empty() {
                    return Err("compile error: break outside loop".into());
                }
                let at = self.emit(Op::Jump(u32::MAX));
                self.cur().loops.last_mut().unwrap().breaks.push(at);
            }
            Statement::ContinueStatement(_) => {
                if self.fns.last().unwrap().loops.is_empty() {
                    return Err("compile error: continue outside loop".into());
                }
                let at = self.emit(Op::Jump(u32::MAX));
                self.cur().loops.last_mut().unwrap().continues.push(at);
            }
            Statement::EmptyStatement(_) => {}
            Statement::DoWhileStatement(s) => return unsupported("do-while loops", s.span),
            Statement::ForInStatement(s) => return unsupported("for-in loops", s.span),
            Statement::ForOfStatement(s) => return unsupported("for-of loops", s.span),
            Statement::SwitchStatement(s) => return unsupported("switch statements", s.span),
            Statement::TryStatement(s) => return unsupported("try/catch", s.span),
            Statement::ThrowStatement(s) => return unsupported("throw", s.span),
            Statement::ClassDeclaration(s) => return unsupported("classes", s.span),
            Statement::LabeledStatement(s) => return unsupported("labeled statements", s.span),
            Statement::WithStatement(s) => return unsupported("with statements", s.span),
            other => return unsupported("this statement kind", other.span()),
        }
        Ok(())
    }

    /// Declare a binding for a declaration statement. At top level this is a
    /// global; inside a function it is a local slot (cell-boxed if captured).
    fn declare_binding(&mut self, name: &str) -> CResult<()> {
        if self.at_toplevel() {
            Ok(()) // globals need no declaration
        } else {
            let slot = self.declare_local(name);
            let is_cell = self.fns.last().unwrap().captured.contains(name);
            if is_cell {
                // Box the slot *before* any closure can capture it.
                self.emit(Op::Undefined);
                self.emit(Op::SetLocal(slot));
                self.emit(Op::MakeCell(slot));
            }
            Ok(())
        }
    }

    /// Store the value on top of stack into a previously declared binding.
    fn store_binding(&mut self, name: &str) {
        if self.at_toplevel() {
            let idx = self.name_const(name);
            self.emit(Op::SetGlobal(idx));
        } else {
            self.compile_store(name);
        }
    }

    fn compile_var_decl(&mut self, d: &VariableDeclaration) -> CResult<()> {
        for decl in &d.declarations {
            let name = match &decl.id {
                BindingPattern::BindingIdentifier(id) => id.name.as_str().to_string(),
                BindingPattern::ObjectPattern(p) => {
                    return unsupported("object destructuring", p.span)
                }
                BindingPattern::ArrayPattern(p) => {
                    return unsupported("array destructuring", p.span)
                }
                BindingPattern::AssignmentPattern(p) => {
                    return unsupported("default patterns", p.span)
                }
            };
            self.declare_binding(&name)?;
            match &decl.init {
                Some(e) => self.compile_expr(e)?,
                None => {
                    self.emit(Op::Undefined);
                }
            }
            self.store_binding(&name);
        }
        Ok(())
    }

    // ----- functions / closures -----

    fn compile_closure(&mut self, f: &Function, name: Option<&str>) -> CResult<()> {
        if f.r#async {
            return unsupported("async functions (use sleep/spawn/channel natives)", f.span);
        }
        if f.generator {
            return unsupported("generator functions", f.span);
        }
        let body = f
            .body
            .as_ref()
            .ok_or("compile error: function without body")?;

        // Capture analysis: names declared here that some nested function
        // references become cells.
        let mut declared: HashSet<String> = HashSet::new();
        for p in &f.params.items {
            binding_names(&p.pattern, &mut declared)?;
        }
        if let Some(rest) = &f.params.rest {
            return unsupported("rest parameters", rest.span);
        }
        collect_decls(&body.statements, &mut declared)?;
        let mut captured = HashSet::new();
        collect_captures_stmts(&body.statements, &declared, &mut captured);

        let fname = name.map(|s| s.to_string()).or_else(|| {
            f.id.as_ref().map(|id| id.name.as_str().to_string())
        });
        self.fns.push(FnState::new(fname.clone(), captured));

        // Parameters occupy slots 0..arity.
        let mut arity = 0;
        for p in &f.params.items {
            let pname = match &p.pattern {
                BindingPattern::BindingIdentifier(id) => id.name.as_str().to_string(),
                _ => return unsupported("destructured parameters", p.pattern.span()),
            };
            let slot = self.declare_local(&pname);
            if self.fns.last().unwrap().captured.contains(&pname) {
                self.emit(Op::MakeCell(slot));
            }
            arity += 1;
        }
        self.cur().arity = arity;

        for s in &body.statements {
            self.compile_stmt(s)?;
        }
        self.emit(Op::Undefined);
        self.emit(Op::Return);

        let state = self.fns.pop().unwrap();
        let proto = Arc::new(FuncProto {
            name: fname,
            arity,
            nslots: state.next_slot as usize,
            chunk: state.chunk,
        });
        let idx = self.add_const(Value::Function(Arc::new(Closure {
            proto,
            upvalues: vec![],
        })));
        self.emit(Op::Closure(idx, state.upvals.into_boxed_slice()));
        Ok(())
    }

    // ----- expressions -----

    fn compile_expr(&mut self, e: &Expression) -> CResult<()> {
        match e {
            Expression::NumericLiteral(n) => {
                let i = self.add_const(Value::Number(n.value));
                self.emit(Op::Const(i));
            }
            Expression::StringLiteral(s) => {
                let i = self.add_const(Value::str(s.value.as_str()));
                self.emit(Op::Const(i));
            }
            Expression::BooleanLiteral(b) => {
                self.emit(if b.value { Op::True } else { Op::False });
            }
            Expression::NullLiteral(_) => {
                self.emit(Op::Null);
            }
            Expression::Identifier(id) => self.compile_load(id.name.as_str()),
            Expression::ThisExpression(_) => {
                self.emit(Op::This);
            }
            Expression::ParenthesizedExpression(p) => self.compile_expr(&p.expression)?,
            Expression::BinaryExpression(b) => self.compile_binary(b)?,
            Expression::LogicalExpression(l) => self.compile_logical(l)?,
            Expression::UnaryExpression(u) => match u.operator {
                UnaryOperator::UnaryNegation => {
                    self.compile_expr(&u.argument)?;
                    self.emit(Op::Neg);
                }
                UnaryOperator::LogicalNot => {
                    self.compile_expr(&u.argument)?;
                    self.emit(Op::Not);
                }
                UnaryOperator::UnaryPlus => {
                    self.compile_expr(&u.argument)?;
                }
                UnaryOperator::Void => {
                    self.compile_expr(&u.argument)?;
                    self.emit(Op::Pop);
                    self.emit(Op::Undefined);
                }
                _ => return unsupported("this unary operator (typeof/delete/~)", u.span),
            },
            Expression::UpdateExpression(u) => self.compile_update(u)?,
            Expression::AssignmentExpression(a) => self.compile_assignment(a)?,
            Expression::ConditionalExpression(c) => {
                self.compile_expr(&c.test)?;
                let else_jump = self.emit(Op::JumpIfFalse(u32::MAX));
                self.compile_expr(&c.consequent)?;
                let end_jump = self.emit(Op::Jump(u32::MAX));
                self.patch_jump(else_jump, self.here());
                self.compile_expr(&c.alternate)?;
                self.patch_jump(end_jump, self.here());
            }
            Expression::SequenceExpression(s) => {
                for (i, e) in s.expressions.iter().enumerate() {
                    self.compile_expr(e)?;
                    if i + 1 < s.expressions.len() {
                        self.emit(Op::Pop);
                    }
                }
            }
            Expression::CallExpression(c) => self.compile_call(c)?,
            Expression::FunctionExpression(f) => self.compile_closure(f, None)?,
            Expression::ObjectExpression(o) => self.compile_object(o)?,
            Expression::ArrayExpression(a) => self.compile_array(a)?,
            Expression::StaticMemberExpression(m) => {
                self.compile_expr(&m.object)?;
                let idx = self.name_const(m.property.name.as_str());
                self.emit(Op::GetProp(idx));
            }
            Expression::ComputedMemberExpression(m) => {
                self.compile_expr(&m.object)?;
                self.compile_expr(&m.expression)?;
                self.emit(Op::GetIndex);
            }
            Expression::TemplateLiteral(t) => {
                // Desugar to string concatenation.
                let first = t
                    .quasis
                    .first()
                    .map(|q| template_cooked(q))
                    .unwrap_or_default();
                let i = self.add_const(Value::str(&first));
                self.emit(Op::Const(i));
                for (expr, quasi) in t.expressions.iter().zip(t.quasis.iter().skip(1)) {
                    self.compile_expr(expr)?;
                    self.emit(Op::Add);
                    let i = self.add_const(Value::str(&template_cooked(quasi)));
                    self.emit(Op::Const(i));
                    self.emit(Op::Add);
                }
            }
            Expression::ArrowFunctionExpression(a) => {
                return unsupported("arrow functions (use function expressions)", a.span)
            }
            Expression::ClassExpression(c) => return unsupported("classes", c.span),
            Expression::NewExpression(n) => return unsupported("new expressions", n.span),
            Expression::AwaitExpression(a) => {
                return unsupported("await (use join()/recv() natives)", a.span)
            }
            Expression::YieldExpression(y) => return unsupported("generators/yield", y.span),
            Expression::TaggedTemplateExpression(t) => {
                return unsupported("tagged templates", t.span)
            }
            Expression::ChainExpression(c) => return unsupported("optional chaining (?.)", c.span),
            Expression::ImportExpression(i) => return unsupported("dynamic import", i.span),
            Expression::BigIntLiteral(b) => return unsupported("BigInt", b.span),
            Expression::RegExpLiteral(r) => return unsupported("regular expressions", r.span),
            Expression::PrivateInExpression(p) => return unsupported("private fields", p.span),
            Expression::Super(s) => return unsupported("super", s.span),
            other => return unsupported("this expression kind", other.span()),
        }
        Ok(())
    }

    fn compile_binary(&mut self, b: &BinaryExpression) -> CResult<()> {
        use BinaryOperator::*;
        let op = match b.operator {
            Addition => Op::Add,
            Subtraction => Op::Sub,
            Multiplication => Op::Mul,
            Division => Op::Div,
            Remainder => Op::Rem,
            Equality => Op::Eq,
            Inequality => Op::Ne,
            StrictEquality => Op::Seq,
            StrictInequality => Op::Sne,
            LessThan => Op::Lt,
            LessEqualThan => Op::Le,
            GreaterThan => Op::Gt,
            GreaterEqualThan => Op::Ge,
            Exponential => return unsupported("** operator (use Math.pow)", b.span),
            _ => return unsupported("bitwise/shift/in/instanceof operators", b.span),
        };
        self.compile_expr(&b.left)?;
        self.compile_expr(&b.right)?;
        self.emit(op);
        Ok(())
    }

    fn compile_logical(&mut self, l: &LogicalExpression) -> CResult<()> {
        self.compile_expr(&l.left)?;
        self.emit(Op::Dup);
        let jump = match l.operator {
            LogicalOperator::And => self.emit(Op::JumpIfFalse(u32::MAX)),
            LogicalOperator::Or => self.emit(Op::JumpIfTrue(u32::MAX)),
            LogicalOperator::Coalesce => self.emit(Op::JumpIfNotNullish(u32::MAX)),
        };
        self.emit(Op::Pop);
        self.compile_expr(&l.right)?;
        self.patch_jump(jump, self.here());
        Ok(())
    }

    fn compile_update(&mut self, u: &UpdateExpression) -> CResult<()> {
        let delta_op = match u.operator {
            UpdateOperator::Increment => Op::Add,
            UpdateOperator::Decrement => Op::Sub,
        };
        match &u.argument {
            SimpleAssignmentTarget::AssignmentTargetIdentifier(id) => {
                let name = id.name.as_str();
                self.compile_load(name);
                if u.prefix {
                    let one = self.add_const(Value::Number(1.0));
                    self.emit(Op::Const(one));
                    self.emit(delta_op);
                    self.emit(Op::Dup);
                    self.compile_store(name);
                } else {
                    self.emit(Op::Dup);
                    let one = self.add_const(Value::Number(1.0));
                    self.emit(Op::Const(one));
                    self.emit(delta_op);
                    self.compile_store(name);
                }
                Ok(())
            }
            other => unsupported("++/-- on member expressions", other.span()),
        }
    }

    fn compile_assignment(&mut self, a: &AssignmentExpression) -> CResult<()> {
        use AssignmentOperator::*;
        let arith = match a.operator {
            Assign => None,
            Addition => Some(Op::Add),
            Subtraction => Some(Op::Sub),
            Multiplication => Some(Op::Mul),
            Division => Some(Op::Div),
            Remainder => Some(Op::Rem),
            _ => return unsupported("this compound assignment operator", a.span),
        };
        match &a.left {
            AssignmentTarget::AssignmentTargetIdentifier(id) => {
                let name = id.name.as_str();
                if let Some(op) = arith {
                    self.compile_load(name);
                    self.compile_expr(&a.right)?;
                    self.emit(op);
                } else {
                    self.compile_expr(&a.right)?;
                }
                self.emit(Op::Dup);
                self.compile_store(name);
                Ok(())
            }
            AssignmentTarget::StaticMemberExpression(m) => {
                self.compile_expr(&m.object)?;
                let idx = self.name_const(m.property.name.as_str());
                if let Some(op) = arith {
                    self.emit(Op::Dup);
                    self.emit(Op::GetProp(idx));
                    self.compile_expr(&a.right)?;
                    self.emit(op);
                } else {
                    self.compile_expr(&a.right)?;
                }
                // SetProp leaves the assigned value on the stack.
                self.emit(Op::SetProp(idx));
                Ok(())
            }
            AssignmentTarget::ComputedMemberExpression(m) => {
                self.compile_expr(&m.object)?;
                self.compile_expr(&m.expression)?;
                if arith.is_some() {
                    // Would need to duplicate both obj and key; unsupported.
                    return unsupported("compound assignment on computed members", m.span);
                }
                self.compile_expr(&a.right)?;
                // SetIndex leaves the assigned value on the stack.
                self.emit(Op::SetIndex);
                Ok(())
            }
            other => unsupported("destructuring assignment", other.span()),
        }
    }

    fn compile_call(&mut self, c: &CallExpression) -> CResult<()> {
        if c.optional {
            return unsupported("optional calls (?.)", c.span);
        }
        let mut method = false;
        match &c.callee {
            Expression::StaticMemberExpression(m) => {
                self.compile_expr(&m.object)?;
                self.emit(Op::Dup);
                let idx = self.name_const(m.property.name.as_str());
                self.emit(Op::GetProp(idx));
                method = true;
            }
            Expression::ComputedMemberExpression(m) => {
                self.compile_expr(&m.object)?;
                self.emit(Op::Dup);
                self.compile_expr(&m.expression)?;
                self.emit(Op::GetIndex);
                method = true;
            }
            other => self.compile_expr(other)?,
        }
        let mut argc = 0u32;
        for a in &c.arguments {
            match a.as_expression() {
                Some(e) => self.compile_expr(e)?,
                None => return unsupported("spread arguments", a.span()),
            }
            argc += 1;
        }
        if method {
            self.emit(Op::CallMethod(argc));
        } else {
            self.emit(Op::Call(argc));
        }
        Ok(())
    }

    fn compile_object(&mut self, o: &ObjectExpression) -> CResult<()> {
        let mut n = 0u32;
        for prop in &o.properties {
            match prop {
                ObjectPropertyKind::ObjectProperty(p) => {
                    if p.computed {
                        return unsupported("computed object keys", p.span);
                    }
                    match p.kind {
                        PropertyKind::Init => {}
                        _ => return unsupported("getters/setters", p.span),
                    }
                    let key = match &p.key {
                        PropertyKey::StaticIdentifier(id) => id.name.as_str().to_string(),
                        PropertyKey::StringLiteral(s) => s.value.as_str().to_string(),
                        PropertyKey::NumericLiteral(n) => Value::fmt_number(n.value),
                        other => return unsupported("this object key kind", other.span()),
                    };
                    let idx = self.add_const(Value::str(&key));
                    self.emit(Op::Const(idx));
                    self.compile_expr(&p.value)?;
                    n += 1;
                }
                ObjectPropertyKind::SpreadProperty(s) => {
                    return unsupported("object spread", s.span)
                }
            }
        }
        self.emit(Op::NewObject(n));
        Ok(())
    }

    fn compile_array(&mut self, a: &ArrayExpression) -> CResult<()> {
        let mut n = 0u32;
        for el in &a.elements {
            match el.as_expression() {
                Some(e) => self.compile_expr(e)?,
                None => {
                    if matches!(el, ArrayExpressionElement::Elision(_)) {
                        self.emit(Op::Undefined);
                    } else {
                        return unsupported("array spread", el.span());
                    }
                }
            }
            n += 1;
        }
        self.emit(Op::NewArray(n));
        Ok(())
    }
}

fn template_cooked(q: &TemplateElement) -> String {
    q.value.cooked
        .as_ref()
        .map(|c| c.as_str().to_string())
        .unwrap_or_else(|| q.value.raw.as_str().to_string())
}

// ---------------------------------------------------------------------------
// Capture analysis
// ---------------------------------------------------------------------------

fn binding_names(p: &BindingPattern, out: &mut HashSet<String>) -> CResult<()> {
    match p {
        BindingPattern::BindingIdentifier(id) => {
            out.insert(id.name.as_str().to_string());
            Ok(())
        }
        BindingPattern::ObjectPattern(o) => unsupported("object destructuring", o.span),
        BindingPattern::ArrayPattern(a) => unsupported("array destructuring", a.span),
        BindingPattern::AssignmentPattern(a) => {
            unsupported("default parameter values", a.span)
        }
    }
}

/// Collect names declared (var/let/const/function) in a statement list,
/// recursing into blocks/loops but NOT into nested function bodies.
fn collect_decls(stmts: &[Statement], out: &mut HashSet<String>) -> CResult<()> {
    for s in stmts {
        match s {
            Statement::VariableDeclaration(d) => {
                for decl in &d.declarations {
                    binding_names(&decl.id, out)?;
                }
            }
            Statement::FunctionDeclaration(f) => {
                if let Some(id) = &f.id {
                    out.insert(id.name.as_str().to_string());
                }
            }
            Statement::BlockStatement(b) => collect_decls(&b.body, out)?,
            Statement::IfStatement(i) => {
                collect_decls(std::slice::from_ref(&i.consequent), out)?;
                if let Some(alt) = &i.alternate {
                    collect_decls(std::slice::from_ref(alt), out)?;
                }
            }
            Statement::WhileStatement(w) => {
                collect_decls(std::slice::from_ref(&w.body), out)?
            }
            Statement::DoWhileStatement(d) => {
                collect_decls(std::slice::from_ref(&d.body), out)?
            }
            Statement::ForStatement(f) => {
                if let Some(ForStatementInit::VariableDeclaration(d)) = &f.init {
                    for decl in &d.declarations {
                        binding_names(&decl.id, out)?;
                    }
                }
                collect_decls(std::slice::from_ref(&f.body), out)?;
            }
            Statement::LabeledStatement(l) => {
                collect_decls(std::slice::from_ref(&l.body), out)?
            }
            _ => {}
        }
    }
    Ok(())
}

/// Free variables of a function: identifiers referenced inside (including in
/// nested functions, transitively) that are not declared within it.
fn free_vars_fn(f: &Function) -> HashSet<String> {
    let mut bound: HashSet<String> = HashSet::new();
    for p in &f.params.items {
        let _ = binding_names(&p.pattern, &mut bound);
    }
    let mut free = HashSet::new();
    if let Some(body) = &f.body {
        let _ = collect_decls(&body.statements, &mut bound);
        fv_stmts(&body.statements, &bound, &mut free);
    }
    free
}

fn fv_stmts(stmts: &[Statement], bound: &HashSet<String>, free: &mut HashSet<String>) {
    for s in stmts {
        match s {
            Statement::ExpressionStatement(e) => fv_expr(&e.expression, bound, free),
            Statement::VariableDeclaration(d) => {
                for decl in &d.declarations {
                    if let Some(e) = &decl.init {
                        fv_expr(e, bound, free);
                    }
                }
            }
            Statement::FunctionDeclaration(f) => {
                for v in free_vars_fn(f) {
                    if !bound.contains(&v) {
                        free.insert(v);
                    }
                }
            }
            Statement::BlockStatement(b) => fv_stmts(&b.body, bound, free),
            Statement::IfStatement(i) => {
                fv_expr(&i.test, bound, free);
                fv_stmts(std::slice::from_ref(&i.consequent), bound, free);
                if let Some(alt) = &i.alternate {
                    fv_stmts(std::slice::from_ref(alt), bound, free);
                }
            }
            Statement::WhileStatement(w) => {
                fv_expr(&w.test, bound, free);
                fv_stmts(std::slice::from_ref(&w.body), bound, free);
            }
            Statement::DoWhileStatement(d) => {
                fv_expr(&d.test, bound, free);
                fv_stmts(std::slice::from_ref(&d.body), bound, free);
            }
            Statement::ForStatement(f) => {
                if let Some(init) = &f.init {
                    match init {
                        ForStatementInit::VariableDeclaration(d) => {
                            for decl in &d.declarations {
                                if let Some(e) = &decl.init {
                                    fv_expr(e, bound, free);
                                }
                            }
                        }
                        other => {
                            if let Some(e) = other.as_expression() {
                                fv_expr(e, bound, free);
                            }
                        }
                    }
                }
                if let Some(t) = &f.test {
                    fv_expr(t, bound, free);
                }
                if let Some(u) = &f.update {
                    fv_expr(u, bound, free);
                }
                fv_stmts(std::slice::from_ref(&f.body), bound, free);
            }
            Statement::ReturnStatement(r) => {
                if let Some(e) = &r.argument {
                    fv_expr(e, bound, free);
                }
            }
            _ => {}
        }
    }
}

fn fv_exprs<'a, I: IntoIterator<Item = &'a Expression<'a>>>(
    exprs: I,
    bound: &HashSet<String>,
    free: &mut HashSet<String>,
) {
    for e in exprs {
        fv_expr(e, bound, free);
    }
}

fn fv_member(m: &MemberExpression, bound: &HashSet<String>, free: &mut HashSet<String>) {
    match m {
        MemberExpression::StaticMemberExpression(s) => fv_expr(&s.object, bound, free),
        MemberExpression::ComputedMemberExpression(c) => {
            fv_expr(&c.object, bound, free);
            fv_expr(&c.expression, bound, free);
        }
        MemberExpression::PrivateFieldExpression(p) => fv_expr(&p.object, bound, free),
    }
}

fn fv_expr(e: &Expression, bound: &HashSet<String>, free: &mut HashSet<String>) {
    match e {
        Expression::Identifier(id) => {
            let name = id.name.as_str();
            if !bound.contains(name) {
                free.insert(name.to_string());
            }
        }
        Expression::FunctionExpression(f) => {
            for v in free_vars_fn(f) {
                if !bound.contains(&v) {
                    free.insert(v);
                }
            }
        }
        Expression::ParenthesizedExpression(p) => fv_expr(&p.expression, bound, free),
        Expression::BinaryExpression(b) => {
            fv_expr(&b.left, bound, free);
            fv_expr(&b.right, bound, free);
        }
        Expression::LogicalExpression(l) => {
            fv_expr(&l.left, bound, free);
            fv_expr(&l.right, bound, free);
        }
        Expression::UnaryExpression(u) => fv_expr(&u.argument, bound, free),
        Expression::UpdateExpression(u) => fv_assign_target(&u.argument, bound, free),
        Expression::AssignmentExpression(a) => {
            fv_target(&a.left, bound, free);
            fv_expr(&a.right, bound, free);
        }
        Expression::ConditionalExpression(c) => {
            fv_expr(&c.test, bound, free);
            fv_expr(&c.consequent, bound, free);
            fv_expr(&c.alternate, bound, free);
        }
        Expression::SequenceExpression(s) => fv_exprs(&s.expressions, bound, free),
        Expression::CallExpression(c) => {
            fv_expr(&c.callee, bound, free);
            for a in &c.arguments {
                if let Some(e) = a.as_expression() {
                    fv_expr(e, bound, free);
                }
            }
        }
        Expression::NewExpression(n) => {
            fv_expr(&n.callee, bound, free);
            for a in &n.arguments {
                if let Some(e) = a.as_expression() {
                    fv_expr(e, bound, free);
                }
            }
        }
        Expression::ObjectExpression(o) => {
            for p in &o.properties {
                if let ObjectPropertyKind::ObjectProperty(p) = p {
                    fv_expr(&p.value, bound, free);
                }
            }
        }
        Expression::ArrayExpression(a) => {
            for el in &a.elements {
                if let Some(e) = el.as_expression() {
                    fv_expr(e, bound, free);
                }
            }
        }
        Expression::TemplateLiteral(t) => fv_exprs(&t.expressions, bound, free),
        Expression::TaggedTemplateExpression(t) => {
            fv_expr(&t.tag, bound, free);
            fv_exprs(&t.quasi.expressions, bound, free);
        }
        Expression::ArrowFunctionExpression(a) => {
            // Not supported by the compiler; walk the body anyway for
            // analysis completeness.
            let mut inner = bound.clone();
            for p in &a.params.items {
                let _ = binding_names(&p.pattern, &mut inner);
            }
            match &a.body {
                ArrowFunctionBody::FunctionBody(b) => {
                    let _ = collect_decls(&b.statements, &mut inner);
                    fv_stmts(&b.statements, &inner, free);
                }
                other => {
                    if let Some(e) = other.as_expression() {
                        fv_expr(e, &inner, free);
                    }
                }
            }
        }
        other => {
            if let Some(m) = other.as_member_expression() {
                fv_member(m, bound, free);
            }
        }
    }
}

fn fv_assign_target(t: &SimpleAssignmentTarget, bound: &HashSet<String>, free: &mut HashSet<String>) {
    match t {
        SimpleAssignmentTarget::AssignmentTargetIdentifier(id) => {
            let name = id.name.as_str();
            if !bound.contains(name) {
                free.insert(name.to_string());
            }
        }
        other => {
            if let Some(m) = other.as_member_expression() {
                fv_member(m, bound, free);
            }
        }
    }
}

fn fv_target(t: &AssignmentTarget, bound: &HashSet<String>, free: &mut HashSet<String>) {
    match t {
        AssignmentTarget::AssignmentTargetIdentifier(id) => {
            let name = id.name.as_str();
            if !bound.contains(name) {
                free.insert(name.to_string());
            }
        }
        other => {
            if let Some(m) = other.as_member_expression() {
                fv_member(m, bound, free);
            }
        }
    }
}

/// Names declared in this function (`declared`) that are captured by
/// directly nested functions (transitively covering deeper nestings).
fn collect_captures_stmts(
    stmts: &[Statement],
    declared: &HashSet<String>,
    out: &mut HashSet<String>,
) {
    for s in stmts {
        match s {
            Statement::FunctionDeclaration(f) => {
                out.extend(free_vars_fn(f).into_iter().filter(|v| declared.contains(v)));
            }
            Statement::ExpressionStatement(e) => collect_captures_expr(&e.expression, declared, out),
            Statement::VariableDeclaration(d) => {
                for decl in &d.declarations {
                    if let Some(e) = &decl.init {
                        collect_captures_expr(e, declared, out);
                    }
                }
            }
            Statement::BlockStatement(b) => collect_captures_stmts(&b.body, declared, out),
            Statement::IfStatement(i) => {
                collect_captures_expr(&i.test, declared, out);
                collect_captures_stmts(std::slice::from_ref(&i.consequent), declared, out);
                if let Some(alt) = &i.alternate {
                    collect_captures_stmts(std::slice::from_ref(alt), declared, out);
                }
            }
            Statement::WhileStatement(w) => {
                collect_captures_expr(&w.test, declared, out);
                collect_captures_stmts(std::slice::from_ref(&w.body), declared, out);
            }
            Statement::DoWhileStatement(d) => {
                collect_captures_expr(&d.test, declared, out);
                collect_captures_stmts(std::slice::from_ref(&d.body), declared, out);
            }
            Statement::ForStatement(f) => {
                if let Some(init) = &f.init {
                    match init {
                        ForStatementInit::VariableDeclaration(d) => {
                            for decl in &d.declarations {
                                if let Some(e) = &decl.init {
                                    collect_captures_expr(e, declared, out);
                                }
                            }
                        }
                        other => {
                            if let Some(e) = other.as_expression() {
                                collect_captures_expr(e, declared, out);
                            }
                        }
                    }
                }
                if let Some(t) = &f.test {
                    collect_captures_expr(t, declared, out);
                }
                if let Some(u) = &f.update {
                    collect_captures_expr(u, declared, out);
                }
                collect_captures_stmts(std::slice::from_ref(&f.body), declared, out);
            }
            Statement::ReturnStatement(r) => {
                if let Some(e) = &r.argument {
                    collect_captures_expr(e, declared, out);
                }
            }
            _ => {}
        }
    }
}

fn collect_captures_expr(e: &Expression, declared: &HashSet<String>, out: &mut HashSet<String>) {
    // Reuse the free-var walker, but keep only names declared here, by
    // treating `declared` as the bound set inversely: we walk with an empty
    // bound set and filter. Simpler: walk expressions and whenever we hit a
    // nested function, take its free vars intersected with `declared`.
    match e {
        Expression::FunctionExpression(f) => {
            out.extend(free_vars_fn(f).into_iter().filter(|v| declared.contains(v)));
        }
        Expression::ParenthesizedExpression(p) => {
            collect_captures_expr(&p.expression, declared, out)
        }
        Expression::BinaryExpression(b) => {
            collect_captures_expr(&b.left, declared, out);
            collect_captures_expr(&b.right, declared, out);
        }
        Expression::LogicalExpression(l) => {
            collect_captures_expr(&l.left, declared, out);
            collect_captures_expr(&l.right, declared, out);
        }
        Expression::UnaryExpression(u) => collect_captures_expr(&u.argument, declared, out),
        Expression::UpdateExpression(u) => {
            if let Some(m) = u.argument.as_member_expression() {
                match m {
                    MemberExpression::StaticMemberExpression(s) => {
                        collect_captures_expr(&s.object, declared, out)
                    }
                    MemberExpression::ComputedMemberExpression(c) => {
                        collect_captures_expr(&c.object, declared, out);
                        collect_captures_expr(&c.expression, declared, out);
                    }
                    _ => {}
                }
            }
        }
        Expression::AssignmentExpression(a) => {
            if let Some(m) = a.left.as_member_expression() {
                match m {
                    MemberExpression::StaticMemberExpression(s) => {
                        collect_captures_expr(&s.object, declared, out)
                    }
                    MemberExpression::ComputedMemberExpression(c) => {
                        collect_captures_expr(&c.object, declared, out);
                        collect_captures_expr(&c.expression, declared, out);
                    }
                    _ => {}
                }
            }
            collect_captures_expr(&a.right, declared, out);
        }
        Expression::ConditionalExpression(c) => {
            collect_captures_expr(&c.test, declared, out);
            collect_captures_expr(&c.consequent, declared, out);
            collect_captures_expr(&c.alternate, declared, out);
        }
        Expression::SequenceExpression(s) => {
            for e in &s.expressions {
                collect_captures_expr(e, declared, out);
            }
        }
        Expression::CallExpression(c) => {
            collect_captures_expr(&c.callee, declared, out);
            for a in &c.arguments {
                if let Some(e) = a.as_expression() {
                    collect_captures_expr(e, declared, out);
                }
            }
        }
        Expression::ObjectExpression(o) => {
            for p in &o.properties {
                if let ObjectPropertyKind::ObjectProperty(p) = p {
                    collect_captures_expr(&p.value, declared, out);
                }
            }
        }
        Expression::ArrayExpression(a) => {
            for el in &a.elements {
                if let Some(e) = el.as_expression() {
                    collect_captures_expr(e, declared, out);
                }
            }
        }
        Expression::TemplateLiteral(t) => {
            for e in &t.expressions {
                collect_captures_expr(e, declared, out);
            }
        }
        other => {
            if let Some(m) = other.as_member_expression() {
                match m {
                    MemberExpression::StaticMemberExpression(s) => {
                        collect_captures_expr(&s.object, declared, out)
                    }
                    MemberExpression::ComputedMemberExpression(c) => {
                        collect_captures_expr(&c.object, declared, out);
                        collect_captures_expr(&c.expression, declared, out);
                    }
                    _ => {}
                }
            }
        }
    }
}
