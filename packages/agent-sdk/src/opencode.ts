import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { AgentAdapter, AgentRunInput, AgentStreamEvent } from "./index";

export type OpenCodeAdapterConfig = {
  sessionId?: string;
  cwd?: string;
  model?: string;
  agent?: string;
  maxRuntimeMs?: number;
  gracefulShutdownMs?: number;
};

export type OpenCodeSpawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    stdio: ["pipe", "pipe", "pipe"];
    cwd?: string;
  },
) => ChildProcessWithoutNullStreams;

/**
 * Raw shape of a JSON event emitted by `opencode run --format json`.
 *
 * Each stdout line is: `{ type, timestamp, sessionID, ...data }`
 *
 * Relevant event types:
 *   - text       → assistant text block (when part.time?.end is set)
 *   - error      → session error
 *   - tool_use   → tool invocation (informational, no text to extract)
 */
type OpenCodeJsonEvent = {
  type?: string;
  sessionID?: string;
  error?: {
    name?: string;
    data?: { message?: string };
  } | string;
  part?: {
    type?: string;
    text?: string;
    time?: { start?: number; end?: number };
    state?: {
      status?: string;
      error?: string;
    };
  };
};

function extractTextFromEvent(event: OpenCodeJsonEvent): string | null {
  if (event.type !== "text") return null;
  const part = event.part;
  if (!part) return null;
  if (typeof part.text !== "string" || !part.text.trim()) return null;
  return part.text;
}

function extractErrorFromEvent(event: OpenCodeJsonEvent): string | null {
  if (event.type !== "error") return null;
  if (typeof event.error === "string") return event.error;
  if (event.error && typeof event.error === "object") {
    const msg = event.error.data?.message ?? event.error.name;
    if (msg) return msg;
  }
  return null;
}

export function createOpenCodeAdapter(
  config: OpenCodeAdapterConfig,
  spawnProcess: OpenCodeSpawn = spawn,
): AgentAdapter {
  return {
    async *run(input: AgentRunInput): AsyncIterable<AgentStreamEvent> {
      const maxRuntimeMs = config.maxRuntimeMs ?? 300_000;
      const gracefulShutdownMs = config.gracefulShutdownMs ?? 5_000;

      const args = ["run", "--format", "json"];

      if (config.sessionId) {
        args.push("--session", config.sessionId);
      }
      if (config.model) {
        args.push("--model", config.model);
      }
      if (config.agent) {
        args.push("--agent", config.agent);
      }

      // OpenCode reads from stdin when not a TTY
      const child = spawnProcess("opencode", args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: config.cwd,
      });

      let stdoutBuffer = "";
      let stderr = "";
      let finalText = "";
      let emittedDelta = false;
      let spawnErrorMessage: string | null = null;
      let timedOut = false;
      let forceKillTimeout: ReturnType<typeof setTimeout> | null = null;
      let capturedSessionId: string | null = null;
      let collectedErrors: string[] = [];

      const closePromise = new Promise<number | null>((resolve) => {
        child.once("error", (error) => {
          const msg = error instanceof Error ? error.message : "opencode failed";
          if ("code" in error && error.code === "ENOENT") {
            spawnErrorMessage = "opencode CLI not found — ensure OpenCode is installed";
          } else {
            spawnErrorMessage = msg;
          }
          resolve(null);
        });
        child.once("close", resolve);
      });

      const runtimeTimeout = setTimeout(() => {
        timedOut = true;
        stderr = stderr
          ? `${stderr}\nopencode timed out after ${maxRuntimeMs}ms`
          : `opencode timed out after ${maxRuntimeMs}ms`;
        child.kill("SIGTERM");
        forceKillTimeout = setTimeout(() => {
          child.kill("SIGKILL");
        }, gracefulShutdownMs);
      }, maxRuntimeMs);

      child.stdin.on("error", () => {
        // Ignore broken pipe when opencode exits early.
      });
      child.stdin.write(input.prompt);
      child.stdin.end();

      if (!child.stdout) {
        yield { type: "failed", error: "opencode has no stdout stream" };
        return;
      }

      if (child.stderr) {
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
      }

      try {
        for await (const chunk of child.stdout) {
          stdoutBuffer +=
            typeof chunk === "string" ? chunk : chunk.toString("utf8");

          while (true) {
            const lineBreak = stdoutBuffer.indexOf("\n");
            if (lineBreak < 0) break;

            const line = stdoutBuffer.slice(0, lineBreak).trim();
            stdoutBuffer = stdoutBuffer.slice(lineBreak + 1);

            if (!line) continue;

            let parsed: OpenCodeJsonEvent | null = null;
            try {
              parsed = JSON.parse(line) as OpenCodeJsonEvent;
            } catch {
              // Ignore non-JSON lines.
            }
            if (!parsed) continue;

            // Capture session ID from any event that carries it
            if (typeof parsed.sessionID === "string" && !capturedSessionId) {
              capturedSessionId = parsed.sessionID;
            }

            // Extract error info
            const errorMsg = extractErrorFromEvent(parsed);
            if (errorMsg) {
              collectedErrors.push(errorMsg);
              continue;
            }

            // Extract text from completed text blocks
            const text = extractTextFromEvent(parsed);
            if (text && text !== finalText) {
              const delta = text.slice(finalText.length);
              if (delta) {
                finalText = text;
                emittedDelta = true;
                yield { type: "delta", text: delta };
              }
            }
          }
        }

        // Process any remaining buffered output
        const trailingLine = stdoutBuffer.trim();
        if (trailingLine) {
          try {
            const parsed = JSON.parse(trailingLine) as OpenCodeJsonEvent;
            if (typeof parsed.sessionID === "string" && !capturedSessionId) {
              capturedSessionId = parsed.sessionID;
            }
            const errorMsg = extractErrorFromEvent(parsed);
            if (errorMsg) {
              collectedErrors.push(errorMsg);
            } else {
              const text = extractTextFromEvent(parsed);
              if (text && text !== finalText) {
                const delta = text.slice(finalText.length);
                if (delta) {
                  finalText = text;
                  emittedDelta = true;
                  yield { type: "delta", text: delta };
                }
              }
            }
          } catch {
            // Ignore trailing non-JSON output.
          }
        }

        const exitCode = await closePromise;
        clearTimeout(runtimeTimeout);

        if (forceKillTimeout) {
          clearTimeout(forceKillTimeout);
        }

        if (timedOut) {
          yield {
            type: "failed",
            error: stderr.trim() || `opencode timed out after ${maxRuntimeMs}ms`,
          };
          return;
        }

        if (spawnErrorMessage) {
          yield { type: "failed", error: spawnErrorMessage };
          return;
        }

        if (exitCode === 0) {
          yield {
            type: "completed",
            finalText: emittedDelta ? undefined : finalText,
            sessionId: capturedSessionId ?? undefined,
          };
          return;
        }

        const errorDetail =
          collectedErrors.length > 0
            ? collectedErrors.join("; ")
            : stderr.trim() || `opencode exited with code ${exitCode ?? "unknown"}`;
        yield { type: "failed", error: errorDetail };
      } catch (error) {
        yield {
          type: "failed",
          error: error instanceof Error ? error.message : "opencode failed",
        };
      } finally {
        clearTimeout(runtimeTimeout);
        if (forceKillTimeout) {
          clearTimeout(forceKillTimeout);
        }
      }
    },
  };
}
