pub mod builtins;
pub mod chunk;
pub mod compiler;
pub mod scheduler;
pub mod value;
pub mod vm;

use std::sync::Arc;

use anyhow::{bail, Result};
use oxc_allocator::Allocator;
use oxc_parser::Parser;
use oxc_span::SourceType;

use crate::value::Closure;

/// Parse JS source and compile it to a main closure.
pub fn compile_source(src: &str, repl: bool) -> Result<Arc<Closure>> {
    let allocator = Allocator::default();
    let ret = Parser::new(&allocator, src, SourceType::default()).parse();
    if ret.fatal_error || !ret.diagnostics.is_empty() {
        let msgs = ret
            .diagnostics
            .iter()
            .map(|e| e.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        bail!("parse error:\n{msgs}");
    }
    compiler::compile_program(&ret.program, repl).map_err(|e| anyhow::anyhow!(e))
}
