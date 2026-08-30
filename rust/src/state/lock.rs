//! Create-only local lock publication. A contender stages complete pid+nonce
//! bytes, fsyncs them, then hard-links the inode into place. Beam never
//! unlinks a lock it did not publish and re-proves bytes plus dev/inode before
//! releasing one it owns.

use std::ffi::OsString;
use std::fmt::{Display, Formatter};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use rustix::fs::{Mode, OFlags};
use rustix::io::Errno;
use rustix::process::{Pid, getpid, test_kill_process};
use tokio::time::sleep;

use crate::util::private_dir::ensure_private_beam_dir;

const LOCK_POLL: Duration = Duration::from_millis(25);
const MAX_LOCK_ACQUIRE_ATTEMPTS: usize = 512;
const MAX_LOCK_BYTES: usize = 128;
const RESIDUE_CONFIRM_READS: usize = 2;

#[derive(Debug)]
pub struct LockError {
    message: String,
}

impl Display for LockError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for LockError {}

pub struct LockIdentity {
    pub path: PathBuf,
    pub bytes: Vec<u8>,
    device: u64,
    inode: u64,
}

pub struct StagedLock {
    pub stage_path: PathBuf,
    identity: LockIdentity,
}

pub struct LockAcquireOptions<'a> {
    pub wait: Duration,
    pub wait_for_live_owner: bool,
    pub live_owner_error: &'a dyn Fn(u32) -> String,
}

/// Write and fsync a unique same-directory lock inode without publishing it.
pub fn stage_lock(path: &Path) -> Result<StagedLock, LockError> {
    let mut nonce = [0_u8; 8];
    getrandom::fill(&mut nonce).map_err(|source| LockError {
        message: format!(
            "could not generate lock nonce for {}: {source}",
            path.display()
        ),
    })?;
    let nonce_hex = hex::encode(nonce);
    let pid = current_pid();
    let bytes = format!("{pid} {nonce_hex}\n").into_bytes();
    let mut stage_name = OsString::from(path.as_os_str());
    stage_name.push(format!(".stage.{pid}.{nonce_hex}"));
    let stage_path = PathBuf::from(stage_name);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&stage_path)
        .map_err(|source| LockError {
            message: format!("could not stage lock {}: {source}", stage_path.display()),
        })?;
    let result = (|| {
        file.write_all(&bytes)?;
        file.sync_all()?;
        file.metadata()
    })();
    let metadata = match result {
        Ok(metadata) => metadata,
        Err(source) => {
            drop(file);
            let cleanup = remove_stage_file(&stage_path).err();
            return Err(LockError {
                message: error_with_cleanup(
                    format!(
                        "could not write staged lock {}: {source}",
                        stage_path.display()
                    ),
                    cleanup,
                ),
            });
        }
    };
    Ok(StagedLock {
        stage_path,
        identity: LockIdentity {
            path: path.to_path_buf(),
            bytes,
            device: metadata.dev(),
            inode: metadata.ino(),
        },
    })
}

/// Hard-link a staged inode into place. Existing destinations lose cleanly.
pub fn publish_staged_lock(staged: StagedLock) -> Result<Option<LockIdentity>, LockError> {
    match fs::hard_link(&staged.stage_path, &staged.identity.path) {
        Ok(()) => {}
        Err(source) if source.kind() == std::io::ErrorKind::AlreadyExists => {
            remove_stage_file(&staged.stage_path).map_err(|cleanup| LockError {
                message: format!(
                    "lock {} was already held, and staged lock {} could not be removed: {cleanup}",
                    staged.identity.path.display(),
                    staged.stage_path.display()
                ),
            })?;
            return Ok(None);
        }
        Err(source) => {
            let cleanup = remove_stage_file(&staged.stage_path).err();
            return Err(LockError {
                message: error_with_cleanup(
                    format!(
                        "could not publish lock {}: {source}",
                        staged.identity.path.display()
                    ),
                    cleanup,
                ),
            });
        }
    }
    if let Err(source) = remove_stage_file(&staged.stage_path) {
        let rollback = release_lock(&staged.identity).err();
        let message = match rollback {
            Some(rollback) => format!(
                "published lock {}, but could not remove stage {}: {source}; rollback also failed: \
                 {rollback}. Remove the stage manually and inspect the lock before retrying",
                staged.identity.path.display(),
                staged.stage_path.display()
            ),
            None => format!(
                "published lock {}, but could not remove stage {}: {source}; the destination was \
                 rolled back. Remove the stage manually and retry",
                staged.identity.path.display(),
                staged.stage_path.display()
            ),
        };
        return Err(LockError { message });
    }
    Ok(Some(staged.identity))
}

/// Acquire a lock without ever reclaiming an inode another process published.
pub async fn acquire_lock_file(
    path: &Path,
    options: &LockAcquireOptions<'_>,
) -> Result<LockIdentity, LockError> {
    let deadline = Instant::now()
        .checked_add(options.wait)
        .ok_or_else(|| LockError {
            message: format!("lock wait is too large for {}", path.display()),
        })?;
    for _attempt_index in 0..MAX_LOCK_ACQUIRE_ATTEMPTS {
        if let Some(owned) = publish_staged_lock(stage_lock(path)?)? {
            return Ok(owned);
        }
        let Some(observed) = observe_lock(path)? else {
            continue;
        };
        let Some(owner) = parse_lock_owner(&observed.bytes) else {
            if is_stable_residue(&observed).await? {
                return Err(LockError {
                    message: format!(
                        "lock file {} holds content no beam wrote — if no beam process is running, \
                         remove it manually and retry",
                        observed.path.display()
                    ),
                });
            }
            continue;
        };
        if !pid_alive(owner)? {
            return Err(LockError {
                message: format!(
                    "lock file {} names pid {owner}, which is no longer running — beam never \
                     auto-reclaims a crashed owner's lock; confirm no beam process is running, \
                     then remove it manually and retry",
                    observed.path.display()
                ),
            });
        }
        let now = Instant::now();
        if !options.wait_for_live_owner || now >= deadline {
            return Err(LockError {
                message: (options.live_owner_error)(owner),
            });
        }
        sleep(LOCK_POLL.min(deadline.saturating_duration_since(now))).await;
    }
    Err(LockError {
        message: format!(
            "lock {} changed too often across {MAX_LOCK_ACQUIRE_ATTEMPTS} attempts — stop other \
             beam processes and retry",
            path.display()
        ),
    })
}

/// Release only if the pathname still names the exact inode and bytes owned.
pub fn release_lock(owned: &LockIdentity) -> Result<(), LockError> {
    let Some(observed) = observe_lock(&owned.path)? else {
        return Err(LockError {
            message: format!(
                "beam: lock {} vanished while pid {} held it — concurrent beam processes may have \
                 overlapped",
                owned.path.display(),
                current_pid()
            ),
        });
    };
    if !same_lock(&observed, owned) {
        return Err(LockError {
            message: format!(
                "beam: lock {} changed hands while pid {} held it — leaving it untouched; \
                 concurrent beam processes may have overlapped",
                owned.path.display(),
                current_pid()
            ),
        });
    }
    match fs::remove_file(&owned.path) {
        Ok(()) => Ok(()),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Err(LockError {
            message: format!(
                "beam: lock {} vanished during release — concurrent beam processes may have \
                 overlapped",
                owned.path.display()
            ),
        }),
        Err(source) => Err(LockError {
            message: format!("could not release lock {}: {source}", owned.path.display()),
        }),
    }
}

pub async fn acquire_state_lock(
    beam_dir: &Path,
    wait: Duration,
) -> Result<LockIdentity, LockError> {
    ensure_private_beam_dir(beam_dir, &[]).map_err(|source| LockError {
        message: source.to_string(),
    })?;
    let path = beam_dir.join("state.lock");
    let live_owner_error = |owner| {
        format!(
            "another beam process (pid {owner}) holds the state lock at {} — retry in a moment",
            path.display()
        )
    };
    acquire_lock_file(
        &path,
        &LockAcquireOptions {
            wait,
            wait_for_live_owner: true,
            live_owner_error: &live_owner_error,
        },
    )
    .await
}

pub async fn acquire_operation_lock(
    beam_dir: &Path,
    record_id: &str,
) -> Result<LockIdentity, LockError> {
    if record_id.is_empty()
        || record_id.len() > 64
        || !record_id.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        return Err(LockError {
            message: format!("handoff id {record_id:?} is not safe for an operation lock path"),
        });
    }
    ensure_private_beam_dir(beam_dir, &[]).map_err(|source| LockError {
        message: source.to_string(),
    })?;
    let path = beam_dir.join(format!("op-{record_id}.lock"));
    let live_owner_error = |owner| {
        format!(
            "another beam process (pid {owner}) is already operating on handoff {record_id} — \
             wait for it to finish and retry"
        )
    };
    acquire_lock_file(
        &path,
        &LockAcquireOptions {
            wait: Duration::ZERO,
            wait_for_live_owner: false,
            live_owner_error: &live_owner_error,
        },
    )
    .await
}

fn observe_lock(path: &Path) -> Result<Option<LockIdentity>, LockError> {
    let fd = match rustix::fs::open(
        path,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    ) {
        Ok(fd) => fd,
        Err(Errno::NOENT) => return Ok(None),
        Err(source) => {
            return Err(LockError {
                message: format!(
                    "could not safely open lock file {}: {source}; if no beam process is running, \
                     inspect it and remove it manually",
                    path.display()
                ),
            });
        }
    };
    let mut file = File::from(fd);
    let metadata = file.metadata().map_err(|source| LockError {
        message: format!("could not inspect lock file {}: {source}", path.display()),
    })?;
    let mut bytes = Vec::with_capacity(MAX_LOCK_BYTES);
    Read::by_ref(&mut file)
        .take((MAX_LOCK_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|source| LockError {
            message: format!("could not read lock file {}: {source}", path.display()),
        })?;
    if bytes.len() > MAX_LOCK_BYTES {
        return Err(LockError {
            message: format!(
                "lock file {} exceeds {MAX_LOCK_BYTES} bytes — if no beam process is running, \
                 remove it manually and retry",
                path.display()
            ),
        });
    }
    Ok(Some(LockIdentity {
        path: path.to_path_buf(),
        bytes,
        device: metadata.dev(),
        inode: metadata.ino(),
    }))
}

async fn is_stable_residue(observed: &LockIdentity) -> Result<bool, LockError> {
    for _confirmation_index in 0..RESIDUE_CONFIRM_READS {
        sleep(LOCK_POLL).await;
        let Some(again) = observe_lock(&observed.path)? else {
            return Ok(false);
        };
        if !same_lock(&again, observed) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn same_lock(left: &LockIdentity, right: &LockIdentity) -> bool {
    left.device == right.device && left.inode == right.inode && left.bytes == right.bytes
}

fn parse_lock_owner(bytes: &[u8]) -> Option<u32> {
    if let Some(body) = bytes.strip_suffix(b"\n") {
        let space_index = body.iter().position(|byte| *byte == b' ')?;
        let nonce = body.get(space_index + 1..)?;
        if nonce.len() != 16 {
            return None;
        }
        if !nonce
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
        {
            return None;
        }
        if body.get(space_index + 1..)?.contains(&b' ') {
            return None;
        }
        return parse_pid_digits(body.get(..space_index)?);
    }
    parse_pid_digits(bytes)
}

fn parse_pid_digits(bytes: &[u8]) -> Option<u32> {
    if bytes.is_empty() || bytes.len() > 15 || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    let text = std::str::from_utf8(bytes).ok()?;
    let owner = text.parse::<u32>().ok()?;
    if owner == 0 || owner > i32::MAX as u32 {
        return None;
    }
    Some(owner)
}

fn current_pid() -> u32 {
    getpid().as_raw_nonzero().get().unsigned_abs()
}

fn pid_alive(owner: u32) -> Result<bool, LockError> {
    let raw = i32::try_from(owner).map_err(|source| LockError {
        message: format!("lock owner pid {owner} is outside the platform range: {source}"),
    })?;
    let pid = Pid::from_raw(raw).ok_or_else(|| LockError {
        message: format!("lock owner pid {owner} is not positive"),
    })?;
    match test_kill_process(pid) {
        Ok(()) => Ok(true),
        Err(Errno::PERM) => Ok(true),
        Err(Errno::SRCH) => Ok(false),
        Err(source) => Err(LockError {
            message: format!("could not probe lock owner pid {owner}: {source}"),
        }),
    }
}

fn remove_stage_file(path: &Path) -> Result<(), std::io::Error> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(source),
    }
}

fn error_with_cleanup(message: String, cleanup: Option<std::io::Error>) -> String {
    match cleanup {
        Some(source) => format!("{message}; also could not remove the staged lock: {source}"),
        None => message,
    }
}
