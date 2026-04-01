import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "antd";
import { RobotOutlined } from "@ant-design/icons";

import type { MessageAttachment, ApprovalGrantDuration, PublicMember, PublicMessage, SystemMessageStatus } from "@agent-tavern/shared";
import { FileOutlined } from "@ant-design/icons";

import type { SessionStream } from "../types";
import { ApprovalCard } from "./ApprovalCard";

function StreamContent({ content, isStreaming }: { content: string; isStreaming: boolean }) {
  if (!content) return null;
  return (
    <p>
      {content}
      {isStreaming && <span className="stream-cursor">▌</span>}
    </p>
  );
}

type MessageItem = PublicMessage | SessionStream;

type MessageRowProps = {
  message: MessageItem;
  reasoningContent: string;
  authorLabel: string;
  tone: "human" | "agent" | "notice" | "approval";
  isSelf: boolean;
  isStreaming: boolean;
  avatarColor: string;
  avatarContent: string;
  isBotAvatar: boolean;
  sender: PublicMember | undefined;
  replyTarget: MessageItem | undefined;
  replyTargetSender: PublicMember | undefined;
  isFocused: boolean;
  onFocusMessage: (messageId: string) => void;
  onReply: (messageId: string) => void;
  memberMap: Map<string, PublicMember>;
};

function ReasoningBlock({
  reasoningContent,
  isStreaming,
}: {
  reasoningContent: string;
  isStreaming: boolean;
}) {
  const { t } = useTranslation();
  if (!reasoningContent) return null;

  return (
    <details className="reasoning-block">
      <summary className="reasoning-summary">
        <span>{t("chat.reasoning")}</span>
        {isStreaming ? <span className="reasoning-status">{t("chat.reasoningStreaming")}</span> : null}
      </summary>
      <div className="reasoning-content">
        <p>
          {reasoningContent}
          {isStreaming && <span className="stream-cursor">▌</span>}
        </p>
      </div>
    </details>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

function roleTone(member: PublicMember): string {
  if (member.type === "agent") return member.roleKind === "assistant" ? "assistant" : "agent";
  return "human";
}

function roleLabel(member: PublicMember, t: (key: string) => string): string {
  if (member.type === "agent") {
    if (member.roleKind === "assistant") return t("chat.roleAssistant");
    return t("chat.roleAgent");
  }
  return t("chat.roleHuman");
}

function getRoleBadgeColor(tone: string): CSSProperties {
  switch (tone) {
    case "assistant":
      return { backgroundColor: "#0E749033", color: "#22D3EE" };
    case "agent":
      return { backgroundColor: "#FBBF2433", color: "#FBBF24" };
    default:
      return { backgroundColor: "#94A3B833", color: "#94A3B8" };
  }
}

const ALERT_STATUS_MAP: Record<SystemMessageStatus, "info" | "success" | "warning" | "error"> = {
  info: "info",
  success: "success",
  warning: "warning",
  error: "error",
};

function systemTitleKey(kind: string): string | null {
  switch (kind) {
    case "agent_failed":
      return "systemNotice.agentFailed";
    case "agent_busy":
      return "systemNotice.agentBusy";
    case "agent_unavailable":
      return "systemNotice.agentUnavailable";
    case "bridge_attach_required":
      return "systemNotice.bridgeAttachRequired";
    case "bridge_waiting":
      return "systemNotice.bridgeWaiting";
    case "approval_required":
      return "systemNotice.approvalRequired";
    case "approval_granted":
      return "systemNotice.approvalGranted";
    case "approval_rejected":
      return "systemNotice.approvalRejected";
    case "approval_expired":
      return "systemNotice.approvalExpired";
    case "approval_owner_offline":
      return "systemNotice.ownerUnavailable";
    default:
      return null;
  }
}

function isImageAttachment(att: MessageAttachment): boolean {
  return att.mimeType.startsWith("image/");
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function MessageAttachments({ attachments }: { attachments: MessageAttachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <div className="message-attachments">
      {attachments.map((att) => (
        <a
          key={att.id}
          className="message-attachment"
          href={att.url}
          download={att.name}
          target="_blank"
          rel="noreferrer"
        >
          {isImageAttachment(att) ? (
            <img src={att.url} alt={att.name} className="message-attachment-preview" />
          ) : (
            <span className="message-attachment-icon"><FileOutlined /></span>
          )}
          <span className="message-attachment-copy">
            <strong>{att.name}</strong>
            <span>{formatFileSize(att.sizeBytes)}</span>
          </span>
        </a>
      ))}
    </div>
  );
}

function grantLabel(duration: ApprovalGrantDuration, t: (key: string) => string): string {
  const map: Record<ApprovalGrantDuration, string> = {
    once: t("systemNotice.grantOnce"),
    "10_minutes": t("systemNotice.grant10m"),
    "30_minutes": t("systemNotice.grant30m"),
    "1_hour": t("systemNotice.grant1h"),
    forever: t("systemNotice.grantForever"),
  };
  return map[duration];
}

export function MessageRow({
  message,
  reasoningContent,
  authorLabel,
  tone,
  isSelf,
  isStreaming,
  avatarColor,
  avatarContent,
  isBotAvatar,
  sender,
  replyTarget,
  replyTargetSender,
  isFocused,
  onFocusMessage,
  onReply,
  memberMap,
}: MessageRowProps) {
  const { t } = useTranslation();

  // Notice messages: centered system card
  if (tone === "notice") {
    const sysData = message.systemData;
    if (sysData) {
      const alertType = ALERT_STATUS_MAP[sysData.status] ?? "info";
      const facts: string[] = [];
      if (sysData.agentMemberId) {
        const m = memberMap.get(sysData.agentMemberId);
        facts.push(`${t("systemNotice.agent")}: ${m?.displayName ?? sysData.agentMemberId}`);
      }
      if (sysData.ownerMemberId) {
        const m = memberMap.get(sysData.ownerMemberId);
        facts.push(`${t("systemNotice.owner")}: ${m?.displayName ?? sysData.ownerMemberId}`);
      }
      if (sysData.requesterMemberId) {
        const m = memberMap.get(sysData.requesterMemberId);
        facts.push(`${t("systemNotice.requester")}: ${m?.displayName ?? sysData.requesterMemberId}`);
      }
      if (sysData.grantDuration) {
        facts.push(`${t("systemNotice.grant")}: ${grantLabel(sysData.grantDuration, t)}`);
      }

      return (
        <div className="notice-wrap">
          <div className="system-notice-card">
            <Alert
              type={alertType}
              showIcon
              message={
                <strong>
                  {systemTitleKey(sysData.kind)
                    ? t(systemTitleKey(sysData.kind)!)
                    : sysData.title}
                </strong>
              }
              description={
                <div className="system-notice-body">
                  {sysData.detail && <p className="system-notice-detail">{sysData.detail}</p>}
                  {facts.length > 0 && (
                    <div className="system-notice-facts">
                      {facts.map((fact) => (
                        <span key={fact} className="system-notice-fact">{fact}</span>
                      ))}
                    </div>
                  )}
                </div>
              }
            />
          </div>
        </div>
      );
    }
    return (
      <div className="notice-wrap">
        <span className="notice-pill">{message.content}</span>
      </div>
    );
  }

  const senderRole = sender ? roleTone(sender) : "";
  const senderRoleLabel = sender ? roleLabel(sender, t) : "";
  const badgeStyle = senderRole ? getRoleBadgeColor(senderRole) : undefined;

  // Approval messages: card with summary + decision controls
  if (tone === "approval") {
    const sysData = message.systemData;
    if (sysData) {
      return (
        <article
          data-message-id={message.id}
          className={`chat-row chat-row-approval ${isFocused ? "chat-row-focused" : ""}`}
        >
          <div className="chat-avatar" style={{ backgroundColor: "#0E7490" }}>
            <RobotOutlined style={{ color: "#fff", fontSize: 14 }} />
          </div>
          <div className="chat-row-content">
            <div className="chat-meta">
              <div className="chat-author">
                <strong style={{ color: "#22D3EE" }}>{authorLabel}</strong>
                <span className="role-pill role-pill-approval">{t("chat.roleApproval")}</span>
              </div>
              <span className="chat-time">{formatTime(message.createdAt)}</span>
            </div>
            <ApprovalCard
              sysData={sysData}
              memberMap={memberMap}
              replyToMessageId={message.replyToMessageId}
              onFocusMessage={onFocusMessage}
            />
          </div>
        </article>
      );
    }
  }

  // Self messages: right-aligned, reversed layout
  if (isSelf) {
    return (
      <div className="own-wrap">
        <article
          data-message-id={message.id}
          className={`chat-row chat-row-self ${isFocused ? "chat-row-focused" : ""}`}
        >
          <div className="chat-avatar" style={{ backgroundColor: "#22D3EE" }}>
            {avatarContent ? (
              <span className="avatar-text">{avatarContent}</span>
            ) : (
              <RobotOutlined style={{ color: "#fff", fontSize: 16 }} />
            )}
          </div>
          <div className="chat-row-content">
            <div className="own-bubble">
              {replyTarget && replyTargetSender && (
                <button
                  type="button"
                  className="reply-preview"
                  onClick={() => onFocusMessage(replyTarget.id)}
                >
                  <strong>
                    {t("chat.replyTo")} {replyTargetSender.displayName}
                  </strong>
                  <span>{replyTarget.content.slice(0, 60)}</span>
                </button>
              )}
              <ReasoningBlock reasoningContent={reasoningContent} isStreaming={isStreaming} />
              <StreamContent content={message.content} isStreaming={isStreaming} />
              <MessageAttachments attachments={message.attachments} />
            </div>
            <div className="chat-actions" style={{ justifyContent: "flex-end" }}>
              <button
                type="button"
                className="chat-action-button"
                onClick={() => onReply(message.id)}
              >
                {t("chat.reply")}
              </button>
            </div>
          </div>
        </article>
      </div>
    );
  }

  // Normal messages: avatar + content
  return (
    <article
      data-message-id={message.id}
      className={`chat-row chat-row-${tone} ${isFocused ? "chat-row-focused" : ""}`}
    >
      <div className="chat-avatar" style={{ backgroundColor: avatarColor }}>
        {isBotAvatar ? (
          <RobotOutlined style={{ color: "#fff", fontSize: 16 }} />
        ) : (
          <span className="avatar-text">{avatarContent}</span>
        )}
      </div>
      <div className="chat-row-content">
        <div className="chat-meta">
          <div className="chat-author">
            <strong style={tone === "agent" ? { color: "#22D3EE" } : undefined}>{authorLabel}</strong>
            {senderRoleLabel && (
              <span className="role-pill" style={badgeStyle}>
                {senderRoleLabel}
              </span>
            )}
            {isStreaming && <span className="stream-pill">{t("chat.streaming")}</span>}
          </div>
          <span className="chat-time">{formatTime(message.createdAt)}</span>
        </div>
        <div className={`chat-bubble chat-bubble-${tone}`}>
          {replyTarget && replyTargetSender && (
            <button
              type="button"
              className="reply-preview"
              onClick={() => onFocusMessage(replyTarget.id)}
            >
              <strong>
                {t("chat.replyTo")} {replyTargetSender.displayName}
              </strong>
              <span>{replyTarget.content.slice(0, 60)}</span>
            </button>
          )}
          <ReasoningBlock reasoningContent={reasoningContent} isStreaming={isStreaming} />
          <StreamContent content={message.content} isStreaming={isStreaming} />
          <MessageAttachments attachments={message.attachments} />
        </div>
        <div className="chat-actions">
          <button
            type="button"
            className="chat-action-button"
            onClick={() => onReply(message.id)}
          >
            {t("chat.reply")}
          </button>
        </div>
      </div>
    </article>
  );
}
