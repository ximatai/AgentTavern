import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, message } from "antd";
import type { TextAreaRef } from "antd/es/input/TextArea";
import { PlusOutlined, SendOutlined } from "@ant-design/icons";
import type { PublicMember, PublicMessage } from "@agent-tavern/shared";
import { useTranslation } from "react-i18next";

import { useRoomStore } from "../stores/room";
import { useMessageStore } from "../stores/message";

const MAX_ATTACHMENT_COUNT = 8;
const MAX_ATTACHMENT_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function getMentionQuery(
  input: string,
  caretIndex: number,
): { start: number; end: number; query: string } | null {
  const safeCaret = Math.max(0, Math.min(caretIndex, input.length));
  const beforeCaret = input.slice(0, safeCaret);
  const atIndex = beforeCaret.lastIndexOf("@");

  if (atIndex < 0) return null;

  const prevChar = atIndex === 0 ? "" : beforeCaret[atIndex - 1] ?? "";
  if (prevChar && /[\p{L}\p{N}_]/u.test(prevChar)) return null;

  const query = beforeCaret.slice(atIndex + 1);
  if (/\s/.test(query)) return null;

  let end = atIndex + 1;
  while (end < input.length && !/[\s@]/.test(input[end] ?? "")) {
    end += 1;
  }

  return { start: atIndex, end, query };
}

function mentionSignature(
  mention: { start: number; query: string } | null,
): string {
  return mention ? `${mention.start}:${mention.query}` : "";
}

function getRoleLabel(member: PublicMember, t: (key: string) => string): string {
  if (member.type !== "agent") return t("chat.roleHuman");
  if (member.roleKind === "assistant") return t("chat.roleAssistant");
  return t("chat.roleAgent");
}

type MentionSuggestion = {
  memberId: string;
  displayName: string;
  roleLabel: string;
};

export function InputBar() {
  const { t } = useTranslation();
  const self = useRoomStore((s) => s.self);
  const room = useRoomStore((s) => s.room);
  const members = useRoomStore((s) => s.members);
  const sendMessage = useMessageStore((s) => s.sendMessage);
  const pendingAttachments = useMessageStore((s) => s.pendingAttachments);
  const uploadAttachments = useMessageStore((s) => s.uploadAttachments);
  const removeAttachment = useMessageStore((s) => s.removeAttachment);
  const clearReplyTarget = useMessageStore((s) => s.clearReplyTarget);
  const replyTargetId = useMessageStore((s) => s.replyTargetId);
  const allMessages = useMessageStore((s) => s.messages);

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [composerCaret, setComposerCaret] = useState(0);
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);
  const [dismissedMentionSignature, setDismissedMentionSignature] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<TextAreaRef>(null);

  // Resolve reply target message and sender
  const replyTarget: PublicMessage | undefined = useMemo(
    () => (replyTargetId ? allMessages.find((m) => m.id === replyTargetId) : undefined),
    [replyTargetId, allMessages],
  );
  const replyTargetSender: PublicMember | undefined = useMemo(
    () => (replyTarget ? members.find((m) => m.id === replyTarget.senderMemberId) : undefined),
    [replyTarget, members],
  );

  // Focus textarea when replyTargetId changes
  useEffect(() => {
    if (replyTargetId) {
      textareaRef.current?.focus();
    }
  }, [replyTargetId]);

  const mentionQuery = getMentionQuery(input, composerCaret);
  const mentionMenuVisible =
    !!mentionQuery && mentionSignature(mentionQuery) !== dismissedMentionSignature;
  const mentionSuggestions: MentionSuggestion[] = useMemo(
    () =>
      mentionMenuVisible && mentionQuery && self
        ? members
            .filter((m) => m.id !== self.memberId)
            .filter((m) =>
              m.displayName
                .toLowerCase()
                .startsWith(mentionQuery.query.toLowerCase()),
            )
            .map((m) => ({
              memberId: m.id,
              displayName: m.displayName,
              roleLabel: getRoleLabel(m, t),
            }))
        : [],
    [mentionMenuVisible, mentionQuery, self, members, t],
  );

  // Clear dismissed signature when query changes
  useEffect(() => {
    const sig = mentionSignature(getMentionQuery(input, composerCaret));
    if (sig !== dismissedMentionSignature) {
      setDismissedMentionSignature("");
    }
  }, [composerCaret, dismissedMentionSignature, input]);

  const canSend =
    !!self &&
    !sending &&
    !preparing &&
    (input.trim().length > 0 || pendingAttachments.length > 0);

  function syncCaret(): void {
    const textarea = textareaRef.current?.resizableTextArea?.textArea;
    if (textarea) {
      setComposerCaret(textarea.selectionStart ?? textarea.value.length);
    }
  }

  function applyMentionSuggestion(suggestion: MentionSuggestion): void {
    const textarea = textareaRef.current?.resizableTextArea?.textArea;
    if (!textarea) return;

    const caretIndex = textarea.selectionStart ?? input.length;
    const mq = getMentionQuery(input, caretIndex);
    if (!mq) return;

    const before = input.slice(0, mq.start);
    const after = input.slice(mq.end);
    const nextValue = `${before}@${suggestion.displayName} ${after}`;
    const nextCaretIndex = `${before}@${suggestion.displayName} `.length;

    setInput(nextValue);
    setSelectedMentionIndex(0);
    setDismissedMentionSignature("");

    textarea.focus();
    requestAnimationFrame(() => {
      textarea.setSelectionRange(nextCaretIndex, nextCaretIndex);
      setComposerCaret(nextCaretIndex);
    });
  }

  async function handleSend(): Promise<void> {
    if (!self || !room || sending || preparing) return;
    if (!input.trim() && pendingAttachments.length === 0) return;

    setSending(true);
    try {
      await sendMessage({
        roomId: room.id,
        memberId: self.memberId,
        wsToken: self.wsToken,
        content: input.trim(),
      });
      setInput("");
      clearReplyTarget();
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : t("inputBar.sendFailed"));
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ): void {
    const nativeEvent = event.nativeEvent as {
      isComposing?: boolean;
      keyCode?: number;
    };
    if (nativeEvent.isComposing || nativeEvent.keyCode === 229) {
      return;
    }

    // Mention popup keyboard navigation
    if (mentionSuggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedMentionIndex((i) => (i + 1) % mentionSuggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedMentionIndex(
          (i) => (i - 1 + mentionSuggestions.length) % mentionSuggestions.length,
        );
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        applyMentionSuggestion(
          mentionSuggestions[
            Math.max(
              0,
              Math.min(selectedMentionIndex, mentionSuggestions.length - 1),
            )
          ],
        );
        return;
      }
      if (event.key === "Escape") {
        if (mentionQuery) {
          setDismissedMentionSignature(mentionSignature(mentionQuery));
        }
        setSelectedMentionIndex(0);
        event.preventDefault();
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  }

  const handleBlur = useCallback(() => {
    if (mentionQuery) {
      setDismissedMentionSignature(mentionSignature(mentionQuery));
    }
  }, [mentionQuery]);

  async function handleFileChange(
    event: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    if (!self) return;

    const selectedFiles = Array.from(files);
    const remainingSlots = MAX_ATTACHMENT_COUNT - pendingAttachments.length;

    if (remainingSlots <= 0) {
      message.error(t("inputBar.maxAttachmentsReached"));
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    const acceptedFiles = selectedFiles.slice(0, remainingSlots);
    const oversized = acceptedFiles.find(
      (f) => f.size > MAX_ATTACHMENT_SIZE_BYTES,
    );

    if (oversized) {
      message.error(
        t("inputBar.fileTooLarge", {
          name: oversized.name,
          size: formatFileSize(MAX_ATTACHMENT_SIZE_BYTES),
        }),
      );
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setPreparing(true);
    try {
      await uploadAttachments({
        roomId: room!.id,
        memberId: self.memberId,
        wsToken: self.wsToken,
        files: acceptedFiles,
      });

      if (selectedFiles.length > remainingSlots) {
        message.warning(
          t("inputBar.truncatedAttachments", { count: remainingSlots }),
        );
      }
    } catch (err) {
      message.error(
        err instanceof Error ? err.message : t("inputBar.uploadFailed"),
      );
    } finally {
      setPreparing(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function handleMentionClick(): void {
    const textarea = textareaRef.current?.resizableTextArea?.textArea;
    if (!textarea) return;
    const start = textarea.selectionStart ?? input.length;
    const before = input.slice(0, start);
    const after = input.slice(start);
    const next = `${before}@${after}`;
    setInput(next);
    setDismissedMentionSignature("");
    textarea.focus();
    const nextCaret = start + 1;
    requestAnimationFrame(() => {
      textarea.setSelectionRange(nextCaret, nextCaret);
      setComposerCaret(nextCaret);
    });
  }

  return (
    <div className="input-bar">
      {/* Reply banner */}
      {replyTargetId && (
        <div className="reply-banner">
          <div className="reply-banner-copy">
            <strong>
              {t("inputBar.replyingTo", {
                name: replyTargetSender?.displayName ?? "",
              })}
            </strong>
            <span>
              {replyTarget
                ? replyTarget.content.slice(0, 80)
                : t("inputBar.originalUnavailable")}
            </span>
          </div>
          <button
            type="button"
            className="reply-banner-clear"
            onClick={clearReplyTarget}
          >
            {t("inputBar.replyCancel")}
          </button>
        </div>
      )}

      {/* Mention suggestions popup */}
      {mentionSuggestions.length > 0 && (
        <div className="mention-popup">
          {mentionSuggestions.map((suggestion, index) => (
            <button
              key={suggestion.memberId}
              type="button"
              className={`mention-popup-item${index === selectedMentionIndex ? " mention-popup-item-active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                applyMentionSuggestion(suggestion);
              }}
              onClick={() => applyMentionSuggestion(suggestion)}
            >
              <strong>{suggestion.displayName}</strong>
              <span>{suggestion.roleLabel}</span>
            </button>
          ))}
        </div>
      )}

      {/* Pending attachments */}
      {pendingAttachments.length > 0 && (
        <div className="input-bar-attachments">
          {pendingAttachments.map((att) => (
            <div key={att.id} className="input-bar-attachment-chip">
              <div className="input-bar-attachment-copy">
                <strong>{att.name}</strong>
                <span>{formatFileSize(att.sizeBytes)}</span>
              </div>
              <button
                type="button"
                className="input-bar-attachment-remove"
                onClick={() => {
                  if (!self || !room) return;
                  void removeAttachment({
                    roomId: room.id,
                    memberId: self.memberId,
                    wsToken: self.wsToken,
                    attachmentId: att.id,
                  });
                }}
              >
                {t("inputBar.removeAttachment")}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        className="input-bar-file-input"
        type="file"
        multiple
        onChange={(e) => void handleFileChange(e)}
      />

      {/* Toolbar row: attach + hint */}
      <div className="input-bar-toolbar">
        <button
          type="button"
          className="input-bar-attach-btn"
          disabled={!self || preparing}
          onClick={() => fileInputRef.current?.click()}
        >
          {preparing ? "..." : <PlusOutlined />}
        </button>
        <span className="input-bar-hint">
          {t("inputBar.attachmentHint", {
            maxCount: MAX_ATTACHMENT_COUNT,
            maxSize: formatFileSize(MAX_ATTACHMENT_SIZE_BYTES),
          })}
        </span>
      </div>

      {/* Main row: textarea + side actions + send */}
      <div className="input-bar-main">
        <Input.TextArea
          ref={textareaRef}
          autoSize={{ minRows: 3, maxRows: 8 }}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setDismissedMentionSignature("");
          }}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          onClick={syncCaret}
          onKeyUp={syncCaret}
          onSelect={syncCaret}
          placeholder={t("inputBar.placeholder")}
          disabled={!self}
          className="input-bar-textarea"
          variant="borderless"
        />
        <div className="input-bar-side-actions">
          <button
            type="button"
            className="input-bar-mini-btn"
            onClick={handleMentionClick}
            disabled={!self}
          >
            @
          </button>
          <button
            type="button"
            className="input-bar-mini-btn"
            disabled={!self || preparing}
            onClick={() => fileInputRef.current?.click()}
          >
            {t("inputBar.attachLabel")}
          </button>
        </div>
        <Button
          type="primary"
          icon={<SendOutlined />}
          disabled={!canSend}
          onClick={() => void handleSend()}
          loading={sending}
          className="input-bar-send-btn"
        />
      </div>

      {/* Footnote */}
      <p className="input-bar-footnote">{t("inputBar.footnote")}</p>
    </div>
  );
}
