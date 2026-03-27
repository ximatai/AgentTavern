import type { MessageAttachment, PublicMessage } from "@agent-tavern/shared";

import { request } from "./client";

async function sendMessage(
  roomId: string,
  params: {
    senderMemberId: string;
    wsToken: string;
    content: string;
    attachmentIds: string[];
    replyToMessageId: string | null;
  },
): Promise<PublicMessage> {
  return request<PublicMessage>(`/api/rooms/${roomId}/messages`, {
    method: "POST",
    body: JSON.stringify(params),
  });
}

async function uploadAttachments(
  roomId: string,
  senderMemberId: string,
  wsToken: string,
  files: File[],
): Promise<MessageAttachment[]> {
  const formData = new FormData();
  formData.set("senderMemberId", senderMemberId);
  formData.set("wsToken", wsToken);

  for (const file of files) {
    formData.append("files", file);
  }

  const response = await fetch(`/api/rooms/${roomId}/attachments`, {
    method: "POST",
    body: formData,
  });

  const payload = (await response.json().catch(() => null)) as
    | MessageAttachment[]
    | { error?: string }
    | null;

  if (!response.ok) {
    throw new Error(
      payload && typeof payload === "object" && "error" in payload && payload.error
        ? payload.error
        : "Upload failed",
    );
  }

  return (payload as MessageAttachment[]) ?? [];
}

async function deletePendingAttachment(
  roomId: string,
  attachmentId: string,
  senderMemberId: string,
  wsToken: string,
): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/rooms/${roomId}/attachments/${attachmentId}`, {
    method: "DELETE",
    body: JSON.stringify({ senderMemberId, wsToken }),
  });
}

export { sendMessage, uploadAttachments, deletePendingAttachment };
