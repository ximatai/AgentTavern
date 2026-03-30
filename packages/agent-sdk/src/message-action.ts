import type { AgentMessageAction, AgentStreamEvent } from "./index";

export function completedEventToAction(params: {
  event: Extract<AgentStreamEvent, { type: "completed" }>;
  streamedText: string;
  fallbackText?: string;
}): AgentMessageAction {
  const { event, streamedText, fallbackText } = params;
  const defaultContent = event.finalText !== undefined ? event.finalText : (streamedText || fallbackText);

  if (event.action) {
    return {
      content: event.action.content ?? defaultContent,
      summaryText: event.action.summaryText ?? event.summaryText,
      mentionedDisplayNames: event.action.mentionedDisplayNames ?? event.mentionedDisplayNames,
      attachments: event.action.attachments ?? event.attachments,
    };
  }

  return {
    content: defaultContent,
    summaryText: event.summaryText,
    mentionedDisplayNames: event.mentionedDisplayNames,
    attachments: event.attachments,
  };
}

export function compactMessageAction(action: AgentMessageAction): AgentMessageAction {
  return {
    ...(typeof action.content === "string" ? { content: action.content } : {}),
    ...(typeof action.summaryText === "string" ? { summaryText: action.summaryText } : {}),
    ...(Array.isArray(action.mentionedDisplayNames) && action.mentionedDisplayNames.length > 0
      ? { mentionedDisplayNames: [...action.mentionedDisplayNames] }
      : {}),
    ...(Array.isArray(action.attachments) && action.attachments.length > 0
      ? { attachments: action.attachments.map((attachment) => ({ ...attachment })) }
      : {}),
  };
}
