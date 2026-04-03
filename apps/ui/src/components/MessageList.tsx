import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { PublicMember, PublicMessage } from "@agent-tavern/shared";

import { useMessageStore } from "../stores/message";
import { useRoomStore } from "../stores/room";
import { useSessionStore } from "../stores/session";
import type { SessionStream } from "../types";
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
    citizenId: null,
    type: message.senderType ?? "human",
    roleKind: message.senderRoleKind ?? "none",
    displayName: message.senderDisplayName,
    ownerMemberId: null,
    sourcePrivateAssistantId: null,
    presenceStatus: message.senderPresenceStatus ?? "offline",
    runtimeStatus: null,
    membershipStatus: "active",
    leftAt: null,
    createdAt: message.createdAt,
  };
}

function isSessionStream(message: PublicMessage | SessionStream): message is SessionStream {
  return "sessionId" in message && typeof message.sessionId === "string";
}

export function MessageList() {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const focusedIdRef = useRef<string | null>(null);
  const focusTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const autoScrollRafRef = useRef<number | null>(null);

  const self = useRoomStore((s) => s.self);
  const members = useRoomStore((s) => s.members);
  const streams = useMessageStore((s) => s.streams);
  const rawMessages = useMessageStore((s) => s.messages);
  const sessionSnapshots = useSessionStore((s) => s.sessionSnapshots);

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

  const visibleMessages = useMemo(() => {
    const resolvedApprovalIds = new Set(
      sortedMessages.flatMap((message) =>
        message.messageType === "approval_result" && message.systemData?.approvalId
          ? [message.systemData.approvalId]
          : [],
      ),
    );

    return sortedMessages.filter((message) => {
      if (message.messageType !== "approval_request") {
        return true;
      }

      const approvalId = message.systemData?.approvalId;
      return !approvalId || !resolvedApprovalIds.has(approvalId);
    });
  }, [sortedMessages]);

  const showDayDivider = useMemo(() => {
    if (visibleMessages.length === 0) return false;
    return isToday(visibleMessages[0].createdAt);
  }, [visibleMessages]);

  const lastMessageSignature = useMemo(() => {
    const last = visibleMessages.at(-1);
    if (!last) return "";

    const streamReasoning = isSessionStream(last) ? last.reasoningContent ?? "" : "";
    const isLastStreaming = isSessionStream(last) || last.id in streams;
    return [
      last.id,
      isLastStreaming ? "streaming" : "settled",
      last.createdAt,
      last.messageType,
      last.content,
      streamReasoning,
      last.attachments.length,
    ].join("|");
  }, [visibleMessages, streams]);

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
      if (autoScrollRafRef.current !== null) {
        window.cancelAnimationFrame(autoScrollRafRef.current);
        autoScrollRafRef.current = null;
      }
    };
  }, []);

  // Auto-scroll to bottom when the tail message changes or grows,
  // unless the user has explicitly scrolled up.
  const prevTailSignatureRef = useRef(lastMessageSignature);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (lastMessageSignature !== prevTailSignatureRef.current && !userScrolledUp) {
      const syncToBottom = () => {
        const current = scrollRef.current;
        if (!current) return;
        current.scrollTop = current.scrollHeight;
      };

      syncToBottom();
      if (autoScrollRafRef.current !== null) {
        window.cancelAnimationFrame(autoScrollRafRef.current);
      }
      autoScrollRafRef.current = window.requestAnimationFrame(() => {
        syncToBottom();
        autoScrollRafRef.current = window.requestAnimationFrame(() => {
          syncToBottom();
          autoScrollRafRef.current = null;
        });
      });
    }
    prevTailSignatureRef.current = lastMessageSignature;
  }, [lastMessageSignature, userScrolledUp]);

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

      {visibleMessages.length === 0 && (
        <div className="message-empty">{t("chat.empty")}</div>
      )}

      {visibleMessages.map((msg) => {
        const isStream = isSessionStream(msg);
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
          ? visibleMessages.find((m) => m.id === msg.replyToMessageId) ?? sortedMessages.find((m) => m.id === msg.replyToMessageId)
          : undefined;
        const replyTargetSender = replyTarget
          ? memberMap.get(replyTarget.senderMemberId) ?? buildMessageMemberSnapshot(replyTarget.senderMemberId, replyTarget)
          : undefined;
        const sessionSnapshot = isStream
          ? sessionSnapshots[msg.sessionId]
          : Object.values(sessionSnapshots).find((session) => session.outputMessageId === msg.id);
        const streamReasoning = isStream ? msg.reasoningContent : undefined;
        const reasoningContent = streamReasoning ?? sessionSnapshot?.reasoningText ?? "";

        return (
          <MessageRow
            key={msg.id}
            message={msg}
            reasoningContent={reasoningContent}
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
