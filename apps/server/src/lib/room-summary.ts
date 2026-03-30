import { eq } from "drizzle-orm";

import type { RoomSummary } from "@agent-tavern/shared";

import { db } from "../db/client";
import { roomSummaries } from "../db/schema";

const ROOM_SUMMARY_BLOCK_RE = /\[\[ROOM_SUMMARY\]\]([\s\S]*?)\[\[\/ROOM_SUMMARY\]\]/m;

export function extractRoomSummaryBlock(content: string): {
  visibleContent: string;
  summaryText: string | null;
} {
  const match = content.match(ROOM_SUMMARY_BLOCK_RE);
  if (!match) {
    return {
      visibleContent: content.trim(),
      summaryText: null,
    };
  }

  const summaryText = match[1]?.trim() || null;
  const visibleContent = content.replace(ROOM_SUMMARY_BLOCK_RE, "").trim();

  return {
    visibleContent,
    summaryText,
  };
}

export function getRoomSummary(roomId: string): RoomSummary | null {
  const row = db
    .select()
    .from(roomSummaries)
    .where(eq(roomSummaries.roomId, roomId))
    .get();

  return (row as RoomSummary | undefined) ?? null;
}

export function upsertRoomSummary(params: {
  roomId: string;
  summaryText: string;
  generatedByMemberId: string;
  sourceMessageId?: string | null;
  createdAt: string;
}): RoomSummary {
  const existing = getRoomSummary(params.roomId);

  if (existing) {
    db
      .update(roomSummaries)
      .set({
        summaryText: params.summaryText,
        generatedByMemberId: params.generatedByMemberId,
        sourceMessageId: params.sourceMessageId ?? null,
        updatedAt: params.createdAt,
      })
      .where(eq(roomSummaries.roomId, params.roomId))
      .run();

    return {
      ...existing,
      summaryText: params.summaryText,
      generatedByMemberId: params.generatedByMemberId,
      sourceMessageId: params.sourceMessageId ?? null,
      updatedAt: params.createdAt,
    };
  }

  const created: RoomSummary = {
    roomId: params.roomId,
    summaryText: params.summaryText,
    generatedByMemberId: params.generatedByMemberId,
    sourceMessageId: params.sourceMessageId ?? null,
    createdAt: params.createdAt,
    updatedAt: params.createdAt,
  };

  db.insert(roomSummaries).values(created).run();
  return created;
}
