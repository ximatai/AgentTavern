import type {
  AgentAdapter,
  AgentRunInput,
  AgentStreamEvent,
} from "./index";
import type { OpenAICompatibleBackendConfig } from "@agent-tavern/shared";

export type OpenAICompatibleAdapterConfig = OpenAICompatibleBackendConfig & {
  maxRuntimeMs?: number;
};

export type OpenAICompatibleFetch = typeof fetch;

type OpenAICompatibleChunk = {
  id?: string;
  error?: string | { message?: string; type?: string; code?: string } | Record<string, unknown>;
  choices?: Array<{
    delta?: {
      content?: string | Array<{ type?: string; text?: string }>;
      reasoning_content?: string | Array<{ type?: string; text?: string }>;
    };
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
      reasoning_content?: string | Array<{ type?: string; text?: string }>;
    };
    text?: string;
    finish_reason?: string | null;
  }>;
};

type OpenAICompatibleInputContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

function buildUserContent(input: AgentRunInput): string | OpenAICompatibleInputContentPart[] {
  const attachments = input.triggerAttachments ?? [];
  if (attachments.length === 0) {
    return input.prompt;
  }

  const content: OpenAICompatibleInputContentPart[] = [{ type: "text", text: input.prompt }];

  const nonImageNotes: string[] = [];
  for (const attachment of attachments) {
    if (attachment.mimeType.startsWith("image/")) {
      content.push({
        type: "image_url",
        image_url: {
          url: attachment.dataUrl ?? attachment.url,
        },
      });
      continue;
    }

    nonImageNotes.push(`- ${attachment.name} (${attachment.mimeType})`);
  }

  if (nonImageNotes.length > 0) {
    content.push({
      type: "text",
      text: `User attached non-image files:\n${nonImageNotes.join("\n")}`,
    });
  }

  return content;
}

function extractErrorText(errorValue: OpenAICompatibleChunk["error"]): string {
  if (!errorValue) {
    return "";
  }

  if (typeof errorValue === "string") {
    return errorValue.trim();
  }

  if (typeof errorValue === "object") {
    if ("message" in errorValue && typeof errorValue.message === "string" && errorValue.message.trim()) {
      return errorValue.message.trim();
    }

    try {
      return JSON.stringify(errorValue);
    } catch {
      return "";
    }
  }

  return "";
}

function extractTextContent(
  content: string | Array<{ type?: string; text?: string }> | undefined,
): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .flatMap((part) => (part?.type === "text" && typeof part.text === "string" ? [part.text] : []))
      .join("");
  }

  return "";
}

function extractDeltaText(chunk: OpenAICompatibleChunk): string {
  return extractTextContent(chunk.choices?.[0]?.delta?.content);
}

function extractDeltaReasoningText(chunk: OpenAICompatibleChunk): string {
  return extractTextContent(chunk.choices?.[0]?.delta?.reasoning_content);
}

function extractNonStreamingText(chunk: OpenAICompatibleChunk): string {
  const choice = chunk.choices?.[0];
  if (!choice) {
    return "";
  }

  return extractTextContent(choice.message?.content) || (typeof choice.text === "string" ? choice.text : "");
}

function extractNonStreamingReasoningText(chunk: OpenAICompatibleChunk): string {
  const choice = chunk.choices?.[0];
  if (!choice) {
    return "";
  }

  return extractTextContent(choice.message?.reasoning_content);
}

function buildErrorMessage(status: number, bodyText: string): string {
  const trimmed = bodyText.trim();
  return trimmed
    ? `openai-compatible backend request failed (${status}): ${trimmed}`
    : `openai-compatible backend request failed (${status})`;
}

export function createOpenAICompatibleAdapter(
  config: OpenAICompatibleAdapterConfig,
  fetchFn: OpenAICompatibleFetch = fetch,
): AgentAdapter {
  return {
    async *run(input: AgentRunInput): AsyncIterable<AgentStreamEvent> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.maxRuntimeMs ?? 300_000);
      const handleAbort = () => controller.abort();
      input.abortSignal?.addEventListener("abort", handleAbort, { once: true });

      try {
        const headers: Record<string, string> = {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...config.headers,
        };

        if (config.apiKey) {
          headers.authorization = `Bearer ${config.apiKey}`;
        }

        const response = await fetchFn(`${config.baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: config.model,
            stream: true,
            messages: [
              {
                role: "user",
                content: buildUserContent(input),
              },
            ],
            ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
            ...(config.maxTokens !== undefined ? { max_tokens: config.maxTokens } : {}),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "");
          yield { type: "failed", error: buildErrorMessage(response.status, errorText) };
          return;
        }

        if (!response.body) {
          yield { type: "failed", error: "openai-compatible backend returned no response body" };
          return;
        }

        const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
        if (!contentType.includes("text/event-stream")) {
          const bodyText = await response.text().catch(() => "");
          if (!bodyText.trim()) {
            yield { type: "completed", finalText: "" };
            return;
          }

          let parsed: OpenAICompatibleChunk;
          try {
            parsed = JSON.parse(bodyText) as OpenAICompatibleChunk;
          } catch {
            yield {
              type: "failed",
              error: `openai-compatible backend emitted invalid JSON: ${bodyText.slice(0, 200)}`,
            };
            return;
          }

          const errorText = extractErrorText(parsed.error);
          if (errorText) {
            yield {
              type: "failed",
              error: `openai-compatible backend error: ${errorText}`,
            };
            return;
          }

          const reasoningText = extractNonStreamingReasoningText(parsed);
          yield {
            type: "completed",
            finalText: extractNonStreamingText(parsed),
            ...(reasoningText ? { reasoningText } : {}),
          };
          return;
        }

        const decoder = new TextDecoder();
        const reader = response.body.getReader();
        let buffer = "";
        let streamedAny = false;

        while (true) {
          const { done, value } = await reader.read();
          buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

          while (true) {
            const lineBreak = buffer.indexOf("\n");
            if (lineBreak < 0) {
              break;
            }

            const rawLine = buffer.slice(0, lineBreak);
            buffer = buffer.slice(lineBreak + 1);
            const line = rawLine.trim();

            if (!line.startsWith("data:")) {
              continue;
            }

            const data = line.slice(5).trim();
            if (!data) {
              continue;
            }
            if (data === "[DONE]") {
              yield { type: "completed" };
              return;
            }

            let parsed: OpenAICompatibleChunk;
            try {
              parsed = JSON.parse(data) as OpenAICompatibleChunk;
            } catch {
              yield {
                type: "failed",
                error: `openai-compatible backend emitted invalid JSON: ${data.slice(0, 200)}`,
              };
              return;
            }

            const errorText = extractErrorText(parsed.error);
            if (errorText) {
              yield {
                type: "failed",
                error: `openai-compatible backend error: ${errorText}`,
              };
              return;
            }

            const text = extractDeltaText(parsed);
            if (text) {
              streamedAny = true;
              yield { type: "delta", text };
            }

            const reasoning = extractDeltaReasoningText(parsed);
            if (reasoning) {
              yield { type: "reasoning", text: reasoning };
            }

            if (parsed.choices?.[0]?.finish_reason) {
              yield { type: "completed" };
              return;
            }
          }

          if (done) {
            break;
          }
        }

        yield streamedAny ? { type: "completed" } : { type: "completed", finalText: "" };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          yield {
            type: "failed",
            error: input.abortSignal?.aborted
              ? "openai-compatible backend request aborted by caller"
              : "openai-compatible backend request timed out",
          };
          return;
        }

        yield {
          type: "failed",
          error: error instanceof Error ? error.message : "openai-compatible backend request failed",
        };
      } finally {
        clearTimeout(timeout);
        input.abortSignal?.removeEventListener("abort", handleAbort);
      }
    },
  };
}
