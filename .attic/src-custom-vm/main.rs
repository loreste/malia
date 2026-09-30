use std::sync::Arc;
use std::time::Instant;

use anyhow::{Context, Result};

use js_engine::compile_source;
use js_engine::scheduler::{run_main, RuntimeCtx};
use js_engine::value::Value;

async fn run_file(ctx: Arc<RuntimeCtx>, path: &str) -> Result<Value> {
    let src = std::fs::read_to_string(path).with_context(|| format!("cannot read {path}"))?;
    let main = compile_source(&src, false)?;
    run_main(ctx, main).await.map_err(|e| anyhow::anyhow!(e))
}

async fn bench(ctx: Arc<RuntimeCtx>, path: &str) -> Result<()> {
    let src = std::fs::read_to_string(path).with_context(|| format!("cannot read {path}"))?;
    let main = compile_source(&src, false)?;
    let start = Instant::now();
    run_main(ctx.clone(), main)
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    let elapsed = start.elapsed();
    let ops = ctx.ops_count();
    let secs = elapsed.as_secs_f64();
    println!("wall time: {secs:.3}s");
    println!("ops executed: {ops}");
    if secs > 0.0 {
        println!("ops/sec: {:.0}", ops as f64 / secs);
    }
    Ok(())
}

async fn repl(ctx: Arc<RuntimeCtx>) -> Result<()> {
    let mut rl = rustyline::DefaultEditor::new()?;
    println!("jse REPL — Ctrl-D to exit");
    loop {
        match rl.readline("jse> ") {
            Ok(line) => {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let _ = rl.add_history_entry(line);
                match compile_source(line, true) {
                    Ok(main) => match run_main(ctx.clone(), main).await {
                        Ok(v) => {
                            if !matches!(v, Value::Undefined) {
                                println!("{}", v.to_display());
                            }
                        }
                        Err(e) => println!("runtime error: {e}"),
                    },
                    Err(e) => println!("{e:#}"),
                }
            }
            Err(rustyline::error::ReadlineError::Interrupted)
            | Err(rustyline::error::ReadlineError::Eof) => break,
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

fn usage() -> ! {
    eprintln!("usage:");
    eprintln!("  jse run <file.js>    run a script");
    eprintln!("  jse bench <file.js>  run and print wall time + ops/sec");
    eprintln!("  jse                  start the REPL");
    std::process::exit(2);
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let ctx = RuntimeCtx::new();
    match args.first().map(|s| s.as_str()) {
        Some("run") => {
            let path = args.get(1).unwrap_or_else(|| usage());
            run_file(ctx, path).await?;
        }
        Some("bench") => {
            let path = args.get(1).unwrap_or_else(|| usage());
            bench(ctx, path).await?;
        }
        Some(_) => usage(),
        None => repl(ctx).await?,
    }
    Ok(())
}
