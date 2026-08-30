import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Component-wise private-directory guarantee for Beam-owned local storage.
 *
 * Beam's local storage holds full workspace mirrors, transcripts, and
 * ownership tokens; the default umask (022) would leave every created
 * parent traversable by any local user. Starting at `root` — a Beam-owned
 * boundary such as BEAM_DIR — and descending through `segments`, every
 * component is proven to be a real directory owned by this process and is
 * closed to group/other:
 *
 * - missing        -> created 0700 (a mkdir mode is masked by the umask,
 *                     but the umask only CLEARS bits and 0700 has no
 *                     group/other bits to clear — so 0700 is umask-immune)
 * - symlink        -> refuse: a replaced component would silently redirect
 *                     every later stage/receipt write outside Beam's storage
 * - non-directory  -> refuse
 * - foreign owner  -> refuse (where the platform reports ownership): Beam
 *                     never chmods or writes beneath another user's object
 * - owned but open -> chmod 0700: a dir Beam created before this hardening
 *                     (or under a broader umask) is retro-tightened
 *
 * After each component the entry is re-read and must be a real directory
 * with no group/other bits — a failed or raced tightening refuses instead
 * of proceeding into disclosable storage. Ancestors ABOVE `root` are
 * outside Beam's ownership boundary and are never chmodded; they are
 * created plainly when missing (disclosure protection starts at `root`,
 * whose 0700 blocks traversal into everything below).
 *
 * Returns the fully joined, verified path.
 */
export function ensurePrivateBeamDir(root: string, ...segments: string[]): string {
  mkdirSync(dirname(root), { recursive: true });
  let p = root;
  securePrivateComponent(p);
  for (const seg of segments) {
    p = join(p, seg);
    securePrivateComponent(p);
  }
  return p;
}

/** Read-only counterpart used before consuming an existing private receipt. */
export function assertPrivateBeamDir(root: string, ...segments: string[]): string {
  let path = root;
  assertPrivateComponent(path);
  for (const segment of segments) {
    path = join(path, segment);
    assertPrivateComponent(path);
  }
  return path;
}

function securePrivateComponent(p: string): void {
  let st = lstatSync(p, { throwIfNoEntry: false });
  if (st === undefined) {
    try {
      mkdirSync(p, { mode: 0o700 });
    } catch (err) {
      // Only EEXIST is expected here: a lost same-user create race, where
      // the re-inspection below decides what the winner left behind. Any
      // other fault (EACCES, ENOSPC, ENOTDIR, ...) is real and surfaces.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    st = lstatSync(p, { throwIfNoEntry: false });
    if (st === undefined) throw new Error(`beam: failed to create private directory ${p}`);
  }
  if (st.isSymbolicLink()) {
    throw new Error(
      `beam: ${p} is a symlink — Beam's private storage must be a real directory it owns; ` +
        `refusing to follow it. Move the link aside and retry`,
    );
  }
  if (!st.isDirectory()) {
    throw new Error(`beam: ${p} exists but is not a directory — move it aside and retry`);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && st.uid !== uid) {
    throw new Error(
      `beam: ${p} is owned by uid ${st.uid}, not this process (uid ${uid}) — refusing to use ` +
        `foreign storage for private return data. Move it aside and retry`,
    );
  }
  if ((st.mode & 0o077) !== 0) chmodSync(p, 0o700);
  assertPrivateComponent(p);
}

function assertPrivateComponent(path: string): void {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (st === undefined) {
    throw new Error(`beam: private directory ${path} is missing`);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && st.uid !== uid) {
    throw new Error(
      `beam: ${path} is owned by uid ${st.uid}, not this process (uid ${uid}) — ` +
        `refusing to read foreign private data`,
    );
  }
  if (st.isSymbolicLink() || !st.isDirectory() || (st.mode & 0o077) !== 0) {
    throw new Error(
      `beam: ${path} must be a real private directory owned by this process ` +
        `(mode ${(st.mode & 0o7777).toString(8)})`,
    );
  }
}
