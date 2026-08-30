//! Shell quoting helpers, transliterated from `src/util/shell.ts` and gated
//! byte-exactly by `parity/goldens/shell-quoting.json`.

/// Single-quote a string for POSIX shells. Safe for any content.
pub fn shq(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/// Quote an argv into a single shell command string.
pub fn shjoin(argv: &[&str]) -> String {
    argv.iter()
        .map(|arg| shq(arg))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Quote a remote path for use inside a `bash -lc` command string.
/// A leading `~/` must survive quoting so the remote shell expands it,
/// so it is rewritten to `"$HOME/..."` with double-quote escaping.
pub fn shq_remote_path(path: &str) -> String {
    if path == "~" {
        return "\"$HOME\"".to_owned();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        let mut out = String::with_capacity(rest.len() + 11);
        out.push_str("\"$HOME/");
        for ch in rest.chars() {
            if matches!(ch, '\\' | '"' | '$' | '`') {
                out.push('\\');
            }
            out.push(ch);
        }
        out.push('"');
        return out;
    }
    shq(path)
}
