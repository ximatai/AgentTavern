import fs from "node:fs";
import path from "node:path";

import { and, eq, inArray, isNull, lt } from "drizzle-orm";

import type { Message, MessageAttachment } from "@agent-tavern/shared";

import { dataDir, db } from "../db/client";
import { messageAttachments, messages } from "../db/schema";
import { createId } from "./id";
import { toDomainMessage } from "./message-records";

export const MAX_MESSAGE_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_SIZE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
  "application/json",
  "application/pdf",
  "application/zip",
  "application/x-zip-compressed",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/csv",
  "text/markdown",
  "text/plain",
]);
export const DRAFT_ATTACHMENT_TTL_MS = Number(
  process.env.AGENT_TAVERN_DRAFT_ATTACHMENT_TTL_MS ?? 24 * 60 * 60 * 1000,
);

const attachmentsDir = process.env.AGENT_TAVERN_ATTACHMENTS_DIR
  ? path.resolve(process.env.AGENT_TAVERN_ATTACHMENTS_DIR)
  : path.join(dataDir, "attachments");

fs.mkdirSync(attachmentsDir, { recursive: true });

type MessageAttachmentRow = typeof messageAttachments.$inferSelect;

function sanitizeAttachmentName(name: string): string {
  const baseName = path.basename(name);
  const trimmed = baseName.trim().replace(/\s+/g, " ");
  const withoutUnsafeChars = trimmed.replace(/[\u0000-\u001f\u007f"%;/\\]/g, "_");
  const withoutLeadingDots = withoutUnsafeChars.replace(/^\.+/, "");
  return withoutLeadingDots.slice(0, 255) || "attachment";
}

export function normalizeAttachmentMimeType(mimeType: string): string | null {
  const normalized = mimeType.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  return ALLOWED_ATTACHMENT_MIME_TYPES.has(normalized) ? normalized : null;
}

function toContentDispositionFileName(fileName: string): {
  asciiFallback: string;
  utf8Encoded: string;
} {
  const asciiFallback = fileName
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_")
    .slice(0, 255) || "attachment";

  return {
    asciiFallback,
    utf8Encoded: encodeURIComponent(fileName),
  };
}

export function buildAttachmentContentDisposition(params: {
  fileName: string;
  inline: boolean;
}): string {
  const { asciiFallback, utf8Encoded } = toContentDispositionFileName(params.fileName);
  return `${params.inline ? "inline" : "attachment"}; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`;
}

function removeStoredAttachmentFile(storagePath: string): void {
  try {
    fs.unlinkSync(storagePath);
  } catch {
    // Ignore missing files so cleanup paths remain idempotent.
  }
}

function isPreviewableImage(mimeType: string): boolean {
  return (
    mimeType === "image/png" ||
    mimeType === "image/jpeg" ||
    mimeType === "image/webp" ||
    mimeType === "image/gif"
  );
}

export function buildAttachmentUrl(attachmentId: string): string {
  return `/api/attachments/${attachmentId}/content`;
}

export function toPublicAttachment(row: Pick<
  MessageAttachmentRow,
  "id" | "originalName" | "mimeType" | "sizeBytes"
>): MessageAttachment {
  return {
    id: row.id,
    name: row.originalName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    url: buildAttachmentUrl(row.id),
  };
}

export function hydrateMessagesWithAttachments(
  messageRows: Array<typeof messages.$inferSelect>,
): Message[] {
  if (messageRows.length === 0) {
    return [];
  }

  const attachments = db
    .select()
    .from(messageAttachments)
    .where(inArray(messageAttachments.messageId, messageRows.map((message) => message.id)))
    .all();

  const attachmentsByMessageId = new Map<string, MessageAttachment[]>();

  for (const attachment of attachments) {
    if (!attachment.messageId) {
      continue;
    }

    const current = attachmentsByMessageId.get(attachment.messageId) ?? [];
    current.push(toPublicAttachment(attachment));
    attachmentsByMessageId.set(attachment.messageId, current);
  }

  return messageRows.map((message) => ({
    ...toDomainMessage(message),
    attachments: attachmentsByMessageId.get(message.id) ?? [],
  }));
}

export async function createDraftAttachments(params: {
  roomId: string;
  uploaderMemberId: string;
  files: File[];
  createdAt: string;
}): Promise<MessageAttachment[]> {
  const created: MessageAttachment[] = [];

  for (const file of params.files) {
    created.push(
      createDraftAttachmentFromBuffer({
        roomId: params.roomId,
        uploaderMemberId: params.uploaderMemberId,
        fileName: file.name,
        mimeType: file.type,
        content: Buffer.from(await file.arrayBuffer()),
        createdAt: params.createdAt,
      }),
    );
  }

  return created;
}

export function createDraftAttachmentFromBuffer(params: {
  roomId: string;
  uploaderMemberId: string;
  fileName: string;
  mimeType: string;
  content: Buffer;
  createdAt: string;
}): MessageAttachment {
  const mimeType = normalizeAttachmentMimeType(params.mimeType);
  if (!mimeType) {
    throw new Error(`unsupported attachment type: ${params.mimeType || "unknown"}`);
  }

  if (params.content.byteLength > MAX_ATTACHMENT_SIZE_BYTES) {
    throw new Error(`attachment exceeds ${MAX_ATTACHMENT_SIZE_BYTES} bytes`);
  }

  const originalName = sanitizeAttachmentName(params.fileName);
  const attachmentId = createId("att");
  const storagePath = path.join(attachmentsDir, attachmentId);
  fs.writeFileSync(storagePath, params.content);

  db.insert(messageAttachments).values({
    id: attachmentId,
    roomId: params.roomId,
    uploaderMemberId: params.uploaderMemberId,
    messageId: null,
    storagePath,
    originalName,
    mimeType,
    sizeBytes: params.content.byteLength,
    createdAt: params.createdAt,
  }).run();

  return {
    id: attachmentId,
    name: originalName,
    mimeType,
    sizeBytes: params.content.byteLength,
    url: buildAttachmentUrl(attachmentId),
  };
}

export function resolveDraftAttachments(params: {
  roomId: string;
  uploaderMemberId: string;
  attachmentIds: string[];
}): MessageAttachment[] | null {
  if (params.attachmentIds.length === 0) {
    return [];
  }

  const rows = db
    .select()
    .from(messageAttachments)
    .where(
      and(
        inArray(messageAttachments.id, params.attachmentIds),
        eq(messageAttachments.roomId, params.roomId),
        eq(messageAttachments.uploaderMemberId, params.uploaderMemberId),
        isNull(messageAttachments.messageId),
      ),
    )
    .all();

  if (rows.length !== params.attachmentIds.length) {
    return null;
  }

  const rowsById = new Map(rows.map((row) => [row.id, row] as const));

  return params.attachmentIds.map((attachmentId) => toPublicAttachment(rowsById.get(attachmentId)!));
}

export function attachDraftsToMessage(params: {
  roomId: string;
  uploaderMemberId: string;
  messageId: string;
  attachmentIds: string[];
}): void {
  for (const attachmentId of params.attachmentIds) {
    const result = db
      .update(messageAttachments)
      .set({ messageId: params.messageId })
      .where(
        and(
          eq(messageAttachments.id, attachmentId),
          eq(messageAttachments.roomId, params.roomId),
          eq(messageAttachments.uploaderMemberId, params.uploaderMemberId),
          isNull(messageAttachments.messageId),
        ),
      )
      .run();

    if (result.changes !== 1) {
      throw new Error(`attachment ${attachmentId} is no longer attachable`);
    }
  }
}

export function deleteDraftAttachment(params: {
  roomId: string;
  uploaderMemberId: string;
  attachmentId: string;
}): boolean {
  const row = db
    .select()
    .from(messageAttachments)
    .where(
      and(
        eq(messageAttachments.id, params.attachmentId),
        eq(messageAttachments.roomId, params.roomId),
        eq(messageAttachments.uploaderMemberId, params.uploaderMemberId),
        isNull(messageAttachments.messageId),
      ),
    )
    .get();

  if (!row) {
    return false;
  }

  db.delete(messageAttachments).where(eq(messageAttachments.id, row.id)).run();
  removeStoredAttachmentFile(row.storagePath);

  return true;
}

export function cleanupExpiredDraftAttachments(referenceTime = Date.now()): number {
  const expiresBefore = new Date(referenceTime - DRAFT_ATTACHMENT_TTL_MS).toISOString();
  const expiredDrafts = db
    .select()
    .from(messageAttachments)
    .where(
      and(
        isNull(messageAttachments.messageId),
        lt(messageAttachments.createdAt, expiresBefore),
      ),
    )
    .all();

  if (expiredDrafts.length === 0) {
    return 0;
  }

  for (const draft of expiredDrafts) {
    db.delete(messageAttachments).where(eq(messageAttachments.id, draft.id)).run();
    removeStoredAttachmentFile(draft.storagePath);
  }

  return expiredDrafts.length;
}

export function readAttachmentContent(attachmentId: string): {
  body: Buffer;
  mimeType: string;
  fileName: string;
  inline: boolean;
} | null {
  const row = db
    .select()
    .from(messageAttachments)
    .where(eq(messageAttachments.id, attachmentId))
    .get();

  if (!row || !fs.existsSync(row.storagePath)) {
    return null;
  }

  return {
    body: fs.readFileSync(row.storagePath),
    mimeType: row.mimeType,
    fileName: row.originalName,
    inline: isPreviewableImage(row.mimeType),
  };
}
