//! JSON CLI envelope, transliterated from `src/cli-output.ts`. The
//! `schemaVersion: 1` document shape is the public contract — byte-exact
//! output is pinned by `parity/goldens/cli-output.json`.

use serde::Serialize;
use serde_json::{Value, json};

pub const JSON_MESSAGE_BYTES_MAX: usize = 1024 * 1024;
pub const JSON_MESSAGE_COUNT_MAX: usize = 1024;

#[derive(Clone, Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CliMessage {
    pub level: &'static str,
    pub text: String,
}

impl CliMessage {
    pub fn info(text: String) -> Self {
        Self {
            level: "info",
            text,
        }
    }
    pub fn warning(text: String) -> Self {
        Self {
            level: "warning",
            text,
        }
    }
    pub fn error(text: String) -> Self {
        Self {
            level: "error",
            text,
        }
    }
}

/// An error carrying a machine-readable code for the JSON envelope.
#[derive(PartialEq, Debug)]
pub struct CliError {
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
}

impl CliError {
    pub fn new(code: &str, message: &str, details: Option<Value>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.to_owned(),
            details,
        }
    }
}

impl std::fmt::Display for CliError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CliError {}

/// Build the success document. Field order is fixed (schemaVersion, ok,
/// command, data, messages) to match the TS `JSON.stringify` output.
pub fn success_document(command: &str, data: Value, messages: &[CliMessage]) -> String {
    json!({
        "schemaVersion": 1,
        "ok": true,
        "command": command,
        "data": data,
        "messages": messages,
    })
    .to_string()
}

/// Build the failure document. `details` is omitted (not nulled) when
/// absent, matching the TS conditional spread.
pub fn failure_document(
    command: &str,
    code: &str,
    message: &str,
    details: Option<&Value>,
    messages: &[CliMessage],
) -> String {
    let mut error = json!({ "code": code, "message": message });
    if let Some(details) = details {
        error
            .as_object_mut()
            .expect("error object")
            .insert("details".to_owned(), details.clone());
    }
    json!({
        "schemaVersion": 1,
        "ok": false,
        "command": command,
        "error": error,
        "messages": messages,
    })
    .to_string()
}
