//! Goal: prove captured command failures cannot leave descendant processes or
//! inherited output pipes alive.
//!
//! Method: a bounded command starts a real background child, records its pid,
//! then times out or overflows output; each test proves that pid is gone.

use std::fs;
use std::time::Duration;

use beam::util::shell::{RunInput, RunOptions, run, shq};
use rustix::process::{Pid, Signal, kill_process, test_kill_process};
use tempfile::tempdir;
use tokio::time::{sleep, timeout};

const COMMAND_TIMEOUT: Duration = Duration::from_millis(250);
const OUTPUT_BYTES_MAX: usize = 1024;
const DESCENDANT_PROBES_MAX: u8 = 50;
const DESCENDANT_PROBE_INTERVAL: Duration = Duration::from_millis(20);
const TEST_TIMEOUT: Duration = Duration::from_secs(5);

enum FailureMode {
    Timeout,
    OutputOverflow,
}

#[tokio::test(flavor = "current_thread")]
async fn captured_timeout_kills_the_whole_process_group() {
    timeout(
        TEST_TIMEOUT,
        captured_failure_scenario(FailureMode::Timeout),
    )
    .await
    .expect("process-group test exceeded its five-second bound");
}

#[tokio::test(flavor = "current_thread")]
async fn captured_output_overflow_kills_the_whole_process_group() {
    timeout(
        TEST_TIMEOUT,
        captured_failure_scenario(FailureMode::OutputOverflow),
    )
    .await
    .expect("process-group test exceeded its five-second bound");
}

async fn captured_failure_scenario(mode: FailureMode) {
    let temporary = tempdir().expect("temporary process directory");
    let pid_file = temporary.path().join("descendant.pid");
    let (tail, expected) = match mode {
        FailureMode::Timeout => ("wait", "timed out after 250 ms"),
        FailureMode::OutputOverflow => ("yes x", "output exceeded the 1024-byte"),
    };
    let script = format!(
        "sleep 30 & echo $! > {}; {tail}",
        shq(pid_file.to_str().expect("utf-8 path"))
    );
    let options = RunOptions {
        timeout: COMMAND_TIMEOUT,
        input: RunInput::Ignore,
        max_output_bytes: OUTPUT_BYTES_MAX,
        ..RunOptions::default()
    };
    let error = run(&["bash", "-c", &script], &options)
        .await
        .expect_err("captured command must fail");
    assert!(error.to_string().contains(expected), "{error}");
    let raw_pid: i32 = fs::read_to_string(&pid_file)
        .expect("descendant pid")
        .trim()
        .parse()
        .expect("numeric descendant pid");
    let pid = Pid::from_raw(raw_pid).expect("positive descendant pid");

    // This is a bounded poll of a real external process: allow the kernel to
    // reap the SIGKILLed descendant before proving that the process is gone.
    for _attempt in 0..DESCENDANT_PROBES_MAX {
        if !process_exists(pid) {
            return;
        }
        sleep(DESCENDANT_PROBE_INTERVAL).await;
    }
    let _cleanup = kill_process(pid, Signal::KILL);
    panic!("descendant process {raw_pid} survived captured-command cleanup");
}

fn process_exists(pid: Pid) -> bool {
    match test_kill_process(pid) {
        Ok(()) => true,
        Err(rustix::io::Errno::SRCH) => false,
        Err(_source) => true,
    }
}
