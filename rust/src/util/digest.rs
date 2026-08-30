//! File content digests, transliterated from `src/util/digest.ts` and gated
//! byte-exactly by `parity/goldens/digest.json`.

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

/// Production chunk size for streaming file digests: 1 MiB, one reused
/// bounded buffer — workspace files and git packs can be gigabytes and must
/// never be buffered whole. Callers may pass a smaller chunk in tests to
/// force multi-chunk reads on small fixtures.
pub const DEFAULT_CHUNK_BYTES: usize = 1 << 20;

/// Directory-depth ceiling for the explicit tree-walk stacks below. Real
/// workspace trees are shallow next to this; the bound turns a hostile or
/// corrupt tree into an error instead of an unbounded walk.
pub const MAX_TREE_DEPTH: usize = 4096;

/// Streaming synchronous SHA-256 of a regular file through one fixed bounded
/// buffer. Every full-tree manifest/fingerprint hashes file content through
/// this helper.
pub fn file_sha256(path: &Path) -> io::Result<String> {
    file_sha256_chunked(path, DEFAULT_CHUNK_BYTES)
}

/// Test-only seam mirroring the TS `chunkBytes` parameter: forces the
/// bounded-buffer loop over small fixtures. Rejects a zero chunk like the
/// TS guard rejects non-positive sizes.
pub fn file_sha256_chunked(path: &Path, chunk_bytes: usize) -> io::Result<String> {
    if chunk_bytes == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "file_sha256: chunk size must be positive",
        ));
    }
    let mut file = fs::File::open(path)?;
    let mut buffer = vec![0u8; chunk_bytes];
    let mut hasher = Sha256::new();
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// One directory being scanned by the explicit preorder tree walk: sorted
/// child names with `next` the first not yet visited.
struct WalkFrame {
    dir: PathBuf,
    prefix: String,
    names: Vec<String>,
    next: usize,
}
/// One entry of a structural tree manifest (sorted by relative path):
/// normalized permission bits (mode & 0o7777) for files and directories,
/// symlink target for links. Optional fields serialize absent, matching the
/// TypeScript shape the golden pins.
#[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
pub struct TreeManifestEntry {
    pub path: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

impl TreeManifestEntry {
    fn file(path: String, mode: u32) -> Self {
        Self {
            path,
            kind: "file".to_owned(),
            mode: Some(mode),
            target: None,
        }
    }

    fn dir(path: String, mode: u32) -> Self {
        Self {
            path,
            kind: "dir".to_owned(),
            mode: Some(mode),
            target: None,
        }
    }

    fn link(path: String, target: String) -> Self {
        Self {
            path,
            kind: "link".to_owned(),
            mode: None,
            target: Some(target),
        }
    }
}

/// Permission bits normalized like the TypeScript `st.mode & 0o7777`.
/// Beam runs on POSIX hosts only (macOS/Linux CI); on a non-unix host the
/// manifest cannot promise mode parity and says so instead of guessing.
#[cfg(unix)]
fn normalized_mode(metadata: &fs::Metadata) -> u32 {
    metadata.mode() & 0o7777
}

#[cfg(not(unix))]
fn normalized_mode(_metadata: &fs::Metadata) -> u32 {
    unreachable!("tree manifests with mode parity require a POSIX host")
}

/// Structural manifest of a directory tree: sorted relative paths with
/// kind, normalized mode (files/dirs), and symlink targets. Content
/// equality is the caller's concern (pair with byte compares or
/// file_sha256); this is the shape+mode half of an exact-tree comparison.
pub fn tree_manifest(dir: &Path) -> io::Result<Vec<TreeManifestEntry>> {
    tree_manifest_prefixed(dir, "")
}

/// `prefix` mirrors the TS parameter: it is prepended to every reported
/// path without existing on disk — callers use it to mount the manifest at
/// a virtual root. The walk bound and termination argument match
/// tree_sha256.
pub fn tree_manifest_prefixed(dir: &Path, prefix: &str) -> io::Result<Vec<TreeManifestEntry>> {
    let mut out = Vec::new();
    let mut stack = vec![WalkFrame {
        dir: dir.to_path_buf(),
        prefix: prefix.to_owned(),
        names: sorted_child_names(dir)?,
        next: 0,
    }];
    while let Some(top) = stack.last_mut() {
        if top.next == top.names.len() {
            stack.pop();
            continue;
        }
        let name = top.names[top.next].clone();
        top.next += 1;
        let rel = if top.prefix.is_empty() {
            name.clone()
        } else {
            format!("{}/{name}", top.prefix)
        };
        let abs = top.dir.join(&name);
        let metadata = fs::symlink_metadata(&abs)?;
        let file_type = metadata.file_type();
        if file_type.is_symlink() {
            let target = fs::read_link(&abs)?;
            out.push(TreeManifestEntry::link(
                rel,
                target.to_string_lossy().into_owned(),
            ));
            continue;
        }
        if file_type.is_dir() {
            out.push(TreeManifestEntry::dir(
                rel.clone(),
                normalized_mode(&metadata),
            ));
            if stack.len() == MAX_TREE_DEPTH {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "tree_manifest: tree deeper than {MAX_TREE_DEPTH} directories at {}",
                        abs.display()
                    ),
                ));
            }
            stack.push(WalkFrame {
                dir: abs.clone(),
                prefix: rel,
                names: sorted_child_names(&abs)?,
                next: 0,
            });
            continue;
        }
        if file_type.is_file() {
            out.push(TreeManifestEntry::file(rel, normalized_mode(&metadata)));
            continue;
        }
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "tree_manifest: unsupported filesystem entry: {}",
                abs.display()
            ),
        ));
    }
    Ok(out)
}

/// Read one directory's child names, sorted, so the walk order (and any
/// digest folded from it) is filesystem-order independent.
fn sorted_child_names(dir: &Path) -> io::Result<Vec<String>> {
    let mut names = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = match entry.file_name().into_string() {
            Ok(name) => name,
            Err(raw) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "tree walk: non-UTF-8 entry name in {}: {raw:?}",
                        dir.display()
                    ),
                ));
            }
        };
        names.push(name);
    }
    names.sort();
    Ok(names)
}

/// Deterministic digest of a directory tree's exact content: sorted relative
/// paths folded with their kind and per-entry identity (streaming file
/// sha256, symlink target, directory marker) into one sha256. Distinguishes
/// content, link-target, and kind changes; absent-vs-empty is the caller's
/// contract.
pub fn tree_sha256(dir: &Path) -> io::Result<String> {
    let mut hasher = Sha256::new();
    // Explicit preorder stack (Tiger: no recursion). The top frame is the
    // directory being scanned; entering a subdirectory pushes a frame, so
    // stack depth equals directory depth and MAX_TREE_DEPTH bounds it. Each
    // iteration consumes one child name or pops a frame, so the walk over a
    // finite tree terminates.
    let mut stack = vec![WalkFrame {
        dir: dir.to_path_buf(),
        prefix: String::new(),
        names: sorted_child_names(dir)?,
        next: 0,
    }];
    while let Some(top) = stack.last_mut() {
        if top.next == top.names.len() {
            stack.pop();
            continue;
        }
        let name = top.names[top.next].clone();
        top.next += 1;
        let rel = if top.prefix.is_empty() {
            name.clone()
        } else {
            format!("{}/{name}", top.prefix)
        };
        let abs = top.dir.join(&name);
        let metadata = fs::symlink_metadata(&abs)?;
        let file_type = metadata.file_type();
        if file_type.is_symlink() {
            let target = fs::read_link(&abs)?;
            hasher.update(format!("link\0{rel}\0{}\0", target.to_string_lossy()));
            continue;
        }
        if file_type.is_dir() {
            hasher.update(format!("dir\0{rel}\0"));
            if stack.len() == MAX_TREE_DEPTH {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "tree_sha256: tree deeper than {MAX_TREE_DEPTH} directories at {}",
                        abs.display()
                    ),
                ));
            }
            stack.push(WalkFrame {
                dir: abs.clone(),
                prefix: rel,
                names: sorted_child_names(&abs)?,
                next: 0,
            });
            continue;
        }
        if file_type.is_file() {
            let sha = file_sha256(&abs)?;
            hasher.update(format!("file\0{rel}\0{sha}\0"));
            continue;
        }
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "tree_sha256: unsupported filesystem entry: {}",
                abs.display()
            ),
        ));
    }
    Ok(hex::encode(hasher.finalize()))
}
