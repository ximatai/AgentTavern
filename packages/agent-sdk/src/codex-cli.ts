import { spawn } from "node:child_process";

import type { AgentAdapter, AgentRunInput, AgentStreamEvent } from "./index";

export type CodexCliAdapterConfig = {
  threadId: string;
  cwd?: string;
  maxRuntimeMs?: number;
  gracefulShutdownMs?: number;
};

type CodexJsonEvent =
  | {
      type?: string;
      item?: {
        type?: string;
        text?: string;
      };
    }
  | Record<string, unknown>;

function extractTextFromCodexEvent(event: CodexJsonEvent): string | null {
  const eventType = "type" in event ? event.type : undefined;
  const item = "item" in event ? event.item : undefined;

  if (
    eventType === "item.completed" &&
    item &&
    typeof item === "object" &&
    "type" in item &&
    item.type === "agent_message" &&
    "text" in item &&
    typeof item.text === "string"
  ) {
    return item.text;
  }

  return null;
}

export function createCodexCliAdapter(config: CodexCliAdapterConfig): AgentAdapter {
  return {
    async *run(input: AgentRunInput): AsyncIterable<AgentStreamEvent> {
      const maxRuntimeMs = config.maxRuntimeMs ?? 180_000;
      const gracefulShutdownMs = config.gracefulShutdownMs ?? 5_000;
      const child = spawn(
        "codex",
        [
          "exec",
          "resume",
          config.threadId,
          "--json",
          "--ephemeral",
          "-",
        ],
        {
          cwd: config.cwd,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      let stdoutBuffer = "";
      let stderr = "";
      let finalText = "";
      let emittedDelta = false;
      let spawnErrorMessage: string | null = null;
      let timedOut = false;
      let forceKillTimeout: ReturnType<typeof setTimeout> | null = null;

      const closePromise = new Promise<number | null>((resolve) => {
        child.once("error", (error) => {
          spawnErrorMessage = error instanceof Error ? error.message : "codex cli failed";
          resolve(null);
        });
        child.once("close", resolve);
      });

      const runtimeTimeout = setTimeout(() => {
        timedOut = true;
        stderr = stderr
          ? `${stderr}\ncodex cli timed out after ${maxRuntimeMs}ms`
          : `codex cli timed out after ${maxRuntimeMs}ms`;
        child.kill("SIGTERM");
        forceKillTimeout = setTimeout(() => {
          child.kill("SIGKILL");
        }, gracefulShutdownMs);
      }, maxRuntimeMs);

      child.stdin.on("error", () => {
        // Ignore broken pipe when codex exits early.
      });
      child.stdin.write(input.prompt);
      child.stdin.end();

      if (!child.stdout) {
        yield { type: "failed", error: "codex cli has no stdout stream" };
        return;
      }

      if (child.stderr) {
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
      }

      try {
        for await (const chunk of child.stdout) {
          stdoutBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");

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

            let parsed: CodexJsonEvent | null = null;

            try {
              parsed = JSON.parse(line) as CodexJsonEvent;
            } catch {
              // Ignore non-JSON lines emitted by the CLI runtime.
            }

            if (!parsed) {
              continue;
            }

            const eventText = extractTextFromCodexEvent(parsed);

            if (eventText && eventText !== finalText) {
              const delta = eventText.slice(finalText.length);

              if (delta) {
                finalText = eventText;
                emittedDelta = true;
                yield { type: "delta", text: delta };
              }
            }
          }
        }

        const trailingLine = stdoutBuffer.trim();

        if (trailingLine) {
          try {
            const parsed = JSON.parse(trailingLine) as CodexJsonEvent;
            const eventText = extractTextFromCodexEvent(parsed);

            if (eventText && eventText !== finalText) {
              const delta = eventText.slice(finalText.length);

              if (delta) {
                finalText = eventText;
                emittedDelta = true;
                yield { type: "delta", text: delta };
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
            error: stderr.trim() || `codex cli timed out after ${maxRuntimeMs}ms`,
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
          yield { type: "completed", finalText: emittedDelta ? undefined : finalText };
          return;
        }

        yield {
          type: "failed",
          error: stderr.trim() || `codex cli exited with code ${exitCode ?? "unknown"}`,
        };
      } catch (error) {
        yield {
          type: "failed",
          error: error instanceof Error ? error.message : "codex cli failed",
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
