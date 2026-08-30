//! Goal: preserve the TypeScript process runner's observable safety contract:
//! stdout and stderr drain concurrently, each stream has its own hard byte
//! cap, input and environment shaping are exact, and nonzero exits remain
//! data unless the caller asks for a checked run.
//!
//! Method: run real POSIX children that fill both OS pipe buffers, cross each
//! cap boundary, echo exact input, expose a cleared environment, and exit with
//! a chosen code. Every child is bounded by the runner's timeout.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use beam::util::shell::{RunInput, RunOptions, run, run_checked};

const CAP: usize = 8 * 1024;
const TEST_TIMEOUT: Duration = Duration::from_secs(5);

#[tokio::test(flavor = "current_thread")]
async fn captures_each_stream_through_its_exact_cap() {
    for byte_count in [CAP - 1, CAP] {
        let count = byte_count.to_string();
        let result = run(
            &["head", "-c", &count, "/dev/zero"],
            &RunOptions {
                max_output_bytes: CAP,
                timeout: TEST_TIMEOUT,
                ..RunOptions::default()
            },
        )
        .await
        .expect("head output at or below the cap should succeed");
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.len(), byte_count);
        assert!(result.stderr.is_empty());
    }
}

#[tokio::test(flavor = "current_thread")]
async fn rejects_stdout_and_stderr_above_their_independent_caps() {
    let count = (CAP + 1).to_string();
    let stdout_error = run(
        &["head", "-c", &count, "/dev/zero"],
        &RunOptions {
            max_output_bytes: CAP,
            timeout: TEST_TIMEOUT,
            ..RunOptions::default()
        },
    )
    .await
    .expect_err("stdout above the cap should fail");
    assert!(
        stdout_error
            .to_string()
            .contains("8192-byte per-stream cap on stdout: head")
    );

    let script = format!("head -c {} /dev/zero >&2", CAP + 1);
    let stderr_error = run(
        &["bash", "-c", &script],
        &RunOptions {
            max_output_bytes: CAP,
            timeout: TEST_TIMEOUT,
            ..RunOptions::default()
        },
    )
    .await
    .expect_err("stderr above the cap should fail");
    assert!(
        stderr_error
            .to_string()
            .contains("8192-byte per-stream cap on stderr: bash")
    );
}

#[tokio::test(flavor = "current_thread")]
async fn drains_full_stdout_and_stderr_pipes_concurrently() {
    let byte_count = 1_048_576;
    let script =
        format!("head -c {byte_count} /dev/zero & head -c {byte_count} /dev/zero >&2; wait");
    let result = run(
        &["bash", "-c", &script],
        &RunOptions {
            max_output_bytes: byte_count,
            timeout: TEST_TIMEOUT,
            ..RunOptions::default()
        },
    )
    .await
    .expect("both full pipes should drain without deadlock");
    assert_eq!(result.code, 0);
    assert_eq!(result.stdout.len(), byte_count);
    assert_eq!(result.stderr.len(), byte_count);
}

#[tokio::test(flavor = "current_thread")]
async fn kills_a_child_when_both_streams_overflow_together() {
    let script = format!(
        "head -c {} /dev/zero & head -c {} /dev/zero >&2; wait",
        CAP * 4,
        CAP * 4
    );
    let error = run(
        &["bash", "-c", &script],
        &RunOptions {
            max_output_bytes: CAP,
            timeout: TEST_TIMEOUT,
            ..RunOptions::default()
        },
    )
    .await
    .expect_err("simultaneous overflow should kill the child");
    assert!(error.to_string().contains("8192-byte per-stream cap on"));
}

#[tokio::test(flavor = "current_thread")]
async fn kills_an_infinite_writer_when_stdout_crosses_the_cap() {
    let error = run(
        &["yes"],
        &RunOptions {
            max_output_bytes: CAP,
            timeout: TEST_TIMEOUT,
            ..RunOptions::default()
        },
    )
    .await
    .expect_err("an infinite writer should be killed at the cap");
    assert!(
        error
            .to_string()
            .contains("8192-byte per-stream cap on stdout: yes")
    );
}

#[tokio::test(flavor = "current_thread")]
async fn sends_exact_text_and_bytes_to_child_stdin() {
    let text_result = run(
        &["cat"],
        &RunOptions {
            input: RunInput::Text("text input\n"),
            timeout: TEST_TIMEOUT,
            ..RunOptions::default()
        },
    )
    .await
    .expect("text stdin should reach the child");
    assert_eq!(text_result.stdout, "text input\n");

    let bytes = [0, 0xff, b'x'];
    let bytes_result = run(
        &["cat"],
        &RunOptions {
            input: RunInput::Bytes(&bytes),
            timeout: TEST_TIMEOUT,
            ..RunOptions::default()
        },
    )
    .await
    .expect("byte stdin should reach the child");
    assert_eq!(bytes_result.stdout.as_bytes(), [0, 0xef, 0xbf, 0xbd, b'x']);
}

#[tokio::test(flavor = "current_thread")]
async fn clears_then_layers_the_child_environment() {
    let base_env = BTreeMap::from([
        ("BASE".to_owned(), "base".to_owned()),
        ("SHARED".to_owned(), "base".to_owned()),
    ]);
    let env = BTreeMap::from([
        ("EXTRA".to_owned(), "extra".to_owned()),
        ("SHARED".to_owned(), "overlay".to_owned()),
    ]);
    let result = run(
        &["/usr/bin/env"],
        &RunOptions {
            env: Some(&env),
            base_env: Some(&base_env),
            timeout: TEST_TIMEOUT,
            ..RunOptions::default()
        },
    )
    .await
    .expect("the explicit environment should launch env");
    let lines = result.stdout.lines().collect::<Vec<_>>();
    assert_eq!(lines.len(), 3);
    assert!(lines.contains(&"BASE=base"));
    assert!(lines.contains(&"EXTRA=extra"));
    assert!(lines.contains(&"SHARED=overlay"));
}

#[tokio::test(flavor = "current_thread")]
async fn runs_the_child_in_the_requested_directory() {
    let result = run(
        &["pwd"],
        &RunOptions {
            cwd: Some(Path::new("/")),
            timeout: TEST_TIMEOUT,
            ..RunOptions::default()
        },
    )
    .await
    .expect("pwd should run in the requested directory");
    assert_eq!(result.stdout, "/\n");
}

#[tokio::test(flavor = "current_thread")]
async fn returns_nonzero_exit_data_and_checked_context() {
    let argv = ["bash", "-c", "echo out; echo err >&2; exit 3"];
    let result = run(
        &argv,
        &RunOptions {
            timeout: TEST_TIMEOUT,
            ..RunOptions::default()
        },
    )
    .await
    .expect("run should return a nonzero exit as data");
    assert_eq!(result.code, 3);
    assert_eq!(result.stdout, "out\n");
    assert_eq!(result.stderr, "err\n");

    let error = run_checked(
        &argv,
        &RunOptions {
            timeout: TEST_TIMEOUT,
            ..RunOptions::default()
        },
    )
    .await
    .expect_err("run_checked should reject the same exit");
    assert_eq!(error.to_string(), "command failed (3): bash\nerr");
}

#[tokio::test(flavor = "current_thread")]
async fn rejects_invalid_options_before_spawning() {
    let empty: [&str; 0] = [];
    let empty_error = run(&empty, &RunOptions::default())
        .await
        .expect_err("empty argv should fail before spawn");
    assert_eq!(empty_error.to_string(), "run: argv must contain a program");

    let cap_error = run(
        &["true"],
        &RunOptions {
            max_output_bytes: 0,
            ..RunOptions::default()
        },
    )
    .await
    .expect_err("a zero cap should fail before spawn");
    assert_eq!(
        cap_error.to_string(),
        "run: max_output_bytes must be positive, got 0"
    );

    let interactive_error = run(
        &["true"],
        &RunOptions {
            interactive: true,
            input: RunInput::Text("no"),
            ..RunOptions::default()
        },
    )
    .await
    .expect_err("interactive input should fail before spawn");
    assert_eq!(
        interactive_error.to_string(),
        "run: interactive commands cannot receive captured stdin"
    );
}
