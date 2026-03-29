import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { PublicMember } from "@agent-tavern/shared";

import { useMessageStore } from "../stores/message";
import { useRoomStore } from "../stores/room";
import { MessageRow } from "./MessageRow";

const AUTO_SCROLL_THRESHOLD = 48;

function isToday(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

function getMemberColor(member: PublicMember): string {
  if (member.type === "agent") {
    if (member.roleKind === "assistant") return "#0E7490";
    return "#FBBF24";
  }
  const colors = ["#6366F1", "#22C55E", "#F43F5E", "#A78BFA", "#F59E0B", "#3B82F6"];
  let hash = 0;
  for (let i = 0; i < member.id.length; i++) hash = member.id.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function getMemberInitial(member: PublicMember): string {
  if (member.type === "agent") return "";
  return (member.displayName || "?").charAt(0).toUpperCase();
}

function getAgentRoleLabel(member: PublicMember, owner: PublicMember | undefined): string {
  const ownerName = owner?.displayName ?? "?";
  return member.roleKind === "assistant" ? `${member.displayName} · ${ownerName}的助理` : member.displayName;
}

function buildMessageMemberSnapshot(
  memberId: string,
  message: {
    roomId: string;
    createdAt: string;
    senderDisplayName?: string | null;
    senderType?: PublicMember["type"] | null;
    senderRoleKind?: PublicMember["roleKind"] | null;
    senderPresenceStatus?: PublicMember["presenceStatus"] | null;
  },
): PublicMember | undefined {
  if (!message.senderDisplayName) {
    return undefined;
  }

  return {
    id: memberId,
    roomId: message.roomId,
    principalId: null,
    type: message.senderType ?? "human",
    roleKind: message.senderRoleKind ?? "none",
    displayName: message.senderDisplayName,
    ownerMemberId: null,
    sourcePrivateAssistantId: null,
    presenceStatus: message.senderPresenceStatus ?? "offline",
    runtimeStatus: null,
    createdAt: message.createdAt,
  };
}

export function MessageList() {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const focusedIdRef = useRef<string | null>(null);
  const focusTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const self = useRoomStore((s) => s.self);
  const members = useRoomStore((s) => s.members);
  const streams = useMessageStore((s) => s.streams);
  const rawMessages = useMessageStore((s) => s.messages);

  const messages = useMemo(() => {
    return [...rawMessages, ...Object.values(streams)];
  }, [rawMessages, streams]);

  const memberMap = useMemo(() => {
    const map = new Map<string, PublicMember>();
    for (const m of members) map.set(m.id, m);
    return map;
  }, [members]);

  const sortedMessages = useMemo(() => {
    return [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [messages]);

  const showDayDivider = useMemo(() => {
    if (sortedMessages.length === 0) return false;
    return isToday(sortedMessages[0].createdAt);
  }, [sortedMessages]);

  const focusMessage = useCallback((messageId: string) => {
    focusedIdRef.current = messageId;
    const el = document.querySelector(`[data-message-id="${messageId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    if (focusTimeoutRef.current) clearTimeout(focusTimeoutRef.current);
    focusTimeoutRef.current = setTimeout(() => {
      focusedIdRef.current = null;
      focusTimeoutRef.current = undefined;
    }, 1800);
  }, []);

  const handleReply = useCallback((messageId: string) => {
    useMessageStore.getState().setReplyTarget(messageId);
    const textarea = document.querySelector<HTMLTextAreaElement>(
      ".input-bar-textarea textarea, .input-bar-textarea",
    );
    if (textarea) textarea.focus();
  }, []);

  useEffect(() => {
    return () => {
      if (focusTimeoutRef.current) clearTimeout(focusTimeoutRef.current);
    };
  }, []);

  // Auto-scroll to bottom when new messages arrive (if user hasn't scrolled up)
  const prevCountRef = useRef(sortedMessages.length);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (sortedMessages.length > prevCountRef.current && !userScrolledUp) {
      el.scrollTop = el.scrollHeight;
    }
    prevCountRef.current = sortedMessages.length;
  }, [sortedMessages.length, userScrolledUp]);

  // Scroll to bottom on initial load
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setUserScrolledUp(distFromBottom > AUTO_SCROLL_THRESHOLD);
  }, []);

  return (
    <div className="message-list" ref={scrollRef} onScroll={handleScroll}>
      {showDayDivider && (
        <div className="day-divider">
          <span className="day-divider-pill">{t("chat.today")}</span>
        </div>
      )}

      {sortedMessages.length === 0 && (
        <div className="message-empty">{t("chat.empty")}</div>
      )}

      {sortedMessages.map((msg) => {
        const isStream = "sessionId" in msg;
        const sender = memberMap.get(msg.senderMemberId) ?? buildMessageMemberSnapshot(msg.senderMemberId, msg);
        const isSelf = msg.senderMemberId === self?.memberId;
        const isAgent = sender?.type === "agent" || msg.messageType === "agent_text";
        const isSystemNotice = msg.messageType === "system_notice";
        const isApproval = msg.messageType === "approval_request" || msg.messageType === "approval_result";
        const isStreaming = isStream || msg.id in streams;

        let tone: "human" | "agent" | "notice" | "approval";
        if (isApproval) tone = "approval";
        else if (isSystemNotice) tone = "notice";
        else if (isAgent) tone = "agent";
        else tone = "human";

        const avatarColor = sender ? getMemberColor(sender) : "#64748B";
        const avatarContent = sender
          ? sender.type === "agent"
            ? ""
            : getMemberInitial(sender)
          : "?";
        const isBotAvatar = sender?.type === "agent";

        const authorLabel = sender
          ? sender.type === "agent" && sender.roleKind === "assistant"
            ? getAgentRoleLabel(sender, memberMap.get(sender.ownerMemberId ?? ""))
            : sender.displayName
          : msg.senderDisplayName || msg.senderMemberId;

        const replyTarget = msg.replyToMessageId
          ? sortedMessages.find((m) => m.id === msg.replyToMessageId)
          : undefined;
        const replyTargetSender = replyTarget
          ? memberMap.get(replyTarget.senderMemberId) ?? buildMessageMemberSnapshot(replyTarget.senderMemberId, replyTarget)
          : undefined;

        return (
          <MessageRow
            key={msg.id}
            message={msg}
            authorLabel={authorLabel}
            tone={tone}
            isSelf={isSelf}
            isStreaming={isStreaming}
            avatarColor={avatarColor}
            avatarContent={avatarContent}
            isBotAvatar={isBotAvatar}
            sender={sender}
            replyTarget={replyTarget}
            replyTargetSender={replyTargetSender}
            isFocused={focusedIdRef.current === msg.id}
            onFocusMessage={focusMessage}
            onReply={handleReply}
            memberMap={memberMap}
          />
        );
      })}
    </div>
  );
}

export type { PublicMember };
