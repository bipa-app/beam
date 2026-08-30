//! Shell quoting helpers, transliterated from `src/util/shell.ts` and gated
//! byte-exactly by `parity/goldens/shell-quoting.json`.

use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::fmt::{Display, Formatter};
use std::path::Path;
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};
use tokio::time::timeout;

const DEFAULT_MAX_OUTPUT_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(300);
const READ_BUFFER_BYTES: usize = 8 * 1024;
const TERMINATION_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug)]
pub struct RunResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Clone, Copy)]
pub enum RunInput<'a> {
    Ignore,
    Text(&'a str),
    Bytes(&'a [u8]),
}

pub struct RunOptions<'a> {
    pub cwd: Option<&'a Path>,
    pub env: Option<&'a BTreeMap<String, String>>,
    pub base_env: Option<&'a BTreeMap<String, String>>,
    pub interactive: bool,
    pub input: RunInput<'a>,
    pub max_output_bytes: usize,
    pub timeout: Duration,
}

impl Default for RunOptions<'_> {
    fn default() -> Self {
        Self {
            cwd: None,
            env: None,
            base_env: None,
            interactive: false,
            input: RunInput::Ignore,
            max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES,
            timeout: DEFAULT_TIMEOUT,
        }
    }
}

#[derive(Debug)]
pub struct RunError {
    message: String,
}

impl Display for RunError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for RunError {}

enum ProcessIoError {
    InputMissing,
    InputWrite(std::io::Error),
    OutputRead {
        stream: &'static str,
        source: std::io::Error,
    },
    OutputOverflow(&'static str),
    Wait(std::io::Error),
}

/// Single-quote a string for POSIX shells. Safe for any content.
pub fn shq(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/// Quote an argv into a single shell command string.
pub fn shjoin(argv: &[&str]) -> String {
    argv.iter()
        .map(|arg| shq(arg))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Quote a remote path for use inside a `bash -lc` command string.
/// A leading `~/` must survive quoting so the remote shell expands it,
/// so it is rewritten to `"$HOME/..."` with double-quote escaping.
pub fn shq_remote_path(path: &str) -> String {
    if path == "~" {
        return "\"$HOME\"".to_owned();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        let mut out = String::with_capacity(rest.len() + 11);
        out.push_str("\"$HOME/");
        for ch in rest.chars() {
            if matches!(ch, '\\' | '"' | '$' | '`') {
                out.push('\\');
            }
            out.push(ch);
        }
        out.push('"');
        return out;
    }
    shq(path)
}

/// Run an argv. Nonzero exit is data; spawn, I/O, cap, and timeout failures
/// are errors.
pub async fn run<S>(argv: &[S], options: &RunOptions<'_>) -> Result<RunResult, RunError>
where
    S: AsRef<OsStr>,
{
    if argv.is_empty() {
        return Err(RunError {
            message: "run: argv must contain a program".to_owned(),
        });
    }
    if options.max_output_bytes == 0 {
        return Err(RunError {
            message: "run: max_output_bytes must be positive, got 0".to_owned(),
        });
    }
    if options.timeout.is_zero() {
        return Err(RunError {
            message: "run: timeout must be positive".to_owned(),
        });
    }
    if options.interactive {
        match options.input {
            RunInput::Ignore => {}
            RunInput::Text(_) | RunInput::Bytes(_) => {
                return Err(RunError {
                    message: "run: interactive commands cannot receive captured stdin".to_owned(),
                });
            }
        }
    }

    let program = argv[0].as_ref().to_string_lossy().into_owned();
    let mut command = build_command(argv, options);
    let child = command.spawn().map_err(|source| RunError {
        message: format!("could not start {program}: {source}"),
    })?;
    if options.interactive {
        return run_interactive(child, &program, options.timeout).await;
    }
    run_captured(child, &program, options).await
}

/// Run an argv and fail with captured stderr context on nonzero exit.
pub async fn run_checked<S>(argv: &[S], options: &RunOptions<'_>) -> Result<RunResult, RunError>
where
    S: AsRef<OsStr>,
{
    let result = run(argv, options).await?;
    if result.code != 0 {
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
        let program = argv[0].as_ref().to_string_lossy();
        return Err(RunError {
            message: format!("command failed ({}): {program}{suffix}", result.code),
        });
    }
    Ok(result)
}

fn build_command<S>(argv: &[S], options: &RunOptions<'_>) -> Command
where
    S: AsRef<OsStr>,
{
    let mut command = Command::new(argv[0].as_ref());
    command.args(argv[1..].iter().map(AsRef::as_ref));
    command.kill_on_drop(true);
    if let Some(cwd) = options.cwd {
        command.current_dir(cwd);
    }
    if let Some(base_env) = options.base_env {
        command.env_clear();
        command.envs(base_env);
    }
    if let Some(env) = options.env {
        command.envs(env);
    }
    if options.interactive {
        command.stdin(Stdio::inherit());
        command.stdout(Stdio::inherit());
        command.stderr(Stdio::inherit());
    } else {
        match options.input {
            RunInput::Ignore => {
                command.stdin(Stdio::null());
            }
            RunInput::Text(_) | RunInput::Bytes(_) => {
                command.stdin(Stdio::piped());
            }
        }
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
    }
    command
}

async fn run_interactive(
    mut child: Child,
    program: &str,
    duration: Duration,
) -> Result<RunResult, RunError> {
    match timeout(duration, child.wait()).await {
        Ok(Ok(status)) => Ok(RunResult {
            code: exit_code(status),
            stdout: String::new(),
            stderr: String::new(),
        }),
        Ok(Err(source)) => {
            let cleanup = terminate_child(&mut child).await.err();
            Err(RunError {
                message: process_error_with_cleanup(
                    format!("could not wait for {program}: {source}"),
                    cleanup,
                ),
            })
        }
        Err(_) => {
            let cleanup = terminate_child(&mut child).await.err();
            Err(RunError {
                message: process_error_with_cleanup(
                    format!(
                        "command timed out after {} ms: {program}",
                        duration.as_millis()
                    ),
                    cleanup,
                ),
            })
        }
    }
}

async fn run_captured(
    mut child: Child,
    program: &str,
    options: &RunOptions<'_>,
) -> Result<RunResult, RunError> {
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().ok_or_else(|| RunError {
        message: format!("could not capture stdout for {program}"),
    })?;
    let stderr = child.stderr.take().ok_or_else(|| RunError {
        message: format!("could not capture stderr for {program}"),
    })?;
    let operation = async {
        let ((), stdout, stderr) = tokio::try_join!(
            write_input(stdin, options.input),
            capture_stream(stdout, "stdout", options.max_output_bytes),
            capture_stream(stderr, "stderr", options.max_output_bytes),
        )?;
        let status = child.wait().await.map_err(ProcessIoError::Wait)?;
        Ok::<_, ProcessIoError>((status, stdout, stderr))
    };
    match timeout(options.timeout, operation).await {
        Ok(Ok((status, stdout, stderr))) => Ok(RunResult {
            code: exit_code(status),
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        }),
        Ok(Err(source)) => {
            let cleanup = terminate_child(&mut child).await.err();
            Err(RunError {
                message: process_io_error(program, options.max_output_bytes, source, cleanup),
            })
        }
        Err(_) => {
            let cleanup = terminate_child(&mut child).await.err();
            Err(RunError {
                message: process_error_with_cleanup(
                    format!(
                        "command timed out after {} ms: {program}",
                        options.timeout.as_millis()
                    ),
                    cleanup,
                ),
            })
        }
    }
}

async fn write_input(
    mut stdin: Option<ChildStdin>,
    input: RunInput<'_>,
) -> Result<(), ProcessIoError> {
    let bytes = match input {
        RunInput::Ignore => return Ok(()),
        RunInput::Text(text) => text.as_bytes(),
        RunInput::Bytes(bytes) => bytes,
    };
    let Some(pipe) = stdin.as_mut() else {
        return Err(ProcessIoError::InputMissing);
    };
    pipe.write_all(bytes)
        .await
        .map_err(ProcessIoError::InputWrite)?;
    pipe.shutdown().await.map_err(ProcessIoError::InputWrite)
}

async fn capture_stream<R>(
    mut stream: R,
    stream_name: &'static str,
    max_output_bytes: usize,
) -> Result<Vec<u8>, ProcessIoError>
where
    R: AsyncRead + Unpin,
{
    let mut captured = Vec::with_capacity(max_output_bytes.min(READ_BUFFER_BYTES));
    let mut buffer = [0_u8; READ_BUFFER_BYTES];
    loop {
        let read_bytes =
            stream
                .read(&mut buffer)
                .await
                .map_err(|source| ProcessIoError::OutputRead {
                    stream: stream_name,
                    source,
                })?;
        if read_bytes == 0 {
            break;
        }
        if read_bytes > max_output_bytes - captured.len() {
            return Err(ProcessIoError::OutputOverflow(stream_name));
        }
        captured.extend_from_slice(&buffer[..read_bytes]);
    }
    Ok(captured)
}

async fn terminate_child(child: &mut Child) -> Result<(), std::io::Error> {
    match child.start_kill() {
        Ok(()) => {}
        Err(source) if source.kind() == std::io::ErrorKind::InvalidInput => {}
        Err(source) => return Err(source),
    }
    match timeout(TERMINATION_TIMEOUT, child.wait()).await {
        Ok(Ok(_status)) => Ok(()),
        Ok(Err(source)) => Err(source),
        Err(_elapsed) => Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "child did not exit within 5 seconds of SIGKILL",
        )),
    }
}

fn exit_code(status: ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;

        if let Some(signal) = status.signal() {
            return 128 + signal;
        }
    }
    1
}

fn process_io_error(
    program: &str,
    max_output_bytes: usize,
    source: ProcessIoError,
    cleanup: Option<std::io::Error>,
) -> String {
    let message = match source {
        ProcessIoError::InputMissing => {
            format!("could not open stdin for {program}")
        }
        ProcessIoError::InputWrite(source) => {
            format!("could not write stdin for {program}: {source}")
        }
        ProcessIoError::OutputRead { stream, source } => {
            format!("could not read {stream} for {program}: {source}")
        }
        ProcessIoError::OutputOverflow(stream) => {
            format!(
                "command output exceeded the {max_output_bytes}-byte per-stream cap on \
                 {stream}: {program}"
            )
        }
        ProcessIoError::Wait(source) => {
            format!("could not wait for {program}: {source}")
        }
    };
    process_error_with_cleanup(message, cleanup)
}

fn process_error_with_cleanup(message: String, cleanup: Option<std::io::Error>) -> String {
    match cleanup {
        Some(source) => format!("{message}; also could not stop the child: {source}"),
        None => message,
    }
}
