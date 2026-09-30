//! Native builtins installed into the global scope.
//!
//! Synchronous: `print`, `Math.*`, array helpers.
//! Asynchronous (suspend the current green thread): `sleep`, channel
//! `send`/`recv`, `join`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::scheduler::{spawn_task, RuntimeCtx};
use crate::value::{NativeFn, NativeResult, Object, Value};

fn native(
    name: &str,
    f: impl Fn(&mut crate::vm::Vm, &Value, &[Value]) -> Result<NativeResult, String>
        + Send
        + Sync
        + 'static,
) -> Value {
    NativeFn::new(name, f)
}

fn arg(args: &[Value], i: usize) -> Value {
    args.get(i).cloned().unwrap_or(Value::Undefined)
}

pub fn install(ctx: &Arc<RuntimeCtx>) {
    let mut g = ctx.globals.write().unwrap();

    g.insert("print".into(), print_fn());
    g.insert("sleep".into(), sleep_fn());
    g.insert("spawn".into(), spawn_fn());
    g.insert("channel".into(), channel_fn());
    g.insert("join".into(), join_fn());
    g.insert("await_handle".into(), join_fn());
    g.insert("now".into(), now_fn());
    g.insert("Math".into(), math_object());
    g.insert("undefined".into(), Value::Undefined);
}

fn print_fn() -> Value {
    native("print", |_vm, _this, args| {
        let line = args
            .iter()
            .map(|v| v.to_display())
            .collect::<Vec<_>>()
            .join(" ");
        println!("{line}");
        Ok(NativeResult::Value(Value::Undefined))
    })
}

fn now_fn() -> Value {
    native("now", |_vm, _this, _args| {
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as f64)
            .unwrap_or(0.0);
        Ok(NativeResult::Value(Value::Number(ms)))
    })
}

fn sleep_fn() -> Value {
    native("sleep", |_vm, _this, args| {
        let ms = arg(args, 0).to_number();
        if ms.is_nan() || ms < 0.0 {
            return Err("sleep(ms): ms must be a non-negative number".into());
        }
        Ok(NativeResult::Suspend(Box::pin(async move {
            tokio::time::sleep(Duration::from_millis(ms as u64)).await;
            Ok(Value::Undefined)
        })))
    })
}

fn spawn_fn() -> Value {
    native("spawn", |vm, _this, args| {
        let f = match arg(args, 0) {
            Value::Function(c) => c,
            other => return Err(format!("spawn: expected a function, got {}", other.type_name())),
        };
        let fargs: Vec<Value> = args.iter().skip(1).cloned().collect();
        let jh = spawn_task(&vm.ctx, f, fargs);
        Ok(NativeResult::Value(Value::Task(Arc::new(Mutex::new(
            Some(jh),
        )))))
    })
}

fn join_fn() -> Value {
    native("join", |_vm, _this, args| {
        let handle = match arg(args, 0) {
            Value::Task(h) => h,
            other => return Err(format!("join: expected a task handle, got {}", other.type_name())),
        };
        let jh = handle.lock().unwrap().take();
        match jh {
            Some(jh) => Ok(NativeResult::Suspend(Box::pin(async move {
                match jh.await {
                    Ok(res) => res,
                    Err(e) => Err(format!("task panicked: {e}")),
                }
            }))),
            None => Err("join: task handle already joined".into()),
        }
    })
}

/// `channel()` -> `{ send, recv }` backed by a bounded tokio mpsc (cap 1),
/// so `send` suspends while the channel is full and `recv` suspends while
/// it is empty.
fn channel_fn() -> Value {
    native("channel", |_vm, _this, args| {
        let cap = {
            let c = arg(args, 0).to_number();
            if c.is_nan() || c < 1.0 { 1 } else { c as usize }
        };
        let (tx, rx) = tokio::sync::mpsc::channel::<Value>(cap);
        let rx = Arc::new(tokio::sync::Mutex::new(rx));

        let send_tx = tx.clone();
        let send = NativeFn::new("send", move |_vm, _this, args| {
            let v = arg(args, 0);
            let tx = send_tx.clone();
            Ok(NativeResult::Suspend(Box::pin(async move {
                tx.send(v)
                    .await
                    .map_err(|_| "send: channel closed".to_string())?;
                Ok(Value::Undefined)
            })))
        });

        let recv_rx = rx.clone();
        let recv = NativeFn::new("recv", move |_vm, _this, _args| {
            let rx = recv_rx.clone();
            Ok(NativeResult::Suspend(Box::pin(async move {
                rx.lock()
                    .await
                    .recv()
                    .await
                    .ok_or_else(|| "recv: channel closed".to_string())
            })))
        });

        let mut obj = Object::default();
        obj.props.insert("send".into(), send);
        obj.props.insert("recv".into(), recv);
        Ok(NativeResult::Value(Value::Object(Arc::new(Mutex::new(obj)))))
    })
}

fn math_object() -> Value {
    let mut obj = Object::default();
    let unary = |name: &'static str, f: fn(f64) -> f64| {
        native(name, move |_vm, _this, args| {
            Ok(NativeResult::Value(Value::Number(f(arg(args, 0).to_number()))))
        })
    };
    obj.props.insert("floor".into(), unary("floor", f64::floor));
    obj.props.insert("ceil".into(), unary("ceil", f64::ceil));
    obj.props.insert("round".into(), unary("round", f64::round));
    obj.props.insert("abs".into(), unary("abs", f64::abs));
    obj.props.insert("sqrt".into(), unary("sqrt", f64::sqrt));
    obj.props.insert(
        "pow".into(),
        native("pow", |_vm, _this, args| {
            Ok(NativeResult::Value(Value::Number(
                arg(args, 0).to_number().powf(arg(args, 1).to_number()),
            )))
        }),
    );
    obj.props.insert(
        "max".into(),
        native("max", |_vm, _this, args| {
            let m = args.iter().map(|v| v.to_number()).fold(f64::NEG_INFINITY, f64::max);
            Ok(NativeResult::Value(Value::Number(m)))
        }),
    );
    obj.props.insert(
        "min".into(),
        native("min", |_vm, _this, args| {
            let m = args.iter().map(|v| v.to_number()).fold(f64::INFINITY, f64::min);
            Ok(NativeResult::Value(Value::Number(m)))
        }),
    );
    obj.props.insert("PI".into(), Value::Number(std::f64::consts::PI));
    Value::Object(Arc::new(Mutex::new(obj)))
}

// --- Array methods (dispatched from `vm::get_prop` on `.push`/`.pop`/...) ---

pub fn array_push() -> Value {
    native("push", |_vm, this, args| {
        if let Value::Array(a) = this {
            let mut a = a.lock().unwrap();
            for v in args {
                a.push(v.clone());
            }
            Ok(NativeResult::Value(Value::Number(a.len() as f64)))
        } else {
            Err("push: receiver is not an array".into())
        }
    })
}

pub fn array_pop() -> Value {
    native("pop", |_vm, this, _args| {
        if let Value::Array(a) = this {
            Ok(NativeResult::Value(
                a.lock().unwrap().pop().unwrap_or(Value::Undefined),
            ))
        } else {
            Err("pop: receiver is not an array".into())
        }
    })
}

pub fn array_join() -> Value {
    native("join", |_vm, this, args| {
        if let Value::Array(a) = this {
            let sep = match arg(args, 0) {
                Value::Undefined => ",".to_string(),
                v => v.to_display(),
            };
            let a = a.lock().unwrap();
            let s = a
                .iter()
                .map(|v| match v {
                    Value::Undefined | Value::Null => String::new(),
                    other => other.to_display(),
                })
                .collect::<Vec<_>>()
                .join(&sep);
            Ok(NativeResult::Value(Value::str(&s)))
        } else {
            Err("join: receiver is not an array".into())
        }
    })
}

pub fn array_includes() -> Value {
    native("includes", |_vm, this, args| {
        if let Value::Array(a) = this {
            let needle = arg(args, 0);
            let found = a.lock().unwrap().iter().any(|v| v.strict_eq(&needle));
            Ok(NativeResult::Value(Value::Bool(found)))
        } else {
            Err("includes: receiver is not an array".into())
        }
    })
}
