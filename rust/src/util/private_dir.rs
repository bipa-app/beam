//! Component-wise protection for Beam-owned local storage. Each component is
//! opened with `O_NOFOLLOW`, proven to be owned by this uid, tightened to
//! 0700 through the opened descriptor, then re-proven at the pathname.

use std::fmt::{Display, Formatter};
use std::fs::{self, DirBuilder, File, Permissions};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

use rustix::fs::{Mode, OFlags};
use rustix::process::getuid;

#[derive(Debug)]
pub struct PrivateDirError {
    message: String,
}

impl Display for PrivateDirError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for PrivateDirError {}

/// Create or tighten `root` and every descendant segment. Ancestors above
/// `root` are created plainly and never chmodded; privacy starts at `root`.
pub fn ensure_private_beam_dir(root: &Path, segments: &[&str]) -> Result<PathBuf, PrivateDirError> {
    if root.as_os_str().is_empty() {
        return Err(PrivateDirError {
            message: "beam: private directory root must not be empty".to_owned(),
        });
    }
    if let Some(parent) = root.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent).map_err(|source| PrivateDirError {
            message: format!(
                "beam: could not create parent {} for private storage: {source}",
                parent.display()
            ),
        })?;
    }
    let mut path = root.to_path_buf();
    secure_private_component(&path)?;
    for segment in segments {
        validate_private_segment(segment)?;
        path.push(segment);
        secure_private_component(&path)?;
    }
    Ok(path)
}

fn validate_private_segment(segment: &str) -> Result<(), PrivateDirError> {
    if segment.is_empty() {
        return Err(PrivateDirError {
            message: "beam: private directory segment must not be empty".to_owned(),
        });
    }
    if segment == "." {
        return Err(PrivateDirError {
            message: "beam: private directory segment must not be .".to_owned(),
        });
    }
    if segment == ".." {
        return Err(PrivateDirError {
            message: "beam: private directory segment must not be ..".to_owned(),
        });
    }
    if segment.contains('/') {
        return Err(PrivateDirError {
            message: format!(
                "beam: private directory segment {segment:?} must be one path component"
            ),
        });
    }
    Ok(())
}

fn secure_private_component(path: &Path) -> Result<(), PrivateDirError> {
    let metadata = create_or_inspect_component(path)?;
    if metadata.file_type().is_symlink() {
        return Err(PrivateDirError {
            message: format!(
                "beam: {} is a symlink — Beam's private storage must be a real directory it owns; \
                 refusing to follow it. Move the link aside and retry",
                path.display()
            ),
        });
    }
    if !metadata.is_dir() {
        return Err(PrivateDirError {
            message: format!(
                "beam: {} exists but is not a directory — move it aside and retry",
                path.display()
            ),
        });
    }
    let directory = open_private_component(path)?;
    let opened = tighten_private_component(&directory, path)?;
    verify_private_component(path, &opened)
}

fn create_or_inspect_component(path: &Path) -> Result<std::fs::Metadata, PrivateDirError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(metadata),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            let mut builder = DirBuilder::new();
            builder.mode(0o700);
            match builder.create(path) {
                Ok(()) => {}
                Err(source) if source.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(source) => {
                    return Err(PrivateDirError {
                        message: format!(
                            "beam: could not create private directory {}: {source}",
                            path.display()
                        ),
                    });
                }
            }
            fs::symlink_metadata(path).map_err(|source| PrivateDirError {
                message: format!(
                    "beam: failed to inspect created private directory {}: {source}",
                    path.display()
                ),
            })
        }
        Err(source) => Err(PrivateDirError {
            message: format!(
                "beam: could not inspect private directory {}: {source}",
                path.display()
            ),
        }),
    }
}

fn open_private_component(path: &Path) -> Result<File, PrivateDirError> {
    let fd = rustix::fs::open(
        path,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::DIRECTORY | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .map_err(|source| PrivateDirError {
        message: format!(
            "beam: could not safely open private directory {}: {source}",
            path.display()
        ),
    })?;
    Ok(File::from(fd))
}

fn tighten_private_component(
    directory: &File,
    path: &Path,
) -> Result<std::fs::Metadata, PrivateDirError> {
    let mut metadata = directory.metadata().map_err(|source| PrivateDirError {
        message: format!(
            "beam: could not inspect opened private directory {}: {source}",
            path.display()
        ),
    })?;
    let uid = getuid().as_raw();
    if metadata.uid() != uid {
        return Err(PrivateDirError {
            message: format!(
                "beam: {} is owned by uid {}, not this process (uid {uid}) — refusing to use \
                 foreign storage for private return data. Move it aside and retry",
                path.display(),
                metadata.uid()
            ),
        });
    }
    if metadata.mode() & 0o077 != 0 {
        directory
            .set_permissions(Permissions::from_mode(0o700))
            .map_err(|source| PrivateDirError {
                message: format!(
                    "beam: could not tighten private directory {} to mode 700: {source}",
                    path.display()
                ),
            })?;
        metadata = directory.metadata().map_err(|source| PrivateDirError {
            message: format!(
                "beam: could not recheck private directory {}: {source}",
                path.display()
            ),
        })?;
    }
    Ok(metadata)
}

fn verify_private_component(
    path: &Path,
    opened: &std::fs::Metadata,
) -> Result<(), PrivateDirError> {
    let current = fs::symlink_metadata(path).map_err(|source| PrivateDirError {
        message: format!(
            "beam: private directory {} changed during verification: {source}",
            path.display()
        ),
    })?;
    if current.file_type().is_symlink() {
        return Err(PrivateDirError {
            message: format!(
                "beam: private directory {} became a symlink during verification — retry",
                path.display()
            ),
        });
    }
    if !current.is_dir() {
        return Err(PrivateDirError {
            message: format!(
                "beam: private directory {} stopped being a directory during verification — retry",
                path.display()
            ),
        });
    }
    if current.dev() != opened.dev() {
        return Err(PrivateDirError {
            message: format!(
                "beam: private directory {} changed device during verification — retry",
                path.display()
            ),
        });
    }
    if current.ino() != opened.ino() {
        return Err(PrivateDirError {
            message: format!(
                "beam: private directory {} changed inode during verification — retry",
                path.display()
            ),
        });
    }
    if current.mode() & 0o077 != 0 {
        return Err(PrivateDirError {
            message: format!(
                "beam: {} must be private mode 700 (found mode {:o})",
                path.display(),
                current.mode() & 0o7777
            ),
        });
    }
    Ok(())
}
