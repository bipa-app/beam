//! File content digests, transliterated from `src/util/digest.ts` and gated
//! byte-exactly by `parity/goldens/digest.json`.

use std::cmp::Ordering;
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
///
/// # Errors
///
/// Returns an error if the file cannot be opened or read.
pub fn file_sha256(path: &Path) -> io::Result<String> {
    file_sha256_chunked(path, DEFAULT_CHUNK_BYTES)
}

/// Test seam mirroring smaller values of the TS `chunkBytes` parameter. The
/// production buffer remains the hard upper bound.
///
/// # Errors
///
/// Returns an error for a zero or oversized chunk, or if the file cannot be
/// opened or read.
pub fn file_sha256_chunked(path: &Path, chunk_bytes: usize) -> io::Result<String> {
    if chunk_bytes == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("file_sha256: chunk size must be between 1 and {DEFAULT_CHUNK_BYTES} bytes"),
        ));
    }
    if chunk_bytes > DEFAULT_CHUNK_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("file_sha256: chunk size must be between 1 and {DEFAULT_CHUNK_BYTES} bytes"),
        ));
    }
    Ok(hex::encode(file_sha256_digest(path, chunk_bytes)?))
}

fn file_sha256_digest(path: &Path, chunk_bytes: usize) -> io::Result<[u8; 32]> {
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
    Ok(hasher.finalize().into())
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
/// symlink target for links. Each variant carries only its valid fields.
#[derive(serde::Deserialize, PartialEq, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TreeManifestEntry {
    File { path: String, mode: u32 },
    Dir { path: String, mode: u32 },
    Link { path: String, target: String },
}

impl TreeManifestEntry {
    /// Relative manifest path shared by every entry kind.
    pub fn path(&self) -> &str {
        match self {
            Self::File { path, .. } | Self::Dir { path, .. } | Self::Link { path, .. } => path,
        }
    }
}

impl serde::Serialize for TreeManifestEntry {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeMap;

        let mut map = serializer.serialize_map(Some(3))?;
        match self {
            Self::File { path, mode } => {
                map.serialize_entry("path", path)?;
                map.serialize_entry("kind", "file")?;
                map.serialize_entry("mode", mode)?;
            }
            Self::Dir { path, mode } => {
                map.serialize_entry("path", path)?;
                map.serialize_entry("kind", "dir")?;
                map.serialize_entry("mode", mode)?;
            }
            Self::Link { path, target } => {
                map.serialize_entry("path", path)?;
                map.serialize_entry("kind", "link")?;
                map.serialize_entry("target", target)?;
            }
        }
        map.end()
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
///
/// # Errors
///
/// Returns an error if the tree cannot be read, contains a non-UTF-8 name or
/// unsupported entry kind, or exceeds [`MAX_TREE_DEPTH`].
pub fn tree_manifest(dir: &Path) -> io::Result<Vec<TreeManifestEntry>> {
    tree_manifest_prefixed(dir, "")
}

/// `prefix` mirrors the TS parameter: it is prepended to every reported
/// path without existing on disk — callers use it to mount the manifest at
/// a virtual root. The walk bound and termination argument match
/// tree_sha256.
///
/// # Errors
///
/// Returns the same errors as [`tree_manifest`].
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
            out.push(TreeManifestEntry::Link {
                path: rel,
                target: target.to_string_lossy().into_owned(),
            });
            continue;
        }
        if file_type.is_dir() {
            out.push(TreeManifestEntry::Dir {
                path: rel.clone(),
                mode: normalized_mode(&metadata),
            });
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
            out.push(TreeManifestEntry::File {
                path: rel,
                mode: normalized_mode(&metadata),
            });
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
    names.sort_by(|left, right| typescript_string_cmp(left, right));
    Ok(names)
}

fn typescript_string_cmp(left: &str, right: &str) -> Ordering {
    // JavaScript sorts UTF-16 code units; Rust scalar ordering differs for astral names.
    left.encode_utf16().cmp(right.encode_utf16())
}

/// Deterministic digest of a directory tree's exact content: sorted relative
/// paths folded with their kind and per-entry identity (streaming file
/// sha256, symlink target, directory marker) into one sha256. Distinguishes
/// content, link-target, and kind changes; absent-vs-empty is the caller's
/// contract.
///
/// # Errors
///
/// Returns an error if the tree or a file cannot be read, contains a non-UTF-8
/// name or unsupported entry kind, or exceeds [`MAX_TREE_DEPTH`].
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
            hasher.update(b"link\0");
            hasher.update(rel.as_bytes());
            hasher.update(b"\0");
            hasher.update(target.to_string_lossy().as_bytes());
            hasher.update(b"\0");
            continue;
        }
        if file_type.is_dir() {
            hasher.update(b"dir\0");
            hasher.update(rel.as_bytes());
            hasher.update(b"\0");
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
            let digest = file_sha256_digest(&abs, DEFAULT_CHUNK_BYTES)?;
            let mut sha = [0u8; 64];
            let alphabet = b"0123456789abcdef";
            for (index, byte) in digest.iter().copied().enumerate() {
                sha[index * 2] = alphabet[usize::from(byte >> 4)];
                sha[index * 2 + 1] = alphabet[usize::from(byte & 0x0f)];
            }
            hasher.update(b"file\0");
            hasher.update(rel.as_bytes());
            hasher.update(b"\0");
            hasher.update(sha);
            hasher.update(b"\0");
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
