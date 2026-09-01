//! Runtime: where the remote agent process lives after a handoff starts.

use std::error::Error;
use std::fmt::{Display, Formatter};

use crate::transport::TransportError;

pub mod herdr;

#[derive(Debug)]
pub struct RuntimeError {
    message: String,
    source: Option<Box<dyn Error + Send + Sync>>,
}

impl RuntimeError {
    pub(crate) fn message(message: String) -> Self {
        Self {
            message,
            source: None,
        }
    }

    pub(crate) fn caused_by<E>(message: String, source: E) -> Self
    where
        E: Error + Send + Sync + 'static,
    {
        Self {
            message,
            source: Some(Box::new(source)),
        }
    }
}

impl Display for RuntimeError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for RuntimeError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.source
            .as_deref()
            .map(|source| source as &(dyn Error + 'static))
    }
}

impl From<TransportError> for RuntimeError {
    fn from(source: TransportError) -> Self {
        Self::caused_by(source.to_string(), source)
    }
}
