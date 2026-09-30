//! Core value representation for the engine.
//!
//! NOTE: the original design called for `Rc<RefCell<..>>` values. We use
//! `Arc<Mutex<..>>` instead so that `Value` is `Send + Sync`, which is what
//! allows green-thread tasks (and the values they share: closures, channels,
//! objects) to move freely across the tokio multi-thread runtime.

use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use crate::chunk::Chunk;
use crate::vm::Vm;

/// A compiled function prototype (bytecode + metadata), shared by closures.
pub struct FuncProto {
    pub name: Option<String>,
    pub arity: usize,
    /// Number of local slots (params + declared locals).
    pub nslots: usize,
    pub chunk: Chunk,
}

/// A callable JS function: a prototype plus captured upvalue cells.
pub struct Closure {
    pub proto: Arc<FuncProto>,
    pub upvalues: Vec<Arc<Mutex<Value>>>,
}

pub type BoxSuspend = Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'static>>;

/// What a native function returns: either a plain value, or a future the VM
/// must await (suspending the current green thread) before resuming.
pub enum NativeResult {
    Value(Value),
    Suspend(BoxSuspend),
}

pub type NativeCallback =
    dyn Fn(&mut Vm, &Value, &[Value]) -> Result<NativeResult, String> + Send + Sync;

pub struct NativeFn {
    pub name: String,
    pub func: Arc<NativeCallback>,
}

impl NativeFn {
    pub fn new(
        name: &str,
        func: impl Fn(&mut Vm, &Value, &[Value]) -> Result<NativeResult, String>
            + Send
            + Sync
            + 'static,
    ) -> Value {
        Value::Native(Arc::new(NativeFn {
            name: name.to_string(),
            func: Arc::new(func),
        }))
    }
}

#[derive(Default)]
pub struct Object {
    pub props: HashMap<String, Value>,
}

pub type TaskHandle = Arc<Mutex<Option<tokio::task::JoinHandle<Result<Value, String>>>>>;

#[derive(Clone)]
pub enum Value {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    String(Arc<str>),
    Array(Arc<Mutex<Vec<Value>>>),
    Object(Arc<Mutex<Object>>),
    Function(Arc<Closure>),
    Native(Arc<NativeFn>),
    /// Handle to a spawned green thread (see `spawn`/`join` builtins).
    Task(TaskHandle),
    /// Internal only: a captured local variable cell. Never observed by user
    /// code — `GetLocalCell`/`GetUpvalue` always dereference before pushing.
    Cell(Arc<Mutex<Value>>),
}

impl Value {
    pub fn str(s: &str) -> Value {
        Value::String(Arc::from(s))
    }

    pub fn type_name(&self) -> &'static str {
        match self {
            Value::Undefined => "undefined",
            Value::Null => "object",
            Value::Bool(_) => "boolean",
            Value::Number(_) => "number",
            Value::String(_) => "string",
            Value::Array(_) => "object",
            Value::Object(_) => "object",
            Value::Function(_) | Value::Native(_) => "function",
            Value::Task(_) => "object",
            Value::Cell(_) => "internal",
        }
    }

    pub fn is_truthy(&self) -> bool {
        match self {
            Value::Undefined | Value::Null => false,
            Value::Bool(b) => *b,
            Value::Number(n) => *n != 0.0 && !n.is_nan(),
            Value::String(s) => !s.is_empty(),
            _ => true,
        }
    }

    pub fn to_number(&self) -> f64 {
        match self {
            Value::Undefined => f64::NAN,
            Value::Null => 0.0,
            Value::Bool(b) => {
                if *b {
                    1.0
                } else {
                    0.0
                }
            }
            Value::Number(n) => *n,
            Value::String(s) => {
                let t = s.trim();
                if t.is_empty() {
                    0.0
                } else {
                    t.parse::<f64>().unwrap_or(f64::NAN)
                }
            }
            _ => f64::NAN,
        }
    }

    /// Format a number the way JS `String(n)` would (integers without `.0`).
    pub fn fmt_number(n: f64) -> String {
        if n.is_nan() {
            "NaN".to_string()
        } else if n == f64::INFINITY {
            "Infinity".to_string()
        } else if n == f64::NEG_INFINITY {
            "-Infinity".to_string()
        } else {
            format!("{n}")
        }
    }

    pub fn to_display(&self) -> String {
        match self {
            Value::Undefined => "undefined".to_string(),
            Value::Null => "null".to_string(),
            Value::Bool(b) => b.to_string(),
            Value::Number(n) => Value::fmt_number(*n),
            Value::String(s) => s.to_string(),
            Value::Array(arr) => {
                let arr = arr.lock().unwrap();
                arr.iter()
                    .map(|v| match v {
                        Value::Undefined | Value::Null => String::new(),
                        other => other.to_display(),
                    })
                    .collect::<Vec<_>>()
                    .join(",")
            }
            Value::Object(_) => "[object Object]".to_string(),
            Value::Function(c) => match &c.proto.name {
                Some(n) => format!("function {n}() {{ [bytecode] }}"),
                None => "function () { [bytecode] }".to_string(),
            },
            Value::Native(n) => format!("function {}() {{ [native code] }}", n.name),
            Value::Task(_) => "[object Task]".to_string(),
            Value::Cell(c) => c.lock().unwrap().to_display(),
        }
    }

    /// Strict equality (`===`).
    pub fn strict_eq(&self, other: &Value) -> bool {
        match (self, other) {
            (Value::Undefined, Value::Undefined) => true,
            (Value::Null, Value::Null) => true,
            (Value::Bool(a), Value::Bool(b)) => a == b,
            (Value::Number(a), Value::Number(b)) => a == b, // NaN !== NaN
            (Value::String(a), Value::String(b)) => a == b,
            (Value::Array(a), Value::Array(b)) => Arc::ptr_eq(a, b),
            (Value::Object(a), Value::Object(b)) => Arc::ptr_eq(a, b),
            (Value::Function(a), Value::Function(b)) => Arc::ptr_eq(a, b),
            (Value::Native(a), Value::Native(b)) => Arc::ptr_eq(a, b),
            _ => false,
        }
    }

    /// Loose equality (`==`). Simplified: no ToPrimitive on objects.
    pub fn loose_eq(&self, other: &Value) -> bool {
        match (self, other) {
            (Value::Undefined, Value::Null) | (Value::Null, Value::Undefined) => true,
            (Value::Number(a), Value::String(_)) => *a == other.to_number(),
            (Value::String(_), Value::Number(b)) => self.to_number() == *b,
            (Value::Bool(_), _) => Value::Number(self.to_number()).loose_eq(other),
            (_, Value::Bool(_)) => self.loose_eq(&Value::Number(other.to_number())),
            _ => self.strict_eq(other),
        }
    }
}

impl fmt::Debug for Value {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.to_display())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truthiness() {
        assert!(!Value::Undefined.is_truthy());
        assert!(!Value::Null.is_truthy());
        assert!(!Value::Number(0.0).is_truthy());
        assert!(!Value::Number(f64::NAN).is_truthy());
        assert!(!Value::str("").is_truthy());
        assert!(Value::Number(-1.0).is_truthy());
        assert!(Value::str("x").is_truthy());
    }

    #[test]
    fn number_formatting() {
        assert_eq!(Value::fmt_number(3.0), "3");
        assert_eq!(Value::fmt_number(3.5), "3.5");
        assert_eq!(Value::fmt_number(f64::INFINITY), "Infinity");
        assert_eq!(Value::fmt_number(f64::NAN), "NaN");
    }

    #[test]
    fn equality() {
        assert!(Value::Null.loose_eq(&Value::Undefined));
        assert!(Value::Number(1.0).loose_eq(&Value::str("1")));
        assert!(!Value::Number(1.0).strict_eq(&Value::str("1")));
        assert!(!Value::Number(f64::NAN).strict_eq(&Value::Number(f64::NAN)));
    }
}
