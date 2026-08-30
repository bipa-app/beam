//! Hermetic transport where the target is another directory on this machine.
//! It deliberately uses the same `bash` and `rsync` control/data planes as
//! remote transports, so tests exercise the real shell and trailing-slash
//! transfer semantics.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::transport::{
    ExecResult, OwnedWorkspace, SyncOptions, Transport, TransportError, TransportFuture,
};
use crate::util::shell::{RunOptions, run, run_checked, shq};
use crate::workspace::owned_destination_script;

pub struct LocalTransport {
    label: String,
    home: PathBuf,
    lexical_home: PathBuf,
    lexical_home_text: String,
    environment: BTreeMap<String, String>,
    rsync_flags: Vec<String>,
}

impl LocalTransport {
    pub fn new(home: impl AsRef<Path>) -> Result<Self, TransportError> {
        Self::with_rsync_flags(home, vec!["-a".to_owned()])
    }

    pub fn system_default() -> Result<Self, TransportError> {
        let home = std::env::home_dir().ok_or_else(|| {
            TransportError::message(
                "beam: cannot determine the local transport home — set HOME".to_owned(),
            )
        })?;
        Self::new(home)
    }

    pub fn with_rsync_flags(
        home: impl AsRef<Path>,
        rsync_flags: Vec<String>,
    ) -> Result<Self, TransportError> {
        let lexical_home = lexical_absolute(home.as_ref()).map_err(|source| {
            TransportError::caused_by(
                format!(
                    "beam: could not resolve local transport home {}",
                    home.as_ref().display()
                ),
                source,
            )
        })?;
        let lexical_home_text = path_text(&lexical_home, "local transport home")?;
        let physical_home = fs::canonicalize(home.as_ref()).map_err(|source| {
            TransportError::caused_by(
                format!(
                    "beam: local transport home does not resolve: {lexical_home_text} — \
                     create that directory or point the target's home at an existing one"
                ),
                source,
            )
        })?;
        path_text(&physical_home, "canonical local transport home")?;
        let environment = BTreeMap::from([("HOME".to_owned(), lexical_home_text.clone())]);
        Ok(Self {
            label: format!("local (home={lexical_home_text})"),
            home: physical_home,
            lexical_home,
            environment,
            lexical_home_text,
            rsync_flags,
        })
    }

    pub fn resolve(&self, path: &str) -> Result<PathBuf, TransportError> {
        if path == "~" {
            return Ok(self.home.clone());
        }
        if let Some(relative) = path.strip_prefix("~/") {
            let joined = self.home.join(relative.trim_start_matches('/'));
            return lexical_absolute(&joined).map_err(|source| {
                TransportError::caused_by(
                    format!("beam: could not resolve local transport path {path:?}"),
                    source,
                )
            });
        }
        let absolute = lexical_absolute(Path::new(path)).map_err(|source| {
            TransportError::caused_by(
                format!("beam: could not resolve local transport path {path:?}"),
                source,
            )
        })?;
        if absolute == self.lexical_home {
            return Ok(self.home.clone());
        }
        if let Ok(relative) = absolute.strip_prefix(&self.lexical_home) {
            return Ok(self.home.join(relative));
        }
        Ok(absolute)
    }

    fn rsync_args(&self, options: &SyncOptions<'_>) -> Vec<String> {
        let option_count =
            usize::from(options.delete) + usize::from(options.checksum) + options.excludes.len();
        let mut argv = Vec::with_capacity(self.rsync_flags.len() + option_count + 1);
        argv.push("rsync".to_owned());
        argv.extend(self.rsync_flags.iter().cloned());
        if options.delete {
            argv.push("--delete".to_owned());
        }
        if options.checksum {
            argv.push("--checksum".to_owned());
        }
        argv.extend(
            options
                .excludes
                .iter()
                .map(|exclude| format!("--exclude={exclude}")),
        );
        argv
    }

    async fn create_missing(&self, absolute: &Path) -> Result<(), TransportError> {
        let script = create_walk_blocks(absolute)?.join("\n");
        run_checked(&["bash", "-c", &script], &RunOptions::default())
            .await
            .map_err(TransportError::from)?;
        Ok(())
    }

    fn pinned_directory(&self, directory: &Path) -> Result<PathBuf, TransportError> {
        let absolute = lexical_absolute(directory).map_err(|source| {
            TransportError::caused_by(
                format!("[{}] could not resolve sync path", self.label),
                source,
            )
        })?;
        refuse_symlinked_components(&absolute, &self.label)?;
        let metadata = fs::symlink_metadata(&absolute);
        let metadata = match metadata {
            Ok(metadata) => metadata,
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
                return Err(TransportError::message(format!(
                    "[{}] No such file or directory: {}",
                    self.label,
                    absolute.display()
                )));
            }
            Err(source) => {
                return Err(TransportError::caused_by(
                    format!("[{}] cannot inspect {}", self.label, absolute.display()),
                    source,
                ));
            }
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(TransportError::message(format!(
                "[{}] refusing to sync through non-directory path: {}",
                self.label,
                absolute.display()
            )));
        }
        self.verify_physical_path(&absolute)
    }

    fn verify_physical_path(&self, absolute: &Path) -> Result<PathBuf, TransportError> {
        let physical = fs::canonicalize(absolute).map_err(|source| {
            TransportError::caused_by(
                format!("[{}] cannot resolve {}", self.label, absolute.display()),
                source,
            )
        })?;
        if physical != absolute {
            return Err(TransportError::message(format!(
                "[{}] {} physically resolves to {} — path swapped or symlinked; refusing",
                self.label,
                absolute.display(),
                physical.display()
            )));
        }
        Ok(absolute.to_path_buf())
    }

    async fn rsync_through_pinned_dir(
        &self,
        pinned_dir: &Path,
        argv: Vec<String>,
        options: &SyncOptions<'_>,
        ensure_local_dir: Option<&Path>,
    ) -> Result<(), TransportError> {
        let ensure = match ensure_local_dir {
            Some(path) => format!(
                "mkdir -p -- {} || exit 66; ",
                shq(&path_text(path, "sync path")?)
            ),
            None => String::new(),
        };
        let script = format!(
            "dir=$1; shift; cd -P -- \"$dir\" || exit 66; \
             [ \"$(/bin/pwd -P)\" = \"$dir\" ] || {{ echo \"beam: local sync path changed\" \
             >&2; exit 66; }}; {ensure}exec \"$@\""
        );
        let mut command = vec![
            "bash".to_owned(),
            "-c".to_owned(),
            script,
            "beam-local-rsync".to_owned(),
            path_text(pinned_dir, "pinned sync path")?,
        ];
        command.extend(argv);
        run_checked(
            &command,
            &RunOptions {
                interactive: options.verbose,
                ..RunOptions::default()
            },
        )
        .await
        .map_err(TransportError::from)?;
        Ok(())
    }

    async fn rsync_through_owned_dir(
        &self,
        absolute: &Path,
        owned: OwnedWorkspace<'_>,
        argv: Vec<String>,
        options: &SyncOptions<'_>,
        create: bool,
        ensure_local_dir: Option<&Path>,
    ) -> Result<(), TransportError> {
        let owned_root = self.pinned_directory(&self.resolve(owned.root)?)?;
        let relative = owned_relative(absolute, &owned_root, &self.label)?;
        let relative_refs = relative.iter().map(String::as_str).collect::<Vec<_>>();
        let destination = owned_destination_script(owned.owner_bytes, &relative_refs, create)
            .map_err(|source| TransportError::caused_by(source.to_string(), source))?;
        let ensure = match ensure_local_dir {
            Some(path) => format!(
                "mkdir -p -- {} || exit 66",
                shq(&path_text(path, "sync path")?)
            ),
            None => String::new(),
        };
        let run = owned_rsync_command(relative.is_empty(), create);
        let mut lines = vec![
            "root=$1; shift; cd -P -- \"$root\" || exit 66".to_owned(),
            "[ \"$(/bin/pwd -P)\" = \"$root\" ] || { echo \"beam: local sync path changed\" \
             >&2; exit 66; }"
                .to_owned(),
            destination,
        ];
        if !ensure.is_empty() {
            lines.push(ensure);
        }
        lines.push(run);
        let mut command = vec![
            "bash".to_owned(),
            "-c".to_owned(),
            lines.join("\n"),
            "beam-local-rsync".to_owned(),
            path_text(&owned_root, "owned workspace root")?,
        ];
        command.extend(argv);
        run_checked(
            &command,
            &RunOptions {
                interactive: options.verbose,
                ..RunOptions::default()
            },
        )
        .await
        .map_err(TransportError::from)?;
        Ok(())
    }

    async fn exec_result(&self, command: &str) -> Result<ExecResult, TransportError> {
        run(
            &["bash", "-lc", command],
            &RunOptions {
                env: Some(&self.environment),
                ..RunOptions::default()
            },
        )
        .await
        .map_err(TransportError::from)
    }

    fn absolute_remote(&self, remote_dir: &str) -> Result<PathBuf, TransportError> {
        lexical_absolute(&self.resolve(remote_dir)?).map_err(|source| {
            TransportError::caused_by(
                format!(
                    "[{}] could not resolve remote path {remote_dir:?}",
                    self.label
                ),
                source,
            )
        })
    }
}

impl Transport for LocalTransport {
    fn label(&self) -> &str {
        &self.label
    }

    fn exec<'a>(&'a self, command: &'a str) -> TransportFuture<'a, ExecResult> {
        Box::pin(self.exec_result(command))
    }

    fn exec_checked<'a>(&'a self, command: &'a str) -> TransportFuture<'a, String> {
        Box::pin(async move {
            let result = self.exec_result(command).await?;
            crate::transport::checked_exec_result(&self.label, command, result)
        })
    }

    fn sync_up<'a>(
        &'a self,
        local_dir: &'a Path,
        remote_dir: &'a str,
        options: SyncOptions<'a>,
    ) -> TransportFuture<'a, ()> {
        Box::pin(async move {
            let absolute = self.absolute_remote(remote_dir)?;
            let mut argv = self.rsync_args(&options);
            argv.push(trailing_slash(local_dir)?);
            argv.push("./".to_owned());
            if let Some(owned) = options.owned {
                return self
                    .rsync_through_owned_dir(&absolute, owned, argv, &options, true, None)
                    .await;
            }
            self.create_missing(&absolute).await?;
            let pinned = self.pinned_directory(&absolute)?;
            self.rsync_through_pinned_dir(&pinned, argv, &options, None)
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
            let absolute = self.absolute_remote(remote_dir)?;
            let local_absolute = lexical_absolute(local_dir).map_err(|source| {
                TransportError::caused_by(
                    format!("[{}] could not resolve local sync path", self.label),
                    source,
                )
            })?;
            let mut argv = self.rsync_args(&options);
            argv.push("./".to_owned());
            argv.push(trailing_slash(&local_absolute)?);
            if let Some(owned) = options.owned {
                return self
                    .rsync_through_owned_dir(
                        &absolute,
                        owned,
                        argv,
                        &options,
                        false,
                        Some(&local_absolute),
                    )
                    .await;
            }
            let pinned = self.pinned_directory(&absolute)?;
            self.rsync_through_pinned_dir(&pinned, argv, &options, Some(&local_absolute))
                .await
        })
    }

    fn exists<'a>(&'a self, remote_path: &'a str) -> TransportFuture<'a, bool> {
        Box::pin(async move { Ok(self.resolve(remote_path)?.exists()) })
    }

    fn interactive_argv(&self, command: &str) -> Vec<String> {
        vec![
            "env".to_owned(),
            format!("HOME={}", self.lexical_home_text),
            "bash".to_owned(),
            "-lc".to_owned(),
            command.to_owned(),
        ]
    }
}

pub fn create_walk_blocks(absolute: &Path) -> Result<Vec<String>, TransportError> {
    if !absolute.is_absolute() {
        return Err(TransportError::message(format!(
            "beam: local create walk requires an absolute path: {}",
            absolute.display()
        )));
    }
    let root = absolute
        .components()
        .next()
        .map(|component| component.as_os_str())
        .ok_or_else(|| {
            TransportError::message("beam: local create walk path is empty".to_owned())
        })?;
    let root = path_text(Path::new(root), "local create walk root")?;
    let segments = normal_components(absolute, "local create walk path")?;
    let prefix = if root == "/" {
        String::new()
    } else {
        root.trim_end_matches('/').to_owned()
    };
    let mut blocks = Vec::with_capacity(segments.len() + 1);
    blocks.push(format!(
        "cd -P -- {} 2>/dev/null || {{ echo {} >&2; exit 66; }}\n__beam_prefix={}",
        shq(&root),
        shq(&format!("beam: cannot enter {root}")),
        shq(&prefix)
    ));
    for segment in segments {
        blocks.push(create_walk_segment(&segment));
    }
    Ok(blocks)
}

fn create_walk_segment(segment: &str) -> String {
    let quoted = shq(segment);
    [
        format!(
            "if [ -L {quoted} ]; then echo {} >&2; exit 61; fi",
            shq(&format!(
                "beam: refusing to create through symlinked path component: {segment}"
            ))
        ),
        format!(
            "if [ ! -e {quoted} ]; then mkdir -- {quoted} || {{ echo {} >&2; exit 66; }}; fi",
            shq(&format!("beam: cannot create {segment}"))
        ),
        format!(
            "if [ -L {quoted} ] || [ ! -d {quoted} ]; then echo {} >&2; exit 61; fi",
            shq(&format!(
                "beam: refusing to create through non-directory path component: {segment}"
            ))
        ),
        format!(
            "cd -P -- {quoted} 2>/dev/null || {{ echo {} >&2; exit 66; }}",
            shq(&format!("beam: cannot enter {segment}"))
        ),
        format!("__beam_prefix=\"$__beam_prefix\"/{quoted}"),
        format!(
            "if [ \"$(/bin/pwd -P)\" != \"$__beam_prefix\" ]; then echo {} >&2; \
             exit 66; fi",
            shq(&format!(
                "beam: {segment} no longer resolves to its pinned physical directory — refusing"
            ))
        ),
    ]
    .join("\n")
}

fn refuse_symlinked_components(absolute: &Path, label: &str) -> Result<(), TransportError> {
    let mut cursor = PathBuf::from("/");
    for component in absolute.components() {
        let Component::Normal(segment) = component else {
            continue;
        };
        cursor.push(segment);
        match fs::symlink_metadata(&cursor) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(TransportError::message(format!(
                    "[{label}] refusing to sync through symlinked path component: {}",
                    cursor.display()
                )));
            }
            Ok(_) => {}
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => break,
            Err(source) => {
                return Err(TransportError::caused_by(
                    format!("[{label}] cannot inspect {}", cursor.display()),
                    source,
                ));
            }
        }
    }
    Ok(())
}

fn owned_relative(
    destination: &Path,
    owned_root: &Path,
    label: &str,
) -> Result<Vec<String>, TransportError> {
    if destination == owned_root {
        return Ok(Vec::new());
    }
    let relative = destination.strip_prefix(owned_root).map_err(|_| {
        TransportError::message(format!(
            "[{label}] sync destination {} is not under its owned workspace {} — refusing",
            destination.display(),
            owned_root.display()
        ))
    })?;
    normal_components(relative, "owned sync destination")
}

fn owned_rsync_command(at_root: bool, create: bool) -> String {
    if at_root || !create {
        return "exec \"$@\"".to_owned();
    }
    [
        "\"$@\"",
        "__beam_rc=$?",
        "chmod 700 . || { echo \"beam: cannot restore the reserved dir mode\" >&2; exit 66; }",
        "[ -n \"$(find . -prune -perm 700)\" ] || { echo \"beam: the reserved dir mode did not \
         verify\" >&2; exit 66; }",
        "exit \"$__beam_rc\"",
    ]
    .join("\n")
}

fn normal_components(path: &Path, context: &str) -> Result<Vec<String>, TransportError> {
    let mut segments = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(segment) => segments.push(
                segment
                    .to_str()
                    .ok_or_else(|| {
                        TransportError::message(format!(
                            "beam: {context} contains non-UTF-8 bytes: {}",
                            path.display()
                        ))
                    })?
                    .to_owned(),
            ),
            Component::RootDir | Component::CurDir => {}
            Component::ParentDir | Component::Prefix(_) => {
                return Err(TransportError::message(format!(
                    "beam: {context} is not a normalized POSIX path: {}",
                    path.display()
                )));
            }
        }
    }
    Ok(segments)
}

fn lexical_absolute(path: &Path) -> Result<PathBuf, std::io::Error> {
    let absolute = std::path::absolute(path)?;
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(Path::new("/")),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(segment) => normalized.push(segment),
        }
    }
    Ok(normalized)
}

fn trailing_slash(path: &Path) -> Result<String, TransportError> {
    let text = path_text(path, "rsync path")?;
    Ok(format!("{}/", text.trim_end_matches('/')))
}

fn path_text(path: &Path, context: &str) -> Result<String, TransportError> {
    path.to_str().map(str::to_owned).ok_or_else(|| {
        TransportError::message(format!(
            "beam: {context} contains non-UTF-8 bytes: {}",
            path.display()
        ))
    })
}
