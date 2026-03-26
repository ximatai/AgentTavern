import { Hono } from "hono";

import { db } from "../db/client";
import { members } from "../db/schema";
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_SIZE_BYTES,
  MAX_MESSAGE_ATTACHMENTS,
  MAX_TOTAL_ATTACHMENT_BYTES,
  buildAttachmentContentDisposition,
  cleanupExpiredDraftAttachments,
  createDraftAttachments,
  deleteDraftAttachment,
  normalizeAttachmentMimeType,
  readAttachmentContent,
} from "../lib/message-attachments";
import { verifyWsToken } from "../realtime";
import { now } from "./support";
import { and, eq } from "drizzle-orm";

const attachmentRoutes = new Hono();

attachmentRoutes.post("/api/rooms/:roomId/attachments", async (c) => {
  const roomId = c.req.param("roomId");
  cleanupExpiredDraftAttachments();
  const formData = await c.req.formData().catch(() => null);
  const senderMemberId =
    typeof formData?.get("senderMemberId") === "string"
      ? String(formData.get("senderMemberId")).trim()
      : "";
  const wsToken =
    typeof formData?.get("wsToken") === "string" ? String(formData.get("wsToken")).trim() : "";
  const files = formData
    ? formData
        .getAll("files")
        .filter((value): value is File => value instanceof File)
    : [];

  if (!senderMemberId || !wsToken) {
    return c.json({ error: "senderMemberId and wsToken are required" }, 400);
  }

  if (files.length === 0) {
    return c.json({ error: "at least one file is required" }, 400);
  }

  if (files.length > MAX_MESSAGE_ATTACHMENTS) {
    return c.json(
      { error: `up to ${MAX_MESSAGE_ATTACHMENTS} attachments are allowed per request` },
      400,
    );
  }

  const oversizedFile = files.find((file) => file.size > MAX_ATTACHMENT_SIZE_BYTES);
  if (oversizedFile) {
    return c.json(
      { error: `${oversizedFile.name} exceeds ${MAX_ATTACHMENT_SIZE_BYTES} bytes` },
      400,
    );
  }

  const unsupportedFile = files.find((file) => !normalizeAttachmentMimeType(file.type));
  if (unsupportedFile) {
    return c.json(
      {
        error: `${unsupportedFile.name} has unsupported type ${unsupportedFile.type || "unknown"}. Allowed types: ${Array.from(ALLOWED_ATTACHMENT_MIME_TYPES).join(", ")}`,
      },
      400,
    );
  }

  const totalSizeBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalSizeBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    return c.json(
      { error: `attachments exceed ${MAX_TOTAL_ATTACHMENT_BYTES} bytes in total` },
      400,
    );
  }

  const sender = db
    .select()
    .from(members)
    .where(and(eq(members.id, senderMemberId), eq(members.roomId, roomId)))
    .get();

  if (!sender) {
    return c.json({ error: "sender not found in room" }, 404);
  }

  if (!verifyWsToken(wsToken, senderMemberId, roomId)) {
    return c.json({ error: "invalid wsToken for sender" }, 403);
  }

  const attachments = await createDraftAttachments({
    roomId,
    uploaderMemberId: senderMemberId,
    files,
    createdAt: now(),
  });

  return c.json(attachments, 201);
});

attachmentRoutes.delete("/api/rooms/:roomId/attachments/:attachmentId", async (c) => {
  const roomId = c.req.param("roomId");
  cleanupExpiredDraftAttachments();
  const attachmentId = c.req.param("attachmentId");
  const body = await c.req.json().catch(() => null);
  const senderMemberId =
    typeof body?.senderMemberId === "string" ? body.senderMemberId.trim() : "";
  const wsToken = typeof body?.wsToken === "string" ? body.wsToken.trim() : "";

  if (!senderMemberId || !wsToken) {
    return c.json({ error: "senderMemberId and wsToken are required" }, 400);
  }

  if (!verifyWsToken(wsToken, senderMemberId, roomId)) {
    return c.json({ error: "invalid wsToken for sender" }, 403);
  }

  const deleted = deleteDraftAttachment({
    roomId,
    uploaderMemberId: senderMemberId,
    attachmentId,
  });

  if (!deleted) {
    return c.json({ error: "draft attachment not found" }, 404);
  }

  return c.json({ ok: true });
});

attachmentRoutes.get("/api/attachments/:attachmentId/content", (c) => {
  const content = readAttachmentContent(c.req.param("attachmentId"));

  if (!content) {
    return c.json({ error: "attachment not found" }, 404);
  }

  c.header("content-type", content.mimeType);
  c.header(
    "content-disposition",
    buildAttachmentContentDisposition({
      fileName: content.fileName,
      inline: content.inline,
    }),
  );
  c.header("x-content-type-options", "nosniff");
  c.header("cache-control", "private, max-age=31536000, immutable");
  return new Response(new Uint8Array(content.body), {
    headers: c.res.headers,
  });
});

export { attachmentRoutes };
