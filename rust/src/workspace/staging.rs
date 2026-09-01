use std::fs::{self, DirBuilder, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::config::Config;
use crate::transport::local::LocalTransport;
use crate::transport::{OwnedWorkspace, SyncOptions, Transport};
use crate::util::private_dir::ensure_private_beam_dir;
use crate::util::shell::{RunOptions, run};

use super::fingerprint::{WorkspaceFingerprint, workspace_return_fingerprint};
use super::{
    BEAM_GITPTR_EXCLUDE, BEAM_RESERVED_DIR, BEAM_RESERVED_EXCLUDE, GIT_METADATA_EXCLUDE,
    WorkspaceError, format_bytes,
};

const MAX_SHIP_OFFENDERS: usize = 5;

pub struct StagedWorkspaceShip {
    directory: PathBuf,
    temporary: tempfile::TempDir,
}

impl StagedWorkspaceShip {
    pub fn directory(&self) -> &Path {
        &self.directory
    }

    pub fn dispose(self) -> Result<(), WorkspaceError> {
        self.temporary.close().map_err(WorkspaceError::from)
    }
}

pub struct StagedWorkspaceReturn {
    pub directory: PathBuf,
    pub fingerprint: WorkspaceFingerprint,
}

impl StagedWorkspaceReturn {
    pub fn dispose(self) -> Result<(), WorkspaceError> {
        fs::remove_dir_all(self.directory).map_err(WorkspaceError::from)
    }
}

#[derive(PartialEq, Eq, Debug)]
pub struct ReturnStage {
    pub root: PathBuf,
    pub workspace: PathBuf,
}

pub struct StageReturnOptions<'a> {
    pub excludes: &'a [String],
    pub verbose: bool,
    pub owner: Option<&'a str>,
}

pub struct ReturnManifest<'a> {
    pub record_id: &'a str,
    pub local_cwd: &'a str,
    pub remote_cwd: &'a str,
    pub fingerprint: &'a WorkspaceFingerprint,
    pub base_workspace_digest: Option<&'a str>,
    pub excludes: &'a [String],
    pub mirror_deletes: bool,
}

pub fn gather_excludes(local_cwd: &Path, config: &Config) -> Result<Vec<String>, WorkspaceError> {
    let mut excludes = vec![
        BEAM_RESERVED_EXCLUDE.to_owned(),
        BEAM_GITPTR_EXCLUDE.to_owned(),
    ];
    if let Some(configured) = &config.excludes {
        excludes.extend(configured.iter().cloned());
    }
    excludes.push(GIT_METADATA_EXCLUDE.to_owned());
    let ignore = local_cwd.join(".beamignore");
    if ignore.try_exists()? {
        for raw in fs::read_to_string(ignore)?.split('\n') {
            let line = raw.trim();
            if !line.is_empty() && !line.starts_with('#') {
                excludes.push(line.to_owned());
            }
        }
    }
    Ok(excludes)
}

pub async fn assert_no_local_reserved_collision(local_cwd: &Path) -> Result<(), WorkspaceError> {
    for entry in fs::read_dir(local_cwd)? {
        let name = entry?.file_name();
        if name
            .to_string_lossy()
            .eq_ignore_ascii_case(BEAM_RESERVED_DIR)
        {
            return Err(reserved_collision(&format!(
                "this workspace contains '{}'",
                name.to_string_lossy()
            )));
        }
    }
    let argv = [
        "git".to_owned(),
        "-C".to_owned(),
        path_text(local_cwd)?.to_owned(),
        "ls-files".to_owned(),
        "--cached".to_owned(),
        "-z".to_owned(),
    ];
    let result = run(&argv, &RunOptions::default()).await?;
    if result.code == 0 {
        assert_no_tracked_reserved(&result.stdout)?;
    }
    Ok(())
}

pub async fn assert_ship_size_bounded(
    local_cwd: &Path,
    excludes: &[String],
    bytes_max: u64,
) -> Result<Option<u64>, WorkspaceError> {
    let Some(bytes) = measure_ship_bytes(local_cwd, excludes).await? else {
        eprintln!(
            "warning: could not measure the ship size (rsync dry run failed) — skipping the size \
             preflight"
        );
        return Ok(None);
    };
    if bytes <= bytes_max {
        return Ok(Some(bytes));
    }
    let offenders = largest_workspace_entries(local_cwd).await?;
    let offender_line = if offenders.is_empty() {
        String::new()
    } else {
        format!("\n  largest entries: {offenders}")
    };
    Err(WorkspaceError::message(format!(
        "beam up: this workspace would ship {} (ceiling {}){offender_line}\n  exclude build \
         artifacts in {} (rsync patterns, one per line, e.g. \"/target\")\n  or re-run with \
         --allow-large to ship it all",
        format_bytes(bytes),
        format_bytes(bytes_max),
        local_cwd.join(".beamignore").display()
    )))
}

pub fn ensure_git_exclude(local_cwd: &Path) -> Result<(), WorkspaceError> {
    let info = local_cwd.join(".git/info");
    if !info.try_exists()? {
        return Ok(());
    }
    let exclude = info.join("exclude");
    let current = match fs::read_to_string(&exclude) {
        Ok(value) => value,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(source) => return Err(source.into()),
    };
    if current.lines().any(|line| line.trim() == ".beam/") {
        return Ok(());
    }
    let separator = if current.is_empty() || current.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    let mut file = OpenOptions::new().create(true).append(true).open(exclude)?;
    writeln!(file, "{separator}.beam/")?;
    Ok(())
}

pub fn create_return_stage(
    beam_dir: &Path,
    record_id: &str,
) -> Result<ReturnStage, WorkspaceError> {
    let parent = ensure_private_beam_dir(beam_dir, &["returns", record_id])?;
    let mut random = [0_u8; 4];
    getrandom::fill(&mut random)
        .map_err(|source| WorkspaceError::message(format!("getrandom failed: {source}")))?;
    let root = parent.join(format!(
        "{}-{}",
        utc_stamp(SystemTime::now())?,
        hex::encode(random)
    ));
    create_private_directory(&root)?;
    let workspace = root.join("workspace");
    create_private_directory(&workspace)?;
    Ok(ReturnStage { root, workspace })
}

pub async fn stage_workspace_return(
    transport: &dyn Transport,
    remote_cwd: &str,
    directory: &Path,
    options: StageReturnOptions<'_>,
) -> Result<StagedWorkspaceReturn, WorkspaceError> {
    let owned = options.owner.map(|owner_bytes| OwnedWorkspace {
        root: remote_cwd,
        owner_bytes,
    });
    transport
        .sync_down(
            remote_cwd,
            directory,
            SyncOptions {
                excludes: options.excludes,
                checksum: true,
                verbose: options.verbose,
                owned,
                ..SyncOptions::default()
            },
        )
        .await?;
    Ok(StagedWorkspaceReturn {
        directory: directory.to_path_buf(),
        fingerprint: workspace_return_fingerprint(directory)?,
    })
}

pub fn write_return_stage_manifest(
    root: &Path,
    manifest: ReturnManifest<'_>,
) -> Result<PathBuf, WorkspaceError> {
    let file = root.join("manifest.json");
    let persisted = PersistedReturnManifest {
        version: 1,
        record_id: manifest.record_id,
        local_cwd: manifest.local_cwd,
        remote_cwd: manifest.remote_cwd,
        fingerprint: manifest.fingerprint,
        base_workspace_digest: manifest.base_workspace_digest,
        excludes: manifest.excludes,
        mirror_deletes: manifest.mirror_deletes,
        created_at: utc_stamp(SystemTime::now())?,
    };
    let mut content = serde_json::to_string_pretty(&persisted)
        .map_err(|source| WorkspaceError::caused_by(source.to_string(), source))?;
    content.push('\n');
    let mut output = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&file)?;
    output.write_all(content.as_bytes())?;
    Ok(file)
}

pub async fn remote_workspace_return_fingerprint(
    transport: &dyn Transport,
    remote_cwd: &str,
    excludes: &[String],
    owner: Option<&str>,
) -> Result<WorkspaceFingerprint, WorkspaceError> {
    let probe = tempfile::Builder::new()
        .prefix("beam-wsverify-")
        .tempdir()?;
    let owned = owner.map(|owner_bytes| OwnedWorkspace {
        root: remote_cwd,
        owner_bytes,
    });
    transport
        .sync_down(
            remote_cwd,
            probe.path(),
            SyncOptions {
                excludes,
                checksum: true,
                owned,
                ..SyncOptions::default()
            },
        )
        .await?;
    workspace_return_fingerprint(probe.path())
}

pub async fn assert_workspace_return_unchanged(
    transport: &dyn Transport,
    remote_cwd: &str,
    pinned: &WorkspaceFingerprint,
    options: ReturnUnchangedOptions<'_>,
) -> Result<(), WorkspaceError> {
    let current =
        remote_workspace_return_fingerprint(transport, remote_cwd, options.excludes, options.owner)
            .await?;
    if current == *pinned {
        return Ok(());
    }
    Err(WorkspaceError::message(format!(
        "beam down: the remote workspace changed {} (fingerprint {} -> {}) — a background process \
         is still writing to it. Refusing to continue past an unstable remote; it is intact, new \
         work included. Stop the remote writer (or just retry beam down to collect the newer state)",
        options.when,
        short_digest(&pinned.digest),
        short_digest(&current.digest)
    )))
}

pub struct ReturnUnchangedOptions<'a> {
    pub excludes: &'a [String],
    pub when: &'a str,
    pub owner: Option<&'a str>,
}

pub async fn stage_workspace_ship(
    local_cwd: &Path,
    excludes: &[String],
    verbose: bool,
) -> Result<StagedWorkspaceShip, WorkspaceError> {
    let temporary = tempfile::Builder::new()
        .prefix("beam-shipstage-")
        .tempdir()?;
    let directory = fs::canonicalize(temporary.path())?;
    let transport = LocalTransport::system_default()?;
    stage_ship_pass(&transport, local_cwd, &directory, excludes, verbose, false).await?;
    let first = workspace_return_fingerprint(&directory)?;
    stage_ship_pass(&transport, local_cwd, &directory, excludes, verbose, true).await?;
    let second = workspace_return_fingerprint(&directory)?;
    if first != second {
        return Err(WorkspaceError::message(format!(
            "beam up: the workspace changed while it was being staged for the mirror (fingerprint \
             {} -> {}) — refusing to ship a torn multi-file snapshot. Stop the local writer (or \
             just retry beam up to stage the newer state)",
            short_digest(&first.digest),
            short_digest(&second.digest)
        )));
    }
    Ok(StagedWorkspaceShip {
        directory,
        temporary,
    })
}

pub async fn git_summary(local_cwd: &Path) -> Result<Option<String>, WorkspaceError> {
    let cwd = path_text(local_cwd)?;
    let branch_argv = ["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"];
    let branch = run(&branch_argv, &RunOptions::default()).await?;
    if branch.code != 0 {
        return Ok(None);
    }
    let dirty_argv = ["git", "-C", cwd, "status", "--porcelain"];
    let dirty = run(&dirty_argv, &RunOptions::default()).await?;
    let count = dirty
        .stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count();
    let suffix = if count == 0 {
        String::new()
    } else {
        format!(" (+{count} dirty)")
    };
    Ok(Some(format!("{}{suffix}", branch.stdout.trim())))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedReturnManifest<'a> {
    version: u8,
    record_id: &'a str,
    local_cwd: &'a str,
    remote_cwd: &'a str,
    fingerprint: &'a WorkspaceFingerprint,
    base_workspace_digest: Option<&'a str>,
    excludes: &'a [String],
    mirror_deletes: bool,
    created_at: String,
}

async fn measure_ship_bytes(
    local_cwd: &Path,
    excludes: &[String],
) -> Result<Option<u64>, WorkspaceError> {
    let probe = tempfile::Builder::new()
        .prefix("beam-shipsize-")
        .tempdir()?;
    let source = format!("{}/", path_text(local_cwd)?.trim_end_matches('/'));
    let destination = format!("{}/", path_text(probe.path())?);
    let mut argv = vec![
        "rsync".to_owned(),
        "-a".to_owned(),
        "--dry-run".to_owned(),
        "--stats".to_owned(),
    ];
    argv.extend(
        excludes
            .iter()
            .map(|exclude| format!("--exclude={exclude}")),
    );
    argv.extend(["--".to_owned(), source, destination]);
    let result = run(&argv, &RunOptions::default()).await?;
    if result.code != 0 {
        return Ok(None);
    }
    Ok(parse_total_file_size(&result.stdout))
}

fn parse_total_file_size(output: &str) -> Option<u64> {
    let line = output
        .lines()
        .find(|line| line.contains("Total file size:"))?;
    let (_, rest) = line.split_once("Total file size:")?;
    let token = rest.split_whitespace().next()?;
    let digits: String = token
        .chars()
        .filter(|character| !matches!(character, ',' | '.'))
        .collect();
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

async fn largest_workspace_entries(local_cwd: &Path) -> Result<String, WorkspaceError> {
    let mut entries = fs::read_dir(local_cwd)?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name())
        .filter(|name| name != BEAM_RESERVED_DIR)
        .collect::<Vec<_>>();
    if entries.is_empty() {
        return Ok(String::new());
    }
    entries.sort();
    let mut argv = vec!["du".to_owned(), "-sk".to_owned(), "--".to_owned()];
    argv.extend(
        entries
            .iter()
            .map(|entry| entry.to_string_lossy().into_owned()),
    );
    let options = RunOptions {
        cwd: Some(local_cwd),
        ..RunOptions::default()
    };
    let result = run(&argv, &options).await?;
    if result.code != 0 && result.stdout.is_empty() {
        return Ok(String::new());
    }
    Ok(format_largest_entries(&result.stdout))
}

fn format_largest_entries(output: &str) -> String {
    let mut entries = output
        .lines()
        .filter_map(|line| {
            let (size, name) = line.split_once(char::is_whitespace)?;
            let kib = size.parse::<u64>().ok()?;
            Some((name.trim().to_owned(), kib.saturating_mul(1024)))
        })
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    entries
        .into_iter()
        .take(MAX_SHIP_OFFENDERS)
        .map(|(name, bytes)| format!("{name} {}", format_bytes(bytes)))
        .collect::<Vec<_>>()
        .join(", ")
}

async fn stage_ship_pass(
    transport: &LocalTransport,
    source: &Path,
    destination: &Path,
    excludes: &[String],
    verbose: bool,
    checksum: bool,
) -> Result<(), WorkspaceError> {
    let destination = path_text(destination)?;
    transport
        .sync_up(
            source,
            destination,
            SyncOptions {
                excludes,
                delete: true,
                checksum,
                verbose,
                ..SyncOptions::default()
            },
        )
        .await?;
    Ok(())
}

fn assert_no_tracked_reserved(output: &str) -> Result<(), WorkspaceError> {
    for path in output.split('\0') {
        let top = path.split('/').next().unwrap_or("");
        if top.eq_ignore_ascii_case(BEAM_RESERVED_DIR) {
            return Err(reserved_collision(&format!(
                "this repository tracks '{path}'"
            )));
        }
    }
    Ok(())
}

fn reserved_collision(what: &str) -> WorkspaceError {
    WorkspaceError::message(format!(
        "beam up: {what} — beam reserves '.beam' (in any ASCII case) at the workspace root for \
         handoff metadata, and the mirror would silently omit it. Move it aside (e.g. rename it to \
         'beam-local') and retry"
    ))
}

fn create_private_directory(path: &Path) -> Result<(), WorkspaceError> {
    let mut builder = DirBuilder::new();
    builder.mode(0o700);
    builder.create(path)?;
    Ok(())
}

fn short_digest(digest: &str) -> &str {
    digest.get(..12).unwrap_or(digest)
}

fn path_text(path: &Path) -> Result<&str, WorkspaceError> {
    path.to_str().ok_or_else(|| {
        WorkspaceError::message(format!("beam: path is not valid UTF-8: {}", path.display()))
    })
}

fn utc_stamp(now: SystemTime) -> Result<String, WorkspaceError> {
    let duration = now.duration_since(UNIX_EPOCH).map_err(|source| {
        WorkspaceError::caused_by(
            "beam: system clock predates the Unix epoch".to_owned(),
            source,
        )
    })?;
    let seconds = duration.as_secs();
    let days = seconds / 86_400;
    let day_seconds = seconds % 86_400;
    let (year, month, day) = civil_from_days(days)?;
    let hour = day_seconds / 3_600;
    let minute = (day_seconds % 3_600) / 60;
    let second = day_seconds % 60;
    Ok(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}-{minute:02}-{second:02}-{:03}Z",
        duration.subsec_millis()
    ))
}

fn civil_from_days(days_since_epoch: u64) -> Result<(i64, u64, u64), WorkspaceError> {
    let days = i64::try_from(days_since_epoch).map_err(|_| {
        WorkspaceError::message("beam: system clock exceeds the supported UTC range".to_owned())
    })?;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    Ok((year, month as u64, day as u64))
}
