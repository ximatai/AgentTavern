import { spawn } from "node:child_process";

import type { AgentAdapter, AgentRunInput, AgentStreamEvent } from "./index";

export type LocalProcessAdapterConfig = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  inputFormat?: "text" | "json";
  outputFormat?: "text" | "jsonl";
  maxRuntimeMs?: number;
  gracefulShutdownMs?: number;
};

function toPayload(input: AgentRunInput, inputFormat: "text" | "json"): string {
  if (inputFormat === "json") {
    return JSON.stringify(input);
  }

  return input.prompt;
}

function isAgentStreamEvent(value: unknown): value is AgentStreamEvent {
  if (!value || typeof value !== "object") {
    return false;
  }

  const event = value as Record<string, unknown>;
  if (event.type === "delta") {
    return typeof event.text === "string";
  }
  if (event.type === "failed") {
    return typeof event.error === "string";
  }
  if (event.type === "completed") {
    return (
      event.finalText === undefined || typeof event.finalText === "string"
    ) && (
      event.summaryText === undefined || typeof event.summaryText === "string"
    ) && (
      event.sessionId === undefined || typeof event.sessionId === "string"
    ) && (
      event.attachments === undefined || Array.isArray(event.attachments)
    );
  }
  return false;
}

export function createLocalProcessAdapter(
  config: LocalProcessAdapterConfig,
): AgentAdapter {
  return {
    async *run(input: AgentRunInput): AsyncIterable<AgentStreamEvent> {
      const maxRuntimeMs = config.maxRuntimeMs ?? 120_000;
      const gracefulShutdownMs = config.gracefulShutdownMs ?? 5_000;
      const child = spawn(config.command, config.args ?? [], {
        cwd: config.cwd,
        env: {
          ...process.env,
          ...config.env,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const decoder = new TextDecoder();
      let stderr = "";
      let stdoutBuffer = "";
      let spawnErrorMessage: string | null = null;
      let timedOut = false;
      let forceKillTimeout: ReturnType<typeof setTimeout> | null = null;
      let emittedTerminalEvent = false;

      const closePromise = new Promise<number | null>((resolve) => {
        child.once("error", (error) => {
          spawnErrorMessage = error instanceof Error ? error.message : "local process failed";
          resolve(null);
        });
        child.once("close", resolve);
      });

      const runtimeTimeout = setTimeout(() => {
        timedOut = true;
        stderr = stderr
          ? `${stderr}\nlocal process timed out after ${maxRuntimeMs}ms`
          : `local process timed out after ${maxRuntimeMs}ms`;
        child.kill("SIGTERM");
        forceKillTimeout = setTimeout(() => {
          child.kill("SIGKILL");
        }, gracefulShutdownMs);
      }, maxRuntimeMs);

      child.stdin.on("error", () => {
        // Ignore broken pipe errors from fast-exiting children.
      });

      child.stdin.write(toPayload(input, config.inputFormat ?? "text"));
      child.stdin.end();

      if (child.stderr) {
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += decoder.decode(chunk, { stream: true });
        });
      }

      if (!child.stdout) {
        yield {
          type: "failed",
          error: "local process adapter has no stdout stream",
        };
        return;
      }

      try {
        for await (const chunk of child.stdout) {
          const text = typeof chunk === "string" ? chunk : decoder.decode(chunk);

          if (!text) {
            continue;
          }

          if (config.outputFormat === "jsonl") {
            stdoutBuffer += text;

            while (true) {
              const lineBreak = stdoutBuffer.indexOf("\n");
              if (lineBreak < 0) {
                break;
              }

              const line = stdoutBuffer.slice(0, lineBreak).trim();
              stdoutBuffer = stdoutBuffer.slice(lineBreak + 1);

              if (!line) {
                continue;
              }

              let parsed: unknown;
              try {
                parsed = JSON.parse(line);
              } catch {
                yield {
                  type: "failed",
                  error: `local process emitted invalid jsonl: ${line.slice(0, 200)}`,
                };
                emittedTerminalEvent = true;
                return;
              }

              if (!isAgentStreamEvent(parsed)) {
                yield {
                  type: "failed",
                  error: "local process emitted an unsupported event payload",
                };
                emittedTerminalEvent = true;
                return;
              }

              if (parsed.type === "completed" || parsed.type === "failed") {
                emittedTerminalEvent = true;
              }
              yield parsed;
            }
            continue;
          }

          if (text) {
            yield { type: "delta", text };
          }
        }

        if (config.outputFormat === "jsonl") {
          const trailingLine = stdoutBuffer.trim();
          if (trailingLine) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(trailingLine);
            } catch {
              yield {
                type: "failed",
                error: `local process emitted invalid jsonl: ${trailingLine.slice(0, 200)}`,
              };
              emittedTerminalEvent = true;
              return;
            }

            if (!isAgentStreamEvent(parsed)) {
              yield {
                type: "failed",
                error: "local process emitted an unsupported event payload",
              };
              emittedTerminalEvent = true;
              return;
            }

            if (parsed.type === "completed" || parsed.type === "failed") {
              emittedTerminalEvent = true;
            }
            yield parsed;
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
            error: stderr.trim() || `local process timed out after ${maxRuntimeMs}ms`,
          };
          return;
        }

        if (spawnErrorMessage) {
          yield {
            type: "failed",
            error: spawnErrorMessage,
          };
          return;
        }

        if (exitCode === 0) {
          if (emittedTerminalEvent) {
            return;
          }
          yield { type: "completed" };
          return;
        }

        yield {
          type: "failed",
          error: stderr.trim() || `local process exited with code ${exitCode ?? "unknown"}`,
        };
      } catch (error) {
        yield {
          type: "failed",
          error: error instanceof Error ? error.message : "local process failed",
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
