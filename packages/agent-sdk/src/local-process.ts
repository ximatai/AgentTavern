import { spawn } from "node:child_process";

import type { AgentAdapter, AgentRunInput, AgentStreamEvent } from "./index";

export type LocalProcessAdapterConfig = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  inputFormat?: "text" | "json";
  maxRuntimeMs?: number;
  gracefulShutdownMs?: number;
};

function toPayload(input: AgentRunInput, inputFormat: "text" | "json"): string {
  if (inputFormat === "json") {
    return JSON.stringify(input);
  }

  return input.prompt;
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
      let spawnErrorMessage: string | null = null;
      let timedOut = false;
      let forceKillTimeout: ReturnType<typeof setTimeout> | null = null;

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

          if (text) {
            yield { type: "delta", text };
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
