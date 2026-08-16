/** File content digests. Zero dependencies; Bun runtime. */

import { closeSync, lstatSync, openSync, readdirSync, readlinkSync, readSync } from "node:fs";
import { join } from "node:path";

/**
 * Streaming synchronous SHA-256 of a regular file through ONE fixed
 * bounded buffer — workspace files and git packs can be gigabytes and
 * must never be buffered whole. Every full-tree manifest/fingerprint
 * hashes file content through this helper.
 *
 * `chunkBytes` exists so tests can force multi-chunk reads on small
 * fixtures (proving the bounded-buffer seam); production callers use the
 * default.
 */
export function fileSha256(path: string, chunkBytes: number = 1 << 20): string {
  if (!Number.isInteger(chunkBytes) || chunkBytes <= 0) {
    throw new Error(`fileSha256: invalid chunk size ${chunkBytes}`);
  }
  const h = new Bun.CryptoHasher("sha256");
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(chunkBytes);
    let n: number;
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
    return h.digest("hex");
  } finally {
    closeSync(fd);
  }
}

/**
 * Directory-depth ceiling for the explicit tree-walk stacks below. Real
 * filesystems cap a whole path near PATH_MAX (4096 bytes on Linux, 1024 on
 * macOS), so a walk deeper than this means a cycle or a runaway tree —
 * refuse instead of walking forever.
 */
const MAX_TREE_DEPTH = 4096;

/** One directory being scanned by an explicit preorder tree walk. */
interface WalkFrame {
  dir: string;
  prefix: string;
  /** Sorted child names; `next` is the first not yet visited. */
  names: string[];
  next: number;
}

/**
 * Deterministic digest of a directory tree's exact content: sorted relative
 * paths folded with their kind and per-entry identity (streaming file
 * sha256, symlink target, directory marker) into one sha256. Distinguishes
 * content, link-target, and kind changes; absent-vs-empty is the caller's
 * contract. `chunkBytes` forwards to {@link fileSha256} for multi-chunk
 * test forcing.
 */
export function treeSha256(dir: string, chunkBytes?: number): string {
  const h = new Bun.CryptoHasher("sha256");
  // Explicit preorder stack (Tiger: no recursion). The top frame is the
  // directory being scanned; entering a subdirectory pushes a frame, so
  // stack depth equals directory depth and MAX_TREE_DEPTH bounds it. Each
  // iteration consumes one child name or pops a frame, so the walk over a
  // finite tree terminates.
  const stack: WalkFrame[] = [{ dir, prefix: "", names: readdirSync(dir).sort(), next: 0 }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    if (top.next === top.names.length) {
      stack.pop();
      continue;
    }
    const name = top.names[top.next]!;
    top.next += 1;
    const rel = top.prefix ? `${top.prefix}/${name}` : name;
    const abs = join(top.dir, name);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      h.update(`link\0${rel}\0${readlinkSync(abs)}\0`);
      continue;
    }
    if (st.isDirectory()) {
      h.update(`dir\0${rel}\0`);
      if (stack.length === MAX_TREE_DEPTH) {
        throw new Error(`treeSha256: tree deeper than ${MAX_TREE_DEPTH} directories at ${abs}`);
      }
      stack.push({ dir: abs, prefix: rel, names: readdirSync(abs).sort(), next: 0 });
      continue;
    }
    if (st.isFile()) {
      const sha = chunkBytes === undefined ? fileSha256(abs) : fileSha256(abs, chunkBytes);
      h.update(`file\0${rel}\0${sha}\0`);
      continue;
    }
    throw new Error(`treeSha256: unsupported filesystem entry: ${abs}`);
  }
  return h.digest("hex");
}

/** One entry of a structural tree manifest (sorted by relative path). */
export interface TreeManifestEntry {
  path: string;
  kind: "file" | "dir" | "link";
  /** Normalized permission bits (mode & 0o7777) for files and directories. */
  mode?: number;
  /** Symlink target. */
  target?: string;
}

/**
 * Structural manifest of a directory tree: sorted relative paths with kind,
 * normalized mode (files/dirs), and symlink targets. Content equality is the
 * caller's concern (pair with cmp/fileSha256); this is the shape+mode half
 * of an exact-tree comparison.
 */
export function treeManifest(dir: string, prefix = ""): TreeManifestEntry[] {
  const out: TreeManifestEntry[] = [];
  // Explicit preorder stack (Tiger: no recursion) — bound and termination
  // argument as in treeSha256 above.
  const stack: WalkFrame[] = [{ dir, prefix, names: readdirSync(dir).sort(), next: 0 }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    if (top.next === top.names.length) {
      stack.pop();
      continue;
    }
    const name = top.names[top.next]!;
    top.next += 1;
    const rel = top.prefix ? `${top.prefix}/${name}` : name;
    const abs = join(top.dir, name);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      out.push({ path: rel, kind: "link", target: readlinkSync(abs) });
      continue;
    }
    if (st.isDirectory()) {
      out.push({ path: rel, kind: "dir", mode: st.mode & 0o7777 });
      if (stack.length === MAX_TREE_DEPTH) {
        throw new Error(`treeManifest: tree deeper than ${MAX_TREE_DEPTH} directories at ${abs}`);
      }
      stack.push({ dir: abs, prefix: rel, names: readdirSync(abs).sort(), next: 0 });
      continue;
    }
    if (st.isFile()) {
      out.push({ path: rel, kind: "file", mode: st.mode & 0o7777 });
      continue;
    }
    throw new Error(`treeManifest: unsupported filesystem entry: ${abs}`);
  }
  return out;
}
