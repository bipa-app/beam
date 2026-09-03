//! Verified archive data plane for the kubectl transport.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use tempfile::{Builder, TempDir};

use super::KubectlTransport;
use super::protocol::{owned_dest_prelude, owned_rel_from_root};
use crate::transport::{SyncOptions, TransportError};
use crate::util::digest::file_sha256;
use crate::util::shell::{run_checked, shjoin, shq};

const SAFE_INTEGER_MAX: u64 = 9_007_199_254_740_991;
const SYNC_ARCHIVE_ATTEMPTS_MAX: usize = 6;
const SYNC_DOWN_ARCHIVE_BYTES_MAX: u64 = 128 * 1024 * 1024 * 1024;

pub struct ArchiveReceipt {
    pub digest: String,
    pub bytes: u64,
}

pub fn parse_archive_receipt(receipt: &str) -> Result<ArchiveReceipt, TransportError> {
    let trimmed = receipt.trim();
    let mut fields = trimmed.split_whitespace();
    let digest = fields.next().unwrap_or_default();
    let bytes_text = fields.next().unwrap_or_default();
    let valid_digest = digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if !valid_digest || bytes_text.is_empty() || fields.next().is_some() {
        return Err(invalid_receipt(trimmed));
    }
    if !bytes_text.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(invalid_receipt(trimmed));
    }
    let bytes = bytes_text
        .parse::<u64>()
        .ok()
        .filter(|value| *value <= SAFE_INTEGER_MAX)
        .ok_or_else(|| {
            TransportError::message(format!(
                "remote sync archive size is invalid: {bytes_text} bytes"
            ))
        })?;
    Ok(ArchiveReceipt {
        digest: digest.to_owned(),
        bytes,
    })
}

fn invalid_receipt(receipt: &str) -> TransportError {
    TransportError::message(format!(
        "remote sync archive returned an invalid receipt: {receipt}"
    ))
}

pub fn archive_receipt_script(remote_archive: &str) -> String {
    format!(
        "printf '%s %s\\n' \"$(sha256sum {} | cut -d ' ' -f1)\" \
         \"$(/usr/bin/wc -c < {})\"",
        shq(remote_archive),
        shq(remote_archive)
    )
}

impl KubectlTransport {
    pub(super) async fn sync_up_ship_staged(
        &self,
        local_dir: &Path,
        remote_dir: &str,
        pin_existing: &str,
        options: &SyncOptions<'_>,
    ) -> Result<(), TransportError> {
        let (temporary, staging, archive) = create_staging("beam-syncup-")?;
        let operation = async {
            self.stage_upload(local_dir, &staging, options).await?;
            let prelude = if let Some(owned) = options.owned {
                owned_dest_prelude(remote_dir, owned, true)?
            } else {
                pin_existing.to_owned()
            };
            let tighten = if let Some(owned) = options.owned {
                !owned_rel_from_root(remote_dir, owned)?.is_empty()
            } else {
                false
            };
            self.upload_archive_verified(&staging, &archive, &prelude, tighten, options.verbose)
                .await
        }
        .await;
        close_temporary(temporary, operation)
    }

    async fn stage_upload(
        &self,
        local_dir: &Path,
        staging: &Path,
        options: &SyncOptions<'_>,
    ) -> Result<(), TransportError> {
        let mut argv = vec![OsString::from("rsync"), OsString::from("-a")];
        if options.verbose {
            argv.push(OsString::from("-v"));
        }
        argv.extend(
            options
                .excludes
                .iter()
                .map(|exclude| OsString::from(format!("--exclude={exclude}"))),
        );
        argv.push(trailing_slash(local_dir));
        argv.push(trailing_slash(staging));
        run_checked(&argv, &self.process_options(options.verbose))
            .await
            .map_err(TransportError::from)?;
        Ok(())
    }

    async fn upload_archive_verified(
        &self,
        staging: &Path,
        local_archive: &Path,
        prelude: &str,
        tighten: bool,
        verbose: bool,
    ) -> Result<(), TransportError> {
        let remote_archive = format!("/tmp/beam-syncup-{}.tar.gz", random_nonce()?);
        let operation = self
            .upload_archive_inner(
                staging,
                local_archive,
                &remote_archive,
                prelude,
                tighten,
                verbose,
            )
            .await;
        let cleanup = self
            .exec_checked_result(&format!("rm -f -- {}", shq(&remote_archive)))
            .await;
        preserve_primary(operation, cleanup.map(|_| ()), "remote archive cleanup")
    }

    async fn upload_archive_inner(
        &self,
        staging: &Path,
        local_archive: &Path,
        remote_archive: &str,
        prelude: &str,
        tighten: bool,
        verbose: bool,
    ) -> Result<(), TransportError> {
        let mut tar = vec![
            OsString::from("tar"),
            OsString::from("-czf"),
            local_archive.as_os_str().to_owned(),
        ];
        if verbose {
            tar.push(OsString::from("-v"));
        }
        tar.extend([
            OsString::from("-C"),
            staging.as_os_str().to_owned(),
            OsString::from("."),
        ]);
        // macOS bsdtar packs every extended attribute (macOS 14+ stamps
        // `com.apple.provenance` on each file a tracked process creates,
        // including the rsync'd staging copies) as an AppleDouble `._name`
        // sibling entry, and its own `tar -t` hides them, so the archive
        // lands with twice the staged entries and the strict mirror proof
        // refuses forever (#37). COPYFILE_DISABLE is bsdtar's documented
        // off switch and inert for GNU tar.
        let mut options = self.process_options(verbose);
        let archive_env = BTreeMap::from([("COPYFILE_DISABLE".to_owned(), "1".to_owned())]);
        options.env = Some(&archive_env);
        run_checked(&tar, &options)
            .await
            .map_err(TransportError::from)?;
        let expected_bytes = archive_bytes(local_archive)?;
        let expected_digest = archive_digest(local_archive)?;
        self.upload_archive_attempts(
            local_archive,
            remote_archive,
            expected_bytes,
            &expected_digest,
        )
        .await?;
        let tighten = if tighten {
            "\nchmod 700 . || { echo 'beam: cannot restore the reserved dir mode' >&2; exit 66; }\n\
             [ -n \"$(find . -prune -perm 700)\" ] || { echo 'beam: the reserved dir mode did \
             not verify' >&2; exit 66; }"
        } else {
            ""
        };
        let extract = format!(
            "set -e\n{prelude}\n/usr/bin/tar -xzf {} -C .{tighten}",
            shq(remote_archive)
        );
        self.exec_checked_result(&extract).await?;
        Ok(())
    }

    async fn upload_archive_attempts(
        &self,
        local_archive: &Path,
        remote_archive: &str,
        expected_bytes: u64,
        expected_digest: &str,
    ) -> Result<(), TransportError> {
        let mut last_failure = "no upload attempt completed".to_owned();
        for attempt in 1..=SYNC_ARCHIVE_ATTEMPTS_MAX {
            let producer = vec![
                "cat".to_owned(),
                local_archive.to_string_lossy().into_owned(),
            ];
            let consumer = self.exec_argv(&format!("cat > {}", shq(remote_archive)), false, true);
            if let Err(error) = self.pipeline(&producer, &consumer, false).await {
                last_failure = format!("attempt {attempt}: {error}");
                continue;
            }
            let receipt = self
                .exec_checked_result(&archive_receipt_script(remote_archive))
                .await?;
            let landed = parse_archive_receipt(&receipt)?;
            if landed.bytes != expected_bytes {
                last_failure = format!(
                    "attempt {attempt}: expected {expected_bytes} bytes, got {}",
                    landed.bytes
                );
                continue;
            }
            if landed.digest != expected_digest {
                last_failure = format!(
                    "attempt {attempt}: expected sha256 {expected_digest}, got {}",
                    landed.digest
                );
                continue;
            }
            return Ok(());
        }
        Err(TransportError::message(format!(
            "remote sync archive failed {SYNC_ARCHIVE_ATTEMPTS_MAX} verified uploads: \
             {last_failure}"
        )))
    }

    pub(super) async fn sync_down_staged(
        &self,
        remote_dir: &str,
        local_dir: &Path,
        pin_existing: &str,
        root_guard: Option<&str>,
        options: &SyncOptions<'_>,
    ) -> Result<(), TransportError> {
        let (temporary, staging, archive) = create_staging("beam-syncdown-")?;
        let operation = async {
            let prelude = if let Some(owned) = options.owned {
                owned_dest_prelude(remote_dir, owned, false)?
            } else {
                pin_existing.to_owned()
            };
            self.extract_remote_archive(&prelude, &staging, &archive, options.verbose)
                .await?;
            if let Some(root_guard) = root_guard {
                self.exec_checked_result(root_guard).await?;
            }
            self.apply_download(&staging, local_dir, options).await
        }
        .await;
        close_temporary(temporary, operation)
    }

    async fn extract_remote_archive(
        &self,
        prelude: &str,
        staging: &Path,
        local_archive: &Path,
        verbose: bool,
    ) -> Result<(), TransportError> {
        let remote_archive = format!("/tmp/beam-syncdown-{}.tar.gz", random_nonce()?);
        let operation = self
            .extract_remote_archive_inner(prelude, staging, local_archive, &remote_archive, verbose)
            .await;
        let cleanup = self
            .exec_checked_result(&format!("rm -f -- {}", shq(&remote_archive)))
            .await;
        preserve_primary(operation, cleanup.map(|_| ()), "remote archive cleanup")
    }

    async fn extract_remote_archive_inner(
        &self,
        prelude: &str,
        staging: &Path,
        local_archive: &Path,
        remote_archive: &str,
        verbose: bool,
    ) -> Result<(), TransportError> {
        let receipt = self
            .exec_checked_result(&format!(
                "{prelude}\n/usr/bin/tar -czf {} -C . .\n{}",
                shq(remote_archive),
                archive_receipt_script(remote_archive)
            ))
            .await?;
        let staged = parse_archive_receipt(&receipt)?;
        if staged.bytes > SYNC_DOWN_ARCHIVE_BYTES_MAX {
            return Err(TransportError::message(format!(
                "remote sync archive size is invalid: {} bytes",
                staged.bytes
            )));
        }
        self.download_archive_attempts(local_archive, remote_archive, staged.bytes, &staged.digest)
            .await?;
        let mut tar = vec![
            OsString::from("tar"),
            OsString::from("-xzf"),
            local_archive.as_os_str().to_owned(),
        ];
        if verbose {
            tar.push(OsString::from("-v"));
        }
        tar.extend([OsString::from("-C"), staging.as_os_str().to_owned()]);
        run_checked(&tar, &self.process_options(verbose))
            .await
            .map_err(TransportError::from)?;
        Ok(())
    }

    async fn download_archive_attempts(
        &self,
        local_archive: &Path,
        remote_archive: &str,
        expected_bytes: u64,
        expected_digest: &str,
    ) -> Result<(), TransportError> {
        let mut last_failure = "no download attempt completed".to_owned();
        for attempt in 1..=SYNC_ARCHIVE_ATTEMPTS_MAX {
            if let Err(source) = fs::remove_file(local_archive)
                && source.kind() != std::io::ErrorKind::NotFound
            {
                return Err(TransportError::caused_by(
                    format!("could not clear staged archive {}", local_archive.display()),
                    source,
                ));
            }
            let producer = self.exec_argv(&format!("cat {}", shq(remote_archive)), false, false);
            let consumer = vec![
                "bash".to_owned(),
                "-c".to_owned(),
                format!("cat > {}", shq(&local_archive.to_string_lossy())),
            ];
            if let Err(error) = self.pipeline(&producer, &consumer, false).await {
                last_failure = format!("attempt {attempt}: {error}");
                continue;
            }
            let actual_bytes = archive_bytes(local_archive)?;
            if actual_bytes != expected_bytes {
                last_failure = format!(
                    "attempt {attempt}: expected {expected_bytes} bytes, got {actual_bytes}"
                );
                continue;
            }
            let actual_digest = archive_digest(local_archive)?;
            if actual_digest != expected_digest {
                last_failure = format!(
                    "attempt {attempt}: expected sha256 {expected_digest}, got {actual_digest}"
                );
                continue;
            }
            return Ok(());
        }
        Err(TransportError::message(format!(
            "remote sync archive failed {SYNC_ARCHIVE_ATTEMPTS_MAX} verified downloads: \
             {last_failure}"
        )))
    }

    async fn apply_download(
        &self,
        staging: &Path,
        local_dir: &Path,
        options: &SyncOptions<'_>,
    ) -> Result<(), TransportError> {
        let mut argv = vec![OsString::from("rsync"), OsString::from("-a")];
        if options.delete {
            argv.push(OsString::from("--delete"));
        }
        if options.checksum {
            argv.push(OsString::from("--checksum"));
        }
        argv.extend(
            options
                .excludes
                .iter()
                .map(|exclude| OsString::from(format!("--exclude={exclude}"))),
        );
        argv.extend([trailing_slash(staging), trailing_slash(local_dir)]);
        run_checked(&argv, &self.process_options(options.verbose))
            .await
            .map_err(TransportError::from)?;
        Ok(())
    }

    async fn pipeline(
        &self,
        producer: &[String],
        consumer: &[String],
        interactive: bool,
    ) -> Result<(), TransportError> {
        let producer_refs = producer.iter().map(String::as_str).collect::<Vec<_>>();
        let consumer_refs = consumer.iter().map(String::as_str).collect::<Vec<_>>();
        let command = format!(
            "set -o pipefail; {} | {}",
            shjoin(&producer_refs),
            shjoin(&consumer_refs)
        );
        let argv = ["bash".to_owned(), "-c".to_owned(), command];
        run_checked(&argv, &self.process_options(interactive))
            .await
            .map_err(TransportError::from)?;
        Ok(())
    }
}

fn create_staging(prefix: &str) -> Result<(TempDir, PathBuf, PathBuf), TransportError> {
    let temporary = Builder::new().prefix(prefix).tempdir().map_err(|source| {
        TransportError::caused_by(
            format!("could not create {prefix} temporary directory"),
            source,
        )
    })?;
    let staging = temporary.path().join("stage");
    fs::create_dir(&staging).map_err(|source| {
        TransportError::caused_by(
            format!("could not create staging directory {}", staging.display()),
            source,
        )
    })?;
    let archive = temporary.path().join("archive.tar.gz");
    Ok((temporary, staging, archive))
}

fn close_temporary<T>(
    temporary: TempDir,
    operation: Result<T, TransportError>,
) -> Result<T, TransportError> {
    let cleanup = temporary.close().map_err(|source| {
        TransportError::caused_by(
            "could not remove kubectl sync staging directory".to_owned(),
            source,
        )
    });
    preserve_primary(operation, cleanup, "local staging cleanup")
}

fn preserve_primary<T>(
    operation: Result<T, TransportError>,
    cleanup: Result<(), TransportError>,
    cleanup_name: &str,
) -> Result<T, TransportError> {
    match (operation, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Ok(_), Err(cleanup)) => Err(cleanup),
        (Err(primary), Ok(())) => Err(primary),
        (Err(primary), Err(cleanup)) => Err(TransportError::message(format!(
            "{primary}\n{cleanup_name} also failed: {cleanup}"
        ))),
    }
}

fn archive_bytes(path: &Path) -> Result<u64, TransportError> {
    fs::metadata(path)
        .map(|metadata| metadata.len())
        .map_err(|source| {
            TransportError::caused_by(
                format!("could not stat staged archive {}", path.display()),
                source,
            )
        })
}

fn archive_digest(path: &Path) -> Result<String, TransportError> {
    file_sha256(path).map_err(|source| {
        TransportError::caused_by(
            format!("could not hash staged archive {}", path.display()),
            source,
        )
    })
}

fn random_nonce() -> Result<String, TransportError> {
    let mut nonce = [0_u8; 16];
    getrandom::fill(&mut nonce).map_err(|source| {
        TransportError::message(format!(
            "could not generate kubectl archive nonce: {source}"
        ))
    })?;
    Ok(hex::encode(nonce))
}

fn trailing_slash(path: &Path) -> OsString {
    let mut value = path.as_os_str().to_owned();
    value.push("/");
    value
}
