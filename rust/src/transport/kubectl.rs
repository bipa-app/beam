//! Kubernetes exec transport with verified tar archives and pinned path proofs.
//!
//! Control-plane commands use a random exit-status trailer so a remote nonzero
//! result cannot be confused with an API or exec-stream failure. Bulk streams
//! are size-and-sha256 verified before extraction and retried within one bound.

mod archive;
mod protocol;

use std::path::Path;

use crate::transport::{
    ExecResult, SyncOptions, Transport, TransportError, TransportFuture, checked_exec_result,
};
use crate::util::shell::{RunOptions, run, shq, shq_remote_path};
pub use archive::{ArchiveReceipt, archive_receipt_script, parse_archive_receipt};
pub use protocol::{
    MarkerWalkMode, SyncMarker, marker_walk_blocks, pin_remote_dir_script, remote_path_setup,
    sync_marker_for,
};

use protocol::{
    MarkerWalkMode as WalkMode, owned_marker_shell, owned_rel_from_root, owned_root_guard_script,
};

pub struct KubectlCoords {
    pub context: String,
    pub namespace: String,
    pub container: String,
    pub kubeconfig: Option<String>,
}

pub struct KubectlTransport {
    coords: KubectlCoords,
    pod: String,
    binary: String,
    label: String,
    #[cfg(test)]
    command_environment: Option<std::collections::BTreeMap<String, String>>,
}

struct LicenseProbe {
    valid: bool,
    missing: bool,
    marker: SyncMarker,
}

impl KubectlTransport {
    pub fn new(coords: KubectlCoords, pod: impl Into<String>) -> Self {
        Self::with_binary(coords, pod, "kubectl")
    }

    pub fn with_binary(
        coords: KubectlCoords,
        pod: impl Into<String>,
        binary: impl Into<String>,
    ) -> Self {
        let pod = pod.into();
        let label = format!("k8s {}/{}", coords.namespace, pod);
        Self {
            coords,
            pod,
            binary: binary.into(),
            label,
            #[cfg(test)]
            command_environment: None,
        }
    }

    fn process_options(&self, interactive: bool) -> RunOptions<'_> {
        RunOptions {
            #[cfg(test)]
            base_env: self.command_environment.as_ref(),
            interactive,
            ..RunOptions::default()
        }
    }

    fn base_argv(&self) -> Vec<String> {
        let mut argv = vec![
            self.binary.clone(),
            "--context".to_owned(),
            self.coords.context.clone(),
            "--namespace".to_owned(),
            self.coords.namespace.clone(),
        ];
        if let Some(kubeconfig) = &self.coords.kubeconfig {
            argv.extend(["--kubeconfig".to_owned(), kubeconfig.clone()]);
        }
        argv
    }

    fn exec_argv(&self, command: &str, tty: bool, stdin: bool) -> Vec<String> {
        let mut argv = self.base_argv();
        argv.push("exec".to_owned());
        if tty {
            argv.push("-it".to_owned());
        } else if stdin {
            argv.push("-i".to_owned());
        }
        argv.extend([
            self.pod.clone(),
            "-c".to_owned(),
            self.coords.container.clone(),
            "--".to_owned(),
            "bash".to_owned(),
            "-c".to_owned(),
            command.to_owned(),
        ]);
        argv
    }

    async fn exec_result(&self, command: &str) -> Result<ExecResult, TransportError> {
        let mut nonce = [0_u8; 8];
        getrandom::fill(&mut nonce).map_err(|source| {
            TransportError::message(format!("could not generate kubectl exec nonce: {source}"))
        })?;
        let trailer = format!("__beam_rc_{}:", hex::encode(nonce));
        let wrapped = format!(
            "(\n{command}\n)\n__beam_rc=$?\nprintf '\\n%s%d\\n' {} \
             \"$__beam_rc\"\nexit 0",
            shq(&trailer)
        );
        let argv = self.exec_argv(&wrapped, false, false);
        let result = run(&argv, &self.process_options(false))
            .await
            .map_err(TransportError::from)?;
        if result.code != 0 {
            return Err(self.kubectl_failure(command, result));
        }
        self.parse_exec_trailer(command, trailer, result)
    }

    fn kubectl_failure(&self, command: &str, result: ExecResult) -> TransportError {
        let detail = if result.stderr.is_empty() {
            result.stdout.trim()
        } else {
            result.stderr.trim()
        };
        let suffix = if detail.is_empty() {
            String::new()
        } else {
            format!("\n{detail}")
        };
        TransportError::message(format!(
            "[{}] kubectl exec failed before the remote exit status could be read \
             (kubectl exit {}) running: {command}{suffix}",
            self.label, result.code
        ))
    }

    fn parse_exec_trailer(
        &self,
        command: &str,
        trailer: String,
        result: ExecResult,
    ) -> Result<ExecResult, TransportError> {
        let marker = format!("\n{trailer}");
        let parsed = result
            .stdout
            .strip_suffix('\n')
            .and_then(|without_newline| {
                without_newline.rfind(&marker).map(|index| {
                    let digits = &without_newline[index + marker.len()..];
                    (index, digits)
                })
            });
        let code = parsed.and_then(|(_, digits)| {
            if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            digits.parse::<u16>().ok().filter(|value| *value <= 255)
        });
        let Some(code) = code else {
            return Err(self.malformed_exec(command, result.stderr));
        };
        let index = parsed.expect("a parsed code requires a parsed trailer").0;
        Ok(ExecResult {
            code: i32::from(code),
            stdout: result.stdout[..index].to_owned(),
            stderr: result.stderr,
        })
    }

    fn malformed_exec(&self, command: &str, stderr: String) -> TransportError {
        let detail = stderr.trim();
        let suffix = if detail.is_empty() {
            String::new()
        } else {
            format!("\n{detail}")
        };
        TransportError::message(format!(
            "[{}] kubectl exec exited 0 but the remote exit-status trailer is missing or \
             malformed — output stream truncated or the remote shell never ran; treating as a \
             transport failure: {command}{suffix}",
            self.label
        ))
    }

    async fn sync_up_result(
        &self,
        local_dir: &Path,
        remote_dir: &str,
        options: SyncOptions<'_>,
    ) -> Result<(), TransportError> {
        if options.delete {
            return Err(TransportError::message(format!(
                "[{}] syncUp cannot mirror deletions into {remote_dir}: kubectl tar ships do not \
                 implement rsync's exclude-protected deletion — ship additively into a fresh \
                 owned path instead",
                self.label
            )));
        }
        let marker = sync_marker_for(remote_dir);
        if let Some(owned) = options.owned {
            owned_rel_from_root(remote_dir, owned)?;
        }
        let owned_marker = options
            .owned
            .map(|owned| owned_marker_shell(&marker, owned))
            .transpose()?;
        let pin_create = pin_remote_dir_script(remote_dir, true)?;
        let pin_existing = pin_remote_dir_script(remote_dir, false)?;
        let pin_marker_root = pin_remote_dir_script(&marker.root, false)?;
        self.invalidate_license(
            &marker,
            owned_marker.as_deref(),
            &pin_create,
            &pin_marker_root,
        )
        .await?;
        self.sync_up_ship_staged(local_dir, remote_dir, &pin_existing, &options)
            .await?;
        if options.license {
            self.earn_license(&marker, owned_marker.as_deref(), &pin_marker_root)
                .await?;
        }
        Ok(())
    }

    async fn invalidate_license(
        &self,
        marker: &SyncMarker,
        owned_marker: Option<&str>,
        pin_create: &str,
        pin_marker_root: &str,
    ) -> Result<(), TransportError> {
        let remove = format!("rm -f -- {}", shq(&marker.file));
        let shell = if let Some(owned_marker) = owned_marker {
            format!("{owned_marker}\n{remove}")
        } else {
            let mut steps = vec![pin_create.to_owned(), pin_marker_root.to_owned()];
            steps.extend(marker_walk_blocks(WalkMode::Invalidate));
            steps.push(remove);
            steps.join("\n")
        };
        self.exec_checked_result(&shell).await?;
        Ok(())
    }

    async fn earn_license(
        &self,
        marker: &SyncMarker,
        owned_marker: Option<&str>,
        pin_marker_root: &str,
    ) -> Result<(), TransportError> {
        let file = shq(&marker.file);
        let mut steps = if let Some(owned_marker) = owned_marker {
            vec![owned_marker.to_owned()]
        } else {
            let mut guard = vec![pin_marker_root.to_owned()];
            guard.extend(marker_walk_blocks(WalkMode::Create));
            guard
        };
        steps.extend(self.earn_license_steps(marker, &file));
        self.exec_checked_result(&steps.join("\n")).await?;
        Ok(())
    }

    fn earn_license_steps(&self, marker: &SyncMarker, file: &str) -> [String; 6] {
        let refuse =
            shq("beam: the mirror-license marker is a symlink — refusing to write through it");
        let cannot_earn = shq("beam: could not earn the mirror license");
        let cannot_chmod = shq("beam: could not set the mirror-license mode");
        let mode_unverified = shq("beam: the mirror-license mode did not verify");
        [
            format!("if [ -L {file} ]; then echo {refuse} >&2; exit 62; fi"),
            format!("rm -f -- {file}"),
            format!(
                "(set -C; printf '%s' {} > {file}) 2>/dev/null || {{ echo {cannot_earn} >&2; \
                 exit 63; }}",
                shq(&marker.content)
            ),
            format!(
                "if [ -L {file} ] || [ ! -f {file} ]; then echo {cannot_earn} >&2; \
                 exit 63; fi"
            ),
            format!("chmod 600 {file} || {{ echo {cannot_chmod} >&2; exit 63; }}"),
            format!(
                "[ -n \"$(find {file} -prune -perm 600)\" ] || {{ echo {mode_unverified} >&2; \
                 exit 63; }}"
            ),
        ]
    }

    async fn probe_license(&self, remote_dir: &str) -> Result<LicenseProbe, TransportError> {
        let marker = sync_marker_for(remote_dir);
        let mut steps = vec![pin_remote_dir_script(&marker.root, false)?];
        steps.extend(marker_walk_blocks(WalkMode::Probe));
        steps.push(format!("cat {}", shq(&marker.file)));
        let probe = self.exec_result(&steps.join("\n")).await?;
        Ok(LicenseProbe {
            valid: probe.code == 0 && probe.stdout == marker.content,
            missing: probe.code != 0,
            marker,
        })
    }

    async fn sync_down_result(
        &self,
        remote_dir: &str,
        local_dir: &Path,
        options: SyncOptions<'_>,
    ) -> Result<(), TransportError> {
        let root_guard = options
            .owned
            .map(|owned| owned_root_guard_script(remote_dir, owned))
            .transpose()?;
        let pin_existing = pin_remote_dir_script(remote_dir, false)?;
        if options.delete {
            self.require_mirror_license(remote_dir).await?;
        }
        std::fs::create_dir_all(local_dir).map_err(|source| {
            TransportError::caused_by(
                format!(
                    "could not create local sync directory {}",
                    local_dir.display()
                ),
                source,
            )
        })?;
        self.sync_down_staged(
            remote_dir,
            local_dir,
            &pin_existing,
            root_guard.as_deref(),
            &options,
        )
        .await
    }

    async fn require_mirror_license(&self, remote_dir: &str) -> Result<(), TransportError> {
        let probe = self.probe_license(remote_dir).await?;
        if probe.valid {
            return Ok(());
        }
        let cause = if probe.missing {
            "missing"
        } else {
            "not this destination's license"
        };
        Err(TransportError::message(format!(
            "[{}] refusing to mirror deletions from {remote_dir}: the mirror license {}/{} is \
             {cause} — only a destination a successful licensed beam syncUp shipped can mirror \
             back with delete",
            self.label, probe.marker.root, probe.marker.rel
        )))
    }

    async fn exec_checked_result(&self, command: &str) -> Result<String, TransportError> {
        let result = self.exec_result(command).await?;
        checked_exec_result(&self.label, command, result)
    }
}

impl Transport for KubectlTransport {
    fn label(&self) -> &str {
        &self.label
    }

    fn exec<'a>(&'a self, command: &'a str) -> TransportFuture<'a, ExecResult> {
        Box::pin(self.exec_result(command))
    }

    fn exec_checked<'a>(&'a self, command: &'a str) -> TransportFuture<'a, String> {
        Box::pin(self.exec_checked_result(command))
    }

    fn sync_up<'a>(
        &'a self,
        local_dir: &'a Path,
        remote_dir: &'a str,
        options: SyncOptions<'a>,
    ) -> TransportFuture<'a, ()> {
        Box::pin(self.sync_up_result(local_dir, remote_dir, options))
    }

    fn sync_down<'a>(
        &'a self,
        remote_dir: &'a str,
        local_dir: &'a Path,
        options: SyncOptions<'a>,
    ) -> TransportFuture<'a, ()> {
        Box::pin(self.sync_down_result(remote_dir, local_dir, options))
    }

    fn exists<'a>(&'a self, remote_path: &'a str) -> TransportFuture<'a, bool> {
        Box::pin(async move {
            let result = self
                .exec_result(&format!("test -e {}", shq_remote_path(remote_path)))
                .await?;
            Ok(result.code == 0)
        })
    }

    fn sync_license<'a>(&'a self, remote_dir: &'a str) -> Option<TransportFuture<'a, bool>> {
        Some(Box::pin(async move {
            Ok(self.probe_license(remote_dir).await?.valid)
        }))
    }

    fn interactive_argv(&self, command: &str) -> Vec<String> {
        self.exec_argv(command, true, false)
    }
}

#[cfg(test)]
mod tests;
