//! End-to-end tests: parse -> compile -> run on the green-thread scheduler.

use std::sync::Arc;
use std::time::Instant;

use js_engine::scheduler::{run_main, RuntimeCtx};
use js_engine::value::Value;
use js_engine::compile_source;

fn run(src: &str) -> Result<Arc<RuntimeCtx>, String> {
    run_inner(src)
}

fn run_err(src: &str) -> String {
    match run_inner(src) {
        Ok(_) => panic!("expected runtime error, but script succeeded"),
        Err(e) => e,
    }
}

fn run_inner(src: &str) -> Result<Arc<RuntimeCtx>, String> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let ctx = RuntimeCtx::new();
        let main = compile_source(src, false).map_err(|e| e.to_string())?;
        run_main(ctx.clone(), main).await?;
        Ok(ctx)
    })
}

fn global(ctx: &Arc<RuntimeCtx>, name: &str) -> Value {
    ctx.globals
        .read()
        .unwrap()
        .get(name)
        .cloned()
        .unwrap_or(Value::Undefined)
}

fn num(ctx: &Arc<RuntimeCtx>, name: &str) -> f64 {
    match global(ctx, name) {
        Value::Number(n) => n,
        other => panic!("global {name} is not a number: {other:?}"),
    }
}

fn string(ctx: &Arc<RuntimeCtx>, name: &str) -> String {
    match global(ctx, name) {
        Value::String(s) => s.to_string(),
        other => panic!("global {name} is not a string: {other:?}"),
    }
}

fn assert_compile_error(src: &str, needle: &str) {
    match compile_source(src, false) {
        Err(e) => {
            let msg = e.to_string();
            assert!(
                msg.contains(needle),
                "expected error containing {needle:?}, got: {msg}"
            );
        }
        Ok(_) => panic!("expected compile error containing {needle:?}, but it compiled"),
    }
}

// ---------------------------------------------------------------- basics

#[test]
fn literals_and_arithmetic() {
    let ctx = run(
        r#"
        let a = 2 + 3 * 4;
        let b = (2 + 3) * 4;
        let c = 10 / 4;
        let d = 10 % 3;
        let e = -a + 1;
        let s = "foo" + "bar" + 42;
        let t = `x=${a}`;
        "#,
    )
    .unwrap();
    assert_eq!(num(&ctx, "a"), 14.0);
    assert_eq!(num(&ctx, "b"), 20.0);
    assert_eq!(num(&ctx, "c"), 2.5);
    assert_eq!(num(&ctx, "d"), 1.0);
    assert_eq!(num(&ctx, "e"), -13.0);
    assert_eq!(string(&ctx, "s"), "foobar42");
    assert_eq!(string(&ctx, "t"), "x=14");
}

#[test]
fn comparisons_and_logic() {
    let ctx = run(
        r#"
        let a = 1 < 2;
        let b = 2 <= 1;
        let c = "a" < "b";
        let d = 1 == "1";
        let e = 1 === "1";
        let f = null == undefined;
        let g = true && false || true;
        let h = 0 || "fallback";
        let i = null ?? 7;
        let j = !false;
        "#,
    )
    .unwrap();
    assert!(matches!(global(&ctx, "a"), Value::Bool(true)));
    assert!(matches!(global(&ctx, "b"), Value::Bool(false)));
    assert!(matches!(global(&ctx, "c"), Value::Bool(true)));
    assert!(matches!(global(&ctx, "d"), Value::Bool(true)));
    assert!(matches!(global(&ctx, "e"), Value::Bool(false)));
    assert!(matches!(global(&ctx, "f"), Value::Bool(true)));
    assert!(matches!(global(&ctx, "g"), Value::Bool(true)));
    assert_eq!(string(&ctx, "h"), "fallback");
    assert_eq!(num(&ctx, "i"), 7.0);
    assert!(matches!(global(&ctx, "j"), Value::Bool(true)));
}

#[test]
fn vars_and_control_flow() {
    let ctx = run(
        r#"
        let x = 0;
        if (1 + 1 == 2) { x = 10; } else { x = 20; }
        let i = 0;
        while (i < 5) { x = x + i; i++; }
        let sum = 0;
        for (let j = 0; j < 10; j++) {
            if (j == 4) { continue; }
            if (j == 8) { break; }
            sum += j;
        }
        var v = 1;
        const k = 2;
        "#,
    )
    .unwrap();
    assert_eq!(num(&ctx, "x"), 20.0); // 10 + 0+1+2+3+4
    assert_eq!(num(&ctx, "sum"), 24.0); // 0+1+2+3+5+6+7
    assert_eq!(num(&ctx, "v"), 1.0);
    assert_eq!(num(&ctx, "k"), 2.0);
}

// ------------------------------------------------------------- functions

#[test]
fn fib_recursion() {
    let ctx = run(
        r#"
        function fib(n) {
            if (n < 2) { return n; }
            return fib(n - 1) + fib(n - 2);
        }
        let result = fib(20);
        "#,
    )
    .unwrap();
    assert_eq!(num(&ctx, "result"), 6765.0);
}

#[test]
fn factorial_and_forward_ref() {
    let ctx = run(
        r#"
        function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); }
        function callIt() { return later(); }
        function later() { return 42; }
        let a = fact(10);
        let b = callIt();
        "#,
    )
    .unwrap();
    assert_eq!(num(&ctx, "a"), 3628800.0);
    assert_eq!(num(&ctx, "b"), 42.0);
}

#[test]
fn closures_counter() {
    let ctx = run(
        r#"
        function makeCounter() {
            let count = 0;
            return function() {
                count = count + 1;
                return count;
            };
        }
        let c1 = makeCounter();
        let c2 = makeCounter();
        let r1 = c1();
        let r2 = c1();
        let r3 = c1();
        let other = c2();
        "#,
    )
    .unwrap();
    assert_eq!(num(&ctx, "r1"), 1.0);
    assert_eq!(num(&ctx, "r2"), 2.0);
    assert_eq!(num(&ctx, "r3"), 3.0);
    assert_eq!(num(&ctx, "other"), 1.0);
}

#[test]
fn nested_closure_capture() {
    let ctx = run(
        r#"
        function adder(x) {
            return function(y) {
                return function(z) { return x + y + z; };
            };
        }
        let result = adder(1)(2)(3);
        "#,
    )
    .unwrap();
    assert_eq!(num(&ctx, "result"), 6.0);
}

// ------------------------------------------------------ objects & arrays

#[test]
fn objects_and_methods() {
    let ctx = run(
        r#"
        let point = {
            x: 3,
            y: 4,
            norm: function() {
                return Math.sqrt(this.x * this.x + this.y * this.y);
            }
        };
        let n = point.norm();
        point.x = 6;
        let x2 = point.x;
        point["z"] = 8;
        let z = point.z;
        let missing = point.nope;
        "#,
    )
    .unwrap();
    assert_eq!(num(&ctx, "n"), 5.0);
    assert_eq!(num(&ctx, "x2"), 6.0);
    assert_eq!(num(&ctx, "z"), 8.0);
    assert!(matches!(global(&ctx, "missing"), Value::Undefined));
}

#[test]
fn arrays() {
    let ctx = run(
        r#"
        let a = [1, 2, 3];
        a.push(4);
        let len = a.length;
        let third = a[2];
        a[0] = 10;
        let first = a[0];
        let last = a.pop();
        let len2 = a.length;
        let joined = a.join("-");
        let hasTwo = a.includes(2);
        "#,
    )
    .unwrap();
    assert_eq!(num(&ctx, "len"), 4.0);
    assert_eq!(num(&ctx, "third"), 3.0);
    assert_eq!(num(&ctx, "first"), 10.0);
    assert_eq!(num(&ctx, "last"), 4.0);
    assert_eq!(num(&ctx, "len2"), 3.0);
    assert_eq!(string(&ctx, "joined"), "10-2-3");
    assert!(matches!(global(&ctx, "hasTwo"), Value::Bool(true)));
}

#[test]
fn string_ops() {
    let ctx = run(
        r#"
        let s = "hello";
        let len = s.length;
        let ch = s[1];
        "#,
    )
    .unwrap();
    assert_eq!(num(&ctx, "len"), 5.0);
    assert_eq!(string(&ctx, "ch"), "e");
}

// ------------------------------------------------------------ concurrency

#[test]
fn spawn_sleep_channel() {
    let ctx = run(
        r#"
        let ch = channel();
        spawn(function() {
            sleep(50);
            ch.send(42);
        });
        let got = ch.recv();
        "#,
    )
    .unwrap();
    assert_eq!(num(&ctx, "got"), 42.0);
}

#[test]
fn spawn_with_args_and_join() {
    let ctx = run(
        r#"
        function add(a, b) { return a + b; }
        let h = spawn(add, 20, 22);
        let result = join(h);
        "#,
    )
    .unwrap();
    assert_eq!(num(&ctx, "result"), 42.0);
}

#[test]
fn pingpong_channel() {
    let ctx = run(
        r#"
        let toB = channel();
        let toA = channel();
        spawn(function() {
            for (let i = 0; i < 1000; i++) {
                let v = toB.recv();
                toA.send(v + 1);
            }
        });
        let last = 0;
        for (let i = 0; i < 1000; i++) {
            toB.send(i);
            last = toA.recv();
        }
        "#,
    )
    .unwrap();
    assert_eq!(num(&ctx, "last"), 1000.0);
}

#[test]
fn ten_thousand_sleeping_tasks() {
    let start = Instant::now();
    let ctx = run(
        r#"
        let ch = channel(10000);
        for (let i = 0; i < 10000; i++) {
            spawn(function() {
                sleep(100);
                ch.send(1);
            });
        }
        let total = 0;
        for (let i = 0; i < 10000; i++) {
            total = total + ch.recv();
        }
        "#,
    )
    .unwrap();
    let elapsed = start.elapsed();
    assert_eq!(num(&ctx, "total"), 10000.0);
    // 10k tasks each sleeping 100ms must overlap: serially this would take
    // ~1000s; concurrently it should finish in well under 10s.
    assert!(
        elapsed.as_secs() < 10,
        "10k sleeping tasks took {elapsed:?} — not multiplexing"
    );
    println!("10k sleeping tasks completed in {elapsed:?}");
}

// --------------------------------------------------------- error reporting

#[test]
fn unsupported_constructs_error_clearly() {
    assert_compile_error("let f = () => 1;", "arrow functions");
    assert_compile_error("class Foo {}", "classes");
    assert_compile_error("for (let x of [1]) {}", "for-of loops");
    assert_compile_error("try { } catch (e) { }", "try/catch");
    assert_compile_error("switch (1) { case 1: break; }", "switch");
    assert_compile_error("async function f() {}", "async functions");
}

#[test]
fn runtime_errors_are_clear() {
    let err = run_err("noSuchVariable;");
    assert!(err.contains("noSuchVariable is not defined"), "got: {err}");
    let err = run_err("let x = null; x.foo;");
    assert!(err.contains("cannot read property"), "got: {err}");
}
