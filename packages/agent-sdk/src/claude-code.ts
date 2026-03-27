import { spawn } from "node:child_process";

import type { AgentAdapter, AgentRunInput, AgentStreamEvent } from "./index";

export type ClaudeCodeAdapterConfig = {
  sessionId?: string;
  cwd?: string;
  model?: string;
  systemPrompt?: string;
  maxRuntimeMs?: number;
  gracefulShutdownMs?: number;
  maxBudgetUsd?: number;
  allowedTools?: string[];
};

/**
 * Raw shape of a stream-json event emitted by `claude -p --output-format stream-json`.
 *
 * We only care about three event types:
 *   - init          → carries session_id
 *   - assistant     → carries incremental text via message.content[].text
 *   - result        → final outcome (subtype: "success" | "error")
 */
type ClaudeStreamJsonEvent = {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  errors?: string[];
  message?: {
    content?: Array<{ type?: string; text?: string }>;
  };
};

function extractTextFromAssistantEvent(
  event: ClaudeStreamJsonEvent,
): string | null {
  const content = event.message?.content;
  if (!Array.isArray(content)) return null;

  let text = "";
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text;
    }
  }
  return text || null;
}

export function createClaudeCodeAdapter(
  config: ClaudeCodeAdapterConfig,
): AgentAdapter {
  return {
    async *run(input: AgentRunInput): AsyncIterable<AgentStreamEvent> {
      const maxRuntimeMs = config.maxRuntimeMs ?? 300_000;
      const gracefulShutdownMs = config.gracefulShutdownMs ?? 5_000;

      const args = [
        "-p",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--dangerously-skip-permissions",
      ];

      // Only pass --resume for values that look like Claude session UUIDs.
      // backendThreadId may be a Codex-style ID (e.g. "thread_xxx") on first run.
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (config.sessionId && UUID_RE.test(config.sessionId)) {
        args.push("--resume", config.sessionId);
      }
      if (config.model) {
        args.push("--model", config.model);
      }
      if (config.systemPrompt) {
        args.push("--system-prompt", config.systemPrompt);
      }
      if (config.maxBudgetUsd != null) {
        args.push("--max-budget-usd", String(config.maxBudgetUsd));
      }
      if (config.allowedTools?.length) {
        args.push("--allowedTools", config.allowedTools.join(","));
      }

      // trailing "-" means prompt is read from stdin
      args.push("-");

      const child = spawn("claude", args, {
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
      let resultSubtype: string | null = null;
      let resultErrors: string[] | null = null;

      const closePromise = new Promise<number | null>((resolve) => {
        child.once("error", (error) => {
          const msg = error instanceof Error ? error.message : "claude cli failed";
          if ("code" in error && error.code === "ENOENT") {
            spawnErrorMessage = "claude CLI not found — ensure Claude Code is installed";
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
          ? `${stderr}\nclaude cli timed out after ${maxRuntimeMs}ms`
          : `claude cli timed out after ${maxRuntimeMs}ms`;
        child.kill("SIGTERM");
        forceKillTimeout = setTimeout(() => {
          child.kill("SIGKILL");
        }, gracefulShutdownMs);
      }, maxRuntimeMs);

      child.stdin.on("error", () => {
        // Ignore broken pipe when claude exits early.
      });
      child.stdin.write(input.prompt);
      child.stdin.end();

      if (!child.stdout) {
        yield { type: "failed", error: "claude cli has no stdout stream" };
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

            let parsed: ClaudeStreamJsonEvent | null = null;
            try {
              parsed = JSON.parse(line) as ClaudeStreamJsonEvent;
            } catch {
              // Ignore non-JSON lines.
            }
            if (!parsed) continue;

            // Capture session_id from system/init event
            if (
              parsed.type === "system" &&
              parsed.subtype === "init" &&
              typeof parsed.session_id === "string"
            ) {
              capturedSessionId = parsed.session_id;
              continue;
            }

            // Track result subtype and errors
            if (parsed.type === "result") {
              resultSubtype = parsed.subtype ?? null;
              if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
                resultErrors = parsed.errors;
              }
              // If there's a result string, treat it as final text
              if (typeof parsed.result === "string" && parsed.result) {
                if (parsed.result !== finalText) {
                  const delta = parsed.result.slice(finalText.length);
                  if (delta) {
                    finalText = parsed.result;
                    emittedDelta = true;
                    yield { type: "delta", text: delta };
                  }
                }
              }
              continue;
            }

            // Extract text from assistant events
            const eventText = extractTextFromAssistantEvent(parsed);
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

        // Process any remaining buffered output
        const trailingLine = stdoutBuffer.trim();
        if (trailingLine) {
          try {
            const parsed = JSON.parse(trailingLine) as ClaudeStreamJsonEvent;
            if (
              parsed.type === "system" &&
              parsed.subtype === "init" &&
              typeof parsed.session_id === "string"
            ) {
              capturedSessionId = parsed.session_id;
            } else if (parsed.type === "result") {
              resultSubtype = parsed.subtype ?? null;
              if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
                resultErrors = parsed.errors;
              }
              if (typeof parsed.result === "string" && parsed.result) {
                const delta = parsed.result.slice(finalText.length);
                if (delta) {
                  finalText = parsed.result;
                  emittedDelta = true;
                  yield { type: "delta", text: delta };
                }
              }
            } else {
              const eventText = extractTextFromAssistantEvent(parsed);
              if (eventText && eventText !== finalText) {
                const delta = eventText.slice(finalText.length);
                if (delta) {
                  finalText = eventText;
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
            error: stderr.trim() || `claude cli timed out after ${maxRuntimeMs}ms`,
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
          resultErrors?.length
            ? resultErrors.join("; ")
            : stderr.trim() || `claude cli exited with code ${exitCode ?? "unknown"}`;
        yield { type: "failed", error: errorDetail };
      } catch (error) {
        yield {
          type: "failed",
          error: error instanceof Error ? error.message : "claude cli failed",
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
