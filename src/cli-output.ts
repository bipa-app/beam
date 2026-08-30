import { format } from "node:util";

const JSON_MESSAGE_BYTES_MAX = 1024 * 1024;
const JSON_MESSAGE_COUNT_MAX = 1024;
const ANSI_PHOTON = "\u001b[38;2;255;216;77m";
const ANSI_RESET = "\u001b[0m";
let cliColorEnabled =
  process.stdout.isTTY === true &&
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb";

/** Photon yellow is reserved for movement and arrival in human terminal output. */
export function cliAccent(text: string): string {
  return cliColorEnabled ? `${ANSI_PHOTON}${text}${ANSI_RESET}` : text;
}


export interface CliMessage {
  level: "error" | "info" | "warning";
  text: string;
}

export interface CliSuccess {
  schemaVersion: 1;
  ok: true;
  command: string;
  data: unknown;
  messages: CliMessage[];
}

export interface CliFailure {
  schemaVersion: 1;
  ok: false;
  command: string;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  messages: CliMessage[];
}

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

interface ConsoleMethods {
  error: typeof console.error;
  log: typeof console.log;
  warn: typeof console.warn;
}

interface JsonCapture {
  messages: CliMessage[];
  original: ConsoleMethods;
  restore(): void;
}

function beginJsonCapture(): JsonCapture {
  const original = { error: console.error, log: console.log, warn: console.warn };
  const messages: CliMessage[] = [];
  let messageBytes = 0;
  const capture = (level: CliMessage["level"], values: unknown[]): void => {
    if (messages.length >= JSON_MESSAGE_COUNT_MAX) {
      throw new CliError(
        "output_limit_exceeded",
        `command emitted more than ${JSON_MESSAGE_COUNT_MAX} messages`,
      );
    }
    const text = format(...values);
    messageBytes += Buffer.byteLength(text);
    if (messageBytes > JSON_MESSAGE_BYTES_MAX) {
      throw new CliError(
        "output_limit_exceeded",
        `command output exceeded ${JSON_MESSAGE_BYTES_MAX} bytes`,
      );
    }
    messages.push({ level, text });
  };
  console.log = (...values: unknown[]) => capture("info", values);
  console.warn = (...values: unknown[]) => capture("warning", values);
  console.error = (...values: unknown[]) => capture("error", values);
  return {
    messages,
    original,
    restore: () => {
      console.error = original.error;
      console.log = original.log;
      console.warn = original.warn;
    },
  };
}

/** Capture all command chatter so JSON mode writes exactly one document. */
export async function runJsonCommand(
  command: string,
  runCommand: () => Promise<unknown>,
): Promise<number> {
  const colorEnabledBeforeJson = cliColorEnabled;
  cliColorEnabled = false;
  const capture = beginJsonCapture();
  const { messages, original } = capture;
  process.exitCode = 0;
  try {
    const data = await runCommand();
    const exitCode = process.exitCode ?? 0;
    if (exitCode !== 0) {
      const result: CliFailure = {
        schemaVersion: 1,
        ok: false,
        command,
        error: {
          code: "command_failed",
          message: messages.at(-1)?.text ?? `command exited ${exitCode}`,
        },
        messages,
      };
      original.log(JSON.stringify(result));
      return exitCode;
    }
    const result: CliSuccess = {
      schemaVersion: 1,
      ok: true,
      command,
      data: data ?? null,
      messages,
    };
    original.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    const cliError = error instanceof CliError ? error : undefined;
    const result: CliFailure = {
      schemaVersion: 1,
      ok: false,
      command,
      error: {
        code: cliError?.code ?? "command_failed",
        message: error instanceof Error ? error.message : String(error),
        ...(cliError?.details === undefined ? {} : { details: cliError.details }),
      },
      messages,
    };
    original.log(JSON.stringify(result));
    return 1;
  } finally {
    capture.restore();
    cliColorEnabled = colorEnabledBeforeJson;
  }
}
