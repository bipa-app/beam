//! Digest safety contracts beyond TypeScript parity. Method: exercise invalid
//! chunk bounds before I/O and assert the exact error kind and actionable text.

use std::io;
use std::path::Path;

use beam::util::digest::{DEFAULT_CHUNK_BYTES, file_sha256_chunked};

#[test]
fn file_sha256_rejects_zero_chunk_bytes() {
    let error = file_sha256_chunked(Path::new("unused"), 0).expect_err("zero chunk must fail");
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(
        error.to_string(),
        format!("file_sha256: chunk size must be between 1 and {DEFAULT_CHUNK_BYTES} bytes")
    );
}

#[test]
fn file_sha256_rejects_chunk_larger_than_production_buffer() {
    let error = file_sha256_chunked(Path::new("unused"), DEFAULT_CHUNK_BYTES + 1)
        .expect_err("oversized chunk must fail");
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(
        error.to_string(),
        format!("file_sha256: chunk size must be between 1 and {DEFAULT_CHUNK_BYTES} bytes")
    );
}
