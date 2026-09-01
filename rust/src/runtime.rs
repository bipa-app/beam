//! Runtime: where the remote agent process lives after a handoff starts.

use std::error::Error;
use std::fmt::{Display, Formatter};

use crate::transport::TransportError;

pub mod herdr;

#[derive(Debug)]
pub struct RetryableRuntimeStartError {
    cause: RuntimeError,
}

impl Display for RetryableRuntimeStartError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("runtime start failed and was cleaned up; retry beam up")
    }
}

impl Error for RetryableRuntimeStartError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(&self.cause)
    }
}

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

    pub(crate) fn retryable_start(cause: Self) -> Self {
        let source = RetryableRuntimeStartError { cause };
        Self::caused_by(source.to_string(), source)
    }

    pub fn is_retryable_start(&self) -> bool {
        self.source
            .as_deref()
            .is_some_and(|source| source.is::<RetryableRuntimeStartError>())
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

impl From<std::io::Error> for RuntimeError {
    fn from(source: std::io::Error) -> Self {
        Self::caused_by(source.to_string(), source)
    }
}
