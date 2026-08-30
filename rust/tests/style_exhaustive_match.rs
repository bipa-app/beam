//! First rule of the syn-based Rust style checker promised by the transition
//! record ("rustfmt + clippy + a syn-based checker for the bespoke rules").
//! Goal: keep the bipa exhaustive-match law mechanical — a `match` with a
//! wildcard arm silently absorbs the next variant added to `BeamStatus` or
//! `TargetSpec`, and `==`/`matches!` never count toward exhaustiveness, so
//! the compiler stops being the reviewer. Method: parse every src/ and
//! tests/ file with syn, visit pattern nodes, and fail on wildcard or `..`
//! rest patterns. The gate runs as a cargo test so CI needs no new job.

use std::path::{Path, PathBuf};

use syn::spanned::Spanned;
use syn::visit::Visit;

const RULE: &str = "exhaustive-match: use an explicit pattern or a named binding; \
     wildcard silently absorbs the next enum variant (docs/DESIGN.md: Rust style)";

/// Line-allowlist for sites where a wildcard is the deliberate protocol
/// shape (e.g. a forward-compatible parser that must ignore unknown
/// variants). Each entry names its reason in a comment at the site, and a
/// new entry must also name the enclosing function in its PR line — the
/// "path:line" anchor churns, so the reason and the function carry the
/// review, not the number. Format: "relative/path.rs:line-of-the-pattern".
const ALLOW: &[&str] = &[];

#[derive(Default)]
struct WildcardVisitor {
    hits: Vec<usize>,
}

impl<'ast> Visit<'ast> for WildcardVisitor {
    fn visit_pat(&mut self, pat: &'ast syn::Pat) {
        if matches!(pat, syn::Pat::Wild(_) | syn::Pat::Rest(_)) {
            self.hits.push(pat.span().start().line);
        }
        syn::visit::visit_pat(self, pat);
    }
}

fn check_file(path: &Path, root: &Path) -> Vec<String> {
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|err| panic!("read {}: {err}", path.display()));
    let file =
        syn::parse_file(&text).unwrap_or_else(|err| panic!("parse {}: {err}", path.display()));
    let mut visitor = WildcardVisitor::default();
    visitor.visit_file(&file);
    let rel = path.strip_prefix(root).expect("path under crate root");
    visitor
        .hits
        .iter()
        .map(|line| format!("{}:{line}", rel.display()))
        .filter(|site| !ALLOW.contains(&site.as_str()))
        .collect()
}

fn collect_rs(dir: &Path, out: &mut Vec<PathBuf>) {
    if !dir.is_dir() {
        return;
    }
    for entry in std::fs::read_dir(dir).expect("read dir") {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            collect_rs(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn no_wildcard_patterns_in_match_or_let() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf();
    let mut files = Vec::new();
    collect_rs(&root.join("src"), &mut files);
    collect_rs(&root.join("tests"), &mut files);
    let mut violations = Vec::new();
    for file in &files {
        violations.extend(check_file(file, &root));
    }
    assert!(violations.is_empty(), "{RULE}\n{}", violations.join("\n"));
}
