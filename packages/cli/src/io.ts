import { OmbError } from "@openmessageboard/sdk";

export interface Input extends NodeJS.EventEmitter {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  setEncoding?: (enc: BufferEncoding) => unknown;
  resume?: () => unknown;
  pause?: () => unknown;
  [Symbol.asyncIterator](): AsyncIterator<string | Buffer>;
}

export interface Io {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  stdin: Input;
  env: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Registers a Ctrl-C handler; returns an unregister function. */
  onInterrupt?: (handler: () => void) => () => void;
}

export async function readAll(input: Input): Promise<string> {
  let text = "";
  for await (const chunk of input) text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  return text;
}

/** Reads a line from the terminal without echoing it (for tokens). */
export function promptHidden(question: string, io: Io): Promise<string> {
  const { stdin, stderr } = io;
  stderr.write(question);
  return new Promise((resolve, reject) => {
    let input = "";
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause?.();
      stderr.write("\n");
    };
    const onData = (chunk: string | Buffer) => {
      for (const ch of typeof chunk === "string" ? chunk : chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          cleanup();
          return resolve(input.trim());
        }
        if (ch === "\u0003") {
          cleanup();
          return reject(new OmbError("invalid_argument", "Cancelled"));
        }
        if (ch === "\u007f" || ch === "\b") input = input.slice(0, -1);
        else input += ch;
      }
    };
    stdin.setRawMode?.(true);
    stdin.setEncoding?.("utf8");
    stdin.resume?.();
    stdin.on("data", onData);
  });
}
