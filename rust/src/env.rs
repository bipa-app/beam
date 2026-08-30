//! Resolved local environment, transliterated from `src/env.ts`.

use std::path::PathBuf;

/// Resolved local environment. Injectable so tests never touch the real
/// home directory or beam state.
///
/// - `BEAM_HOME` overrides where session stores (~/.omp, ~/.claude, ~/.codex)
///   are looked up.
/// - `BEAM_DIR` overrides where beam keeps config.json and state.json
///   (default: <home>/.beam).
#[derive(Clone, PartialEq, Eq)]
pub struct BeamEnv {
    /// Home directory used to locate harness session stores.
    pub home: PathBuf,
    /// Directory holding beam's own config.json and state.json.
    pub beam_dir: PathBuf,
}

impl BeamEnv {
    /// Resolve from explicit overrides, then `BEAM_HOME`/`BEAM_DIR`, then the
    /// OS home directory. Overrides win over env, env wins over the default.
    pub fn resolve(home: Option<PathBuf>, beam_dir: Option<PathBuf>) -> Self {
        let home = home
            .or_else(|| std::env::var_os("BEAM_HOME").map(PathBuf::from))
            .or_else(dirs_home)
            .unwrap_or_else(|| PathBuf::from("/"));
        let beam_dir = beam_dir
            .or_else(|| std::env::var_os("BEAM_DIR").map(PathBuf::from))
            .unwrap_or_else(|| home.join(".beam"));
        Self { home, beam_dir }
    }
}

/// OS home directory without adding a dependency: `$HOME` on POSIX (beam
/// targets macOS/Linux only), falling back to the profile var on Windows.
fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
}

/// Expand a leading `~` against a concrete home directory.
pub fn expand_tilde(path: &str, home: &std::path::Path) -> PathBuf {
    if path == "~" {
        return home.to_path_buf();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return home.join(rest);
    }
    PathBuf::from(path)
}
