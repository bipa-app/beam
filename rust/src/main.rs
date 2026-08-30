// Phase 0 scaffold of the Rust port: it proves the pinned toolchain and the
// fmt/clippy/test/deny gates on both OSes before any seam is ported. The
// shipping beam CLI is still the TypeScript implementation; see
// docs/DESIGN.md, "Rust port (transition record)".
use std::process::ExitCode;

fn main() -> ExitCode {
    eprintln!("beam (rust port scaffold): not the shipping CLI yet.");
    eprintln!("Use the TypeScript beam; transition record: docs/DESIGN.md, \"Rust port\".");
    ExitCode::FAILURE
}
