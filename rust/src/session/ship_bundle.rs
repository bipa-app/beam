//! Digest-only identity of the exact local session source a ship installs.

use sha2::{Digest, Sha256};

use crate::session::{LocalSession, SessionError, ToolName};
use crate::util::digest::{file_sha256, tree_sha256};

#[derive(Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionShipBundle {
    pub tool: ToolName,
    pub id: String,
    pub transcript_sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifacts_sha256: Option<String>,
}

pub fn session_ship_bundle(session: &LocalSession) -> Result<SessionShipBundle, SessionError> {
    let transcript_sha256 = file_sha256(&session.file).map_err(|source| {
        SessionError::caused_by(
            format!(
                "cannot hash session transcript {} — retry after checking the file",
                session.file.display()
            ),
            source,
        )
    })?;
    let artifacts_sha256 = session
        .artifacts_dir
        .as_ref()
        .map(|path| {
            tree_sha256(path).map_err(|source| {
                SessionError::caused_by(
                    format!(
                        "cannot hash session artifacts {} — retry after checking the tree",
                        path.display()
                    ),
                    source,
                )
            })
        })
        .transpose()?;
    Ok(SessionShipBundle {
        tool: session.tool,
        id: session.id.clone(),
        transcript_sha256,
        artifacts_sha256,
    })
}

pub fn session_install_key(bundle: &SessionShipBundle) -> String {
    let artifacts = bundle.artifacts_sha256.as_deref().unwrap_or("absent");
    let input = format!(
        "beam-session-install-v1\0{}\0{}\0{}\0{}\0",
        bundle.tool, bundle.id, bundle.transcript_sha256, artifacts
    );
    hex::encode(Sha256::digest(input.as_bytes()))
}
