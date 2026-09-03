//! SSH transport over explicit `ssh` and `rsync` argv.
//!
//! The data plane enters and proves the remote directory inside rsync's own
//! SSH process. No separate guard connection can race a path replacement.

use std::ffi::OsString;
use std::path::Path;

use crate::transport::{
    ExecResult, OwnedWorkspace, SyncOptions, Transport, TransportError, TransportFuture,
    checked_exec_result,
};
use crate::util::shell::{RunOptions, run, run_checked, shjoin, shq, shq_remote_path};
use crate::workspace::owned_destination_script;

const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DEFAULT_RSYNC_FLAGS: [&str; 2] = ["-a", "-z"];

#[derive(Default)]
pub struct SshTransportOptions {
    /// Override rsync's default archive and compression flags.
    pub rsync_flags: Option<Vec<String>>,
    /// Provider-owned SSH argv inserted before the destination.
    pub ssh_options: Vec<String>,
    /// Provider-facing label when the address is an implementation detail.
    pub label: Option<String>,
}

pub struct SshTransport {
    host: String,
    label: String,
    rsync_flags: Vec<String>,
    ssh_options: Vec<String>,
    #[cfg(test)]
    command_environment: Option<std::collections::BTreeMap<String, String>>,
}

impl SshTransport {
    pub fn new(host: impl Into<String>) -> Result<Self, TransportError> {
        Self::with_options(host, SshTransportOptions::default())
    }

    pub fn with_options(
        host: impl Into<String>,
        options: SshTransportOptions,
    ) -> Result<Self, TransportError> {
        let host = host.into();
        if host.is_empty() {
            return Err(TransportError::message(
                "beam: ssh host is empty — set the target's host to an ssh destination \
                 (host, user@host, or a ~/.ssh/config alias)"
                    .to_owned(),
            ));
        }
        if host.starts_with('-') {
            let rendered = serde_json::to_string(&host)
                .expect("a Rust string always serializes as valid JSON");
            return Err(TransportError::message(format!(
                "beam: ssh host {rendered} starts with '-' and would be read as an ssh option, \
                 not a destination — use a plain host, user@host, or a ~/.ssh/config alias"
            )));
        }
        let label = options.label.unwrap_or_else(|| format!("ssh {host}"));
        let rsync_flags = options.rsync_flags.unwrap_or_else(|| {
            DEFAULT_RSYNC_FLAGS
                .iter()
                .map(|flag| (*flag).to_owned())
                .collect()
        });
        Ok(Self {
            host,
            label,
            rsync_flags,
            ssh_options: options.ssh_options,
            #[cfg(test)]
            command_environment: None,
        })
    }

    #[cfg(test)]
    pub(crate) fn set_command_environment(
        &mut self,
        environment: std::collections::BTreeMap<String, String>,
    ) {
        self.command_environment = Some(environment);
    }

    fn process_options(&self, interactive: bool) -> RunOptions<'_> {
        RunOptions {
            #[cfg(test)]
            base_env: self.command_environment.as_ref(),
            interactive,
            ..RunOptions::default()
        }
    }

    fn pinned_walk_script(create: bool) -> String {
        let verb = if create { "create" } else { "enter" };
        let missing_exit = if create { 46 } else { 47 };
        let mut lines = vec![
            "case \"$__beam_expected\" in /?*) ;; *) echo \
             \"beam: remote path is not absolute: $__beam_expected\" >&2; exit 62;; esac"
                .to_owned(),
            "cd / || exit 47".to_owned(),
            "__beam_path=".to_owned(),
            "__beam_ifs=\"${IFS-}\"; IFS=/; set -f".to_owned(),
            "for __beam_seg in ${__beam_expected#/}; do".to_owned(),
            "  set +f; IFS=\"$__beam_ifs\"".to_owned(),
            "  case \"$__beam_seg\" in ''|.|..) echo \
             \"beam: suspicious path segment in $__beam_expected\" >&2; exit 44 ;; esac"
                .to_owned(),
            "  __beam_path=\"$__beam_path/$__beam_seg\"".to_owned(),
            "  if [ -L \"./$__beam_seg\" ]; then echo \
             \"beam: refusing to sync through symlinked path: $__beam_path\" >&2; exit 61; fi"
                .to_owned(),
        ];
        if create {
            lines.push(
                "  if [ ! -e \"./$__beam_seg\" ]; then mkdir -- \"./$__beam_seg\" \
                 2>/dev/null || true; fi"
                    .to_owned(),
            );
        }
        lines.extend([
            "  if [ -L \"./$__beam_seg\" ]; then echo \
             \"beam: refusing to sync through symlinked path: $__beam_path\" >&2; exit 61; fi"
                .to_owned(),
            format!(
                "  if [ ! -e \"./$__beam_seg\" ]; then echo \
                 \"beam: cannot {verb} workspace $__beam_path\" >&2; exit {missing_exit}; fi"
            ),
            "  cd -- \"./$__beam_seg\" 2>/dev/null || { echo \
             \"beam: cannot enter workspace $__beam_path\" >&2; exit 47; }"
                .to_owned(),
            "  if [ \"$(/bin/pwd -P)\" != \"$__beam_path\" ]; then echo \
             \"beam: workspace $__beam_path physically resolves to $(/bin/pwd -P) — refusing\" \
             >&2; exit 48; fi"
                .to_owned(),
            "done".to_owned(),
            "set +f; IFS=\"$__beam_ifs\"".to_owned(),
            "if [ \"$(/bin/pwd -P)\" != \"$__beam_expected\" ]; then echo \
             \"beam: workspace $__beam_expected physically resolves to $(/bin/pwd -P) — refusing\" \
             >&2; exit 48; fi"
                .to_owned(),
        ]);
        lines.join("\n")
    }

    fn owned_rsync_entry(
        remote_dir: &str,
        owned: OwnedWorkspace<'_>,
        create: bool,
    ) -> Result<(String, bool), TransportError> {
        let relative_text = if remote_dir == owned.root {
            ""
        } else if let Some(relative) = remote_dir
            .strip_prefix(owned.root)
            .and_then(|relative| relative.strip_prefix('/'))
        {
            relative
        } else {
            return Err(TransportError::message(format!(
                "beam: sync destination {remote_dir} is not under its owned workspace {} — refusing",
                owned.root
            )));
        };
        let relative = if relative_text.is_empty() {
            Vec::new()
        } else {
            relative_text.split('/').collect::<Vec<_>>()
        };
        let owned_script = owned_destination_script(owned.owner_bytes, &relative, create)
            .map_err(|error| TransportError::message(error.to_string()))?;
        let tighten = !relative.is_empty() && create;
        let mut entry = format!(
            "__beam_expected={}\n{}\n{owned_script}",
            shq_remote_path(owned.root),
            Self::pinned_walk_script(false)
        );
        if tighten {
            entry.push_str(
                "\n__beam_od_tighten() { chmod 700 . \
                 && [ -n \"$(find . -prune -perm 700)\" ]; }",
            );
        }
        Ok((entry, tighten))
    }

    fn pinned_rsync_path(
        &self,
        remote_dir: &str,
        create: bool,
        owned: Option<OwnedWorkspace<'_>>,
    ) -> Result<String, TransportError> {
        let (entry, tighten) = if let Some(owned) = owned {
            Self::owned_rsync_entry(remote_dir, owned, create)?
        } else {
            (
                format!(
                    "__beam_expected={}\n{}",
                    shq_remote_path(remote_dir),
                    Self::pinned_walk_script(create)
                ),
                false,
            )
        };
        let script = if tighten {
            format!(
                "{entry}\nrsync \"$@\" <&3\n__beam_rc=$?\n__beam_od_tighten \
                 || {{ echo \"beam: the reserved dir mode did not verify\" >&2; exit 66; }}\n\
                 exit \"$__beam_rc\""
            )
        } else {
            format!("{entry}\nexec rsync \"$@\" <&3")
        };
        let payload = base64_standard(script.as_bytes())?;
        Ok(format!(
            "exec 3<&0; printf %s {payload} | base64 -d | bash -s --"
        ))
    }

    async fn exec_result(&self, command: &str) -> Result<ExecResult, TransportError> {
        let quoted = shq(command);
        let mut argv = Vec::with_capacity(self.ssh_options.len() + 6);
        argv.push("ssh");
        argv.extend(self.ssh_options.iter().map(String::as_str));
        argv.extend([self.host.as_str(), "--", "bash", "-lc", quoted.as_str()]);
        run(&argv, &self.process_options(false))
            .await
            .map_err(TransportError::from)
    }

    async fn rsync(
        &self,
        source: OsString,
        destination: OsString,
        options: &SyncOptions<'_>,
        remote_program: String,
    ) -> Result<(), TransportError> {
        let extra_count = usize::from(options.delete)
            + usize::from(options.checksum)
            + options.excludes.len()
            + 3;
        let mut argv = Vec::with_capacity(self.rsync_flags.len() + extra_count);
        argv.push(OsString::from("rsync"));
        argv.extend(self.rsync_flags.iter().map(OsString::from));
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
        argv.push(OsString::from(format!("--rsync-path={remote_program}")));
        if !self.ssh_options.is_empty() {
            let mut ssh = Vec::with_capacity(self.ssh_options.len() + 1);
            ssh.push("ssh");
            ssh.extend(self.ssh_options.iter().map(String::as_str));
            argv.push(OsString::from(format!("--rsh={}", shjoin(&ssh))));
        }
        argv.extend([source, destination]);
        run_checked(&argv, &self.process_options(options.verbose))
            .await
            .map_err(TransportError::from)?;
        Ok(())
    }
}

impl Transport for SshTransport {
    fn label(&self) -> &str {
        &self.label
    }

    fn exec<'a>(&'a self, command: &'a str) -> TransportFuture<'a, ExecResult> {
        Box::pin(self.exec_result(command))
    }

    fn exec_checked<'a>(&'a self, command: &'a str) -> TransportFuture<'a, String> {
        Box::pin(async move {
            let result = self.exec_result(command).await?;
            checked_exec_result(&self.label, command, result)
        })
    }

    fn sync_up<'a>(
        &'a self,
        local_dir: &'a Path,
        remote_dir: &'a str,
        options: SyncOptions<'a>,
    ) -> TransportFuture<'a, ()> {
        Box::pin(async move {
            let remote_program = self.pinned_rsync_path(remote_dir, true, options.owned)?;
            let mut source = local_dir.as_os_str().to_owned();
            source.push("/");
            let destination = OsString::from(format!("{}:./", self.host));
            self.rsync(source, destination, &options, remote_program)
                .await
        })
    }

    fn sync_down<'a>(
        &'a self,
        remote_dir: &'a str,
        local_dir: &'a Path,
        options: SyncOptions<'a>,
    ) -> TransportFuture<'a, ()> {
        Box::pin(async move {
            let mkdir = [
                OsString::from("mkdir"),
                OsString::from("-p"),
                local_dir.as_os_str().to_owned(),
            ];
            run_checked(&mkdir, &self.process_options(false))
                .await
                .map_err(TransportError::from)?;
            let source = OsString::from(format!("{}:./", self.host));
            let mut destination = local_dir.as_os_str().to_owned();
            destination.push("/");
            let remote_program = self.pinned_rsync_path(remote_dir, false, options.owned)?;
            self.rsync(source, destination, &options, remote_program)
                .await
        })
    }

    fn exists<'a>(&'a self, remote_path: &'a str) -> TransportFuture<'a, bool> {
        Box::pin(async move {
            let probe = format!("test -e {}", shq_remote_path(remote_path));
            let result = self.exec_result(&probe).await?;
            match result.code {
                0 => Ok(true),
                1 => Ok(false),
                code => {
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
                    Err(TransportError::message(format!(
                        "[{}] existence probe did not answer ({code}): {probe}{suffix}",
                        self.label
                    )))
                }
            }
        })
    }

    fn interactive_argv(&self, command: &str) -> Vec<String> {
        let mut argv = Vec::with_capacity(self.ssh_options.len() + 7);
        argv.push("ssh".to_owned());
        argv.extend(self.ssh_options.iter().cloned());
        argv.extend([
            "-t".to_owned(),
            self.host.clone(),
            "--".to_owned(),
            "bash".to_owned(),
            "-lc".to_owned(),
            shq(command),
        ]);
        argv
    }
}

fn base64_standard(input: &[u8]) -> Result<String, TransportError> {
    let groups = input
        .len()
        .checked_add(2)
        .and_then(|length| length.checked_div(3))
        .ok_or_else(|| TransportError::message("beam: SSH guard script is too large".to_owned()))?;
    let capacity = groups
        .checked_mul(4)
        .ok_or_else(|| TransportError::message("beam: SSH guard script is too large".to_owned()))?;
    let mut output = String::with_capacity(capacity);
    for chunk in input.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        output.push(char::from(BASE64_ALPHABET[usize::from(first >> 2)]));
        let second_index = ((first & 0x03) << 4) | (second >> 4);
        output.push(char::from(BASE64_ALPHABET[usize::from(second_index)]));
        if chunk.len() > 1 {
            let third_index = ((second & 0x0f) << 2) | (third >> 6);
            output.push(char::from(BASE64_ALPHABET[usize::from(third_index)]));
        } else {
            output.push('=');
        }
        if chunk.len() > 2 {
            output.push(char::from(BASE64_ALPHABET[usize::from(third & 0x3f)]));
        } else {
            output.push('=');
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests;
