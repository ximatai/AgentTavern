import { useEffect, useRef, useState, type KeyboardEvent, type UIEvent } from "react";

import type {
  ApprovalGrantDuration,
  MessageAttachment,
  PublicApproval,
  PublicMessage,
  PublicMember,
  RealtimeEvent,
  Room,
} from "@agent-tavern/shared";

type SessionStream = {
  sessionId: string;
  messageId: string;
  agentMemberId: string;
  content: string;
};

type SessionActor = {
  agentMemberId: string;
};

type JoinResult = {
  memberId: string;
  roomId: string;
  displayName: string;
  wsToken: string;
};

type AssistantInviteResult = {
  id: string;
  roomId: string;
  ownerMemberId: string;
  presetDisplayName: string | null;
  backendType: "codex_cli" | "local_process";
  inviteToken: string;
  inviteUrl: string;
  status: "pending" | "accepted" | "expired" | "revoked";
  expiresAt: string;
  createdAt: string;
};

type MentionSuggestion = {
  memberId: string;
  displayName: string;
  roleLabel: string;
};

const MAX_ATTACHMENT_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENT_COUNT = 8;

function mentionSignature(mention: { start: number; query: string } | null): string {
  return mention ? `${mention.start}:${mention.query}` : "";
}

const demoAgentArgs = [
  "--input-type=module",
  "-e",
  "let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',async()=>{const lines=input.trim().split('\\n').filter(Boolean);const tail=lines.at(-1) ?? 'ready';const reply=`Tavern demo agent: ${tail}`;for (const chunk of [reply.slice(0, 18), reply.slice(18)]) { if (!chunk) continue; process.stdout.write(chunk); await new Promise(r=>setTimeout(r,120)); }});",
].join("\n");

const approvalGrantOptions: Array<{ value: ApprovalGrantDuration; label: string }> = [
  { value: "once", label: "仅一次" },
  { value: "10_minutes", label: "10分钟内有效" },
  { value: "30_minutes", label: "30分钟内有效" },
  { value: "1_hour", label: "1小时内有效" },
  { value: "forever", label: "永久有效" },
];

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const payload = (await response.json().catch(() => null)) as T | { error?: string } | null;

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload && payload.error
        ? payload.error
        : `request failed with status ${response.status}`;
    throw new Error(message);
  }

  return payload as T;
}

function extractInviteToken(input: string): string {
  const trimmed = input.trim();

  if (!trimmed) {
    return "";
  }

  if (!trimmed.includes("/")) {
    return trimmed;
  }

  const parts = trimmed.split("/");
  return parts.at(-1)?.trim() ?? "";
}

function sortByCreatedAt<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function isRealtimeEvent(payload: unknown): payload is RealtimeEvent {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  return "type" in payload && typeof payload.type === "string" && "payload" in payload;
}

function roleLabel(member: Pick<PublicMember, "type" | "roleKind">): string {
  if (member.type !== "agent") {
    return "human";
  }

  return member.roleKind === "assistant" ? "assistant" : "agent";
}

function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }

  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImageAttachment(attachment: MessageAttachment): boolean {
  return /^(image\/png|image\/jpeg|image\/webp|image\/gif)$/.test(attachment.mimeType);
}

function runtimeLabel(member: PublicMember): string | null {
  switch (member.runtimeStatus) {
    case "ready":
      return "connected";
    case "pending_bridge":
      return "pending bridge";
    case "waiting_bridge":
      return "waiting bridge";
    default:
      return null;
  }
}

function getMentionQuery(
  input: string,
  caretIndex: number,
): { start: number; end: number; query: string } | null {
  const safeCaret = Math.max(0, Math.min(caretIndex, input.length));
  const beforeCaret = input.slice(0, safeCaret);
  const atIndex = beforeCaret.lastIndexOf("@");

  if (atIndex < 0) {
    return null;
  }

  const prevChar = atIndex === 0 ? "" : beforeCaret[atIndex - 1] ?? "";
  if (prevChar && /[\p{L}\p{N}_]/u.test(prevChar)) {
    return null;
  }

  const query = beforeCaret.slice(atIndex + 1);
  if (/\s/.test(query)) {
    return null;
  }

  let end = atIndex + 1;
  while (end < input.length && !/[\s@]/.test(input[end] ?? "")) {
    end += 1;
  }

  return { start: atIndex, end, query };
}

function App() {
  const [roomName, setRoomName] = useState("Tavern Room");
  const [nickname, setNickname] = useState("Alice");
  const [inviteInput, setInviteInput] = useState("");
  const [messageInput, setMessageInput] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<MessageAttachment[]>([]);
  const [agentName, setAgentName] = useState("BackendDev");
  const [agentRoleKind, setAgentRoleKind] = useState<"independent" | "assistant">(
    "independent",
  );
  const [agentCommand, setAgentCommand] = useState("node");
  const [agentArgsText, setAgentArgsText] = useState(demoAgentArgs);
  const [agentInputFormat, setAgentInputFormat] = useState<"text" | "json">("text");
  const [assistantOwnerId, setAssistantOwnerId] = useState("");
  const [assistantInviteName, setAssistantInviteName] = useState("CodexThreadA");
  const [assistantInviteUrl, setAssistantInviteUrl] = useState("");
  const [room, setRoom] = useState<Room | null>(null);
  const [self, setSelf] = useState<JoinResult | null>(null);
  const [members, setMembers] = useState<PublicMember[]>([]);
  const [messages, setMessages] = useState<PublicMessage[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<PublicApproval[]>([]);
  const [streams, setStreams] = useState<Record<string, SessionStream>>({});
  const [sessionActors, setSessionActors] = useState<Record<string, SessionActor>>({});
  const [statusText, setStatusText] = useState("Ready");
  const [flashText, setFlashText] = useState("");
  const [errorText, setErrorText] = useState("");
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const [isPreparingAttachments, setIsPreparingAttachments] = useState(false);
  const [approvalActionId, setApprovalActionId] = useState("");
  const [approvalGrantById, setApprovalGrantById] = useState<Record<string, ApprovalGrantDuration>>({});
  const [isCopyingRoomInvite, setIsCopyingRoomInvite] = useState(false);
  const [isCopyingAssistantInvite, setIsCopyingAssistantInvite] = useState(false);
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);
  const [composerCaret, setComposerCaret] = useState(0);
  const [dismissedMentionSignature, setDismissedMentionSignature] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const selfRef = useRef<JoinResult | null>(null);
  const sessionActorsRef = useRef<Record<string, SessionActor>>({});
  const messageStreamRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const autoScrollRef = useRef(true);

  useEffect(() => {
    selfRef.current = self;
  }, [self]);

  useEffect(() => {
    sessionActorsRef.current = sessionActors;
  }, [sessionActors]);

  useEffect(() => {
    if (!flashText) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setFlashText("");
    }, 2200);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [flashText]);

  useEffect(() => {
    setSelectedMentionIndex(0);
  }, [messageInput]);

  useEffect(() => {
    const nextMentionQuery = getMentionQuery(messageInput, composerCaret);

    if (mentionSignature(nextMentionQuery) !== dismissedMentionSignature) {
      setDismissedMentionSignature("");
    }
  }, [composerCaret, dismissedMentionSignature, messageInput]);

  useEffect(() => {
    const container = messageStreamRef.current;

    if (!container || !autoScrollRef.current) {
      return;
    }

    container.scrollTo({
      top: container.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, streams]);

  useEffect(() => {
    return () => {
      socketRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (!room?.id) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void request<PublicMember[]>(`/api/rooms/${room.id}/members`)
        .then((nextMembers) => {
          setMembers(nextMembers);
        })
        .catch(() => {
          // Keep the current snapshot until the next successful refresh.
        });
    }, 10_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [room?.id]);

  async function hydrateRoomState(nextRoomId: string): Promise<void> {
    const [nextRoom, nextMembers, nextMessages] = await Promise.all([
      request<Room>(`/api/rooms/${nextRoomId}`),
      request<PublicMember[]>(`/api/rooms/${nextRoomId}/members`),
      request<PublicMessage[]>(`/api/rooms/${nextRoomId}/messages`),
    ]);

    autoScrollRef.current = true;
    setRoom(nextRoom);
    setMembers(nextMembers);
    setMessages(sortByCreatedAt(nextMessages));
    setPendingApprovals([]);
    setStreams({});
    setSessionActors({});
  }

  function connectSocket(joinResult: JoinResult): void {
    socketRef.current?.close();

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(
      `${protocol}//${window.location.host}/ws?roomId=${joinResult.roomId}&memberId=${joinResult.memberId}&wsToken=${joinResult.wsToken}`,
    );

    socket.addEventListener("open", () => {
      setStatusText("Realtime connected");
    });

    socket.addEventListener("close", () => {
      setStatusText("Realtime disconnected");
    });

    socket.addEventListener("message", (event) => {
      const rawPayload = JSON.parse(String(event.data)) as unknown;

      if (!isRealtimeEvent(rawPayload)) {
        return;
      }

      const payload = rawPayload;

      if (payload.type === "member.joined") {
        setMembers((current) => {
          const next = current.filter((member) => member.id !== payload.payload.member.id);
          next.push(payload.payload.member);
          return next;
        });
        return;
      }

      if (payload.type === "message.created") {
        setMessages((current) => {
          const next = current.filter((message) => message.id !== payload.payload.message.id);
          next.push(payload.payload.message);
          return sortByCreatedAt(next);
        });
        setStreams((current) => {
          const next = { ...current };
          delete next[payload.payload.message.id];
          return next;
        });
        return;
      }

      if (payload.type === "approval.requested") {
        setPendingApprovals((current) => {
          const next = current.filter((approval) => approval.id !== payload.payload.approval.id);
          next.push(payload.payload.approval);
          return next;
        });
        return;
      }

      if (payload.type === "approval.resolved") {
        setPendingApprovals((current) =>
          current.filter((approval) => approval.id !== payload.payload.approval.id),
        );
        return;
      }

      if (payload.type === "agent.session.started") {
        setSessionActors((current) => ({
          ...current,
          [payload.payload.session.id]: {
            agentMemberId: payload.payload.session.agentMemberId,
          },
        }));
        return;
      }

      if (payload.type === "agent.stream.delta") {
        setStreams((current) => {
          const actor = sessionActorsRef.current[payload.payload.sessionId];
          const existing = current[payload.payload.messageId];

          return {
            ...current,
            [payload.payload.messageId]: {
              sessionId: payload.payload.sessionId,
              messageId: payload.payload.messageId,
              agentMemberId: existing?.agentMemberId ?? actor?.agentMemberId ?? "",
              content: `${existing?.content ?? ""}${payload.payload.delta}`,
            },
          };
        });
        return;
      }

      if (payload.type === "agent.message.committed") {
        setStreams((current) => {
          const next = { ...current };
          delete next[payload.payload.message.id];
          return next;
        });
        return;
      }
    });

    socketRef.current = socket;
  }

  async function finishJoin(joinResult: JoinResult): Promise<void> {
    await hydrateRoomState(joinResult.roomId);
    setSelf(joinResult);
    setAssistantOwnerId(joinResult.memberId);
    connectSocket(joinResult);
  }

  async function handleCreateRoom(): Promise<void> {
    setErrorText("");
    setStatusText("Creating room");

    try {
      const createdRoom = await request<{
        id: string;
        inviteToken: string;
      }>("/api/rooms", {
        method: "POST",
        body: JSON.stringify({ name: roomName }),
      });
      const joinResult = await request<JoinResult>(`/api/rooms/${createdRoom.id}/join`, {
        method: "POST",
        body: JSON.stringify({ nickname }),
      });
      await finishJoin(joinResult);
      setInviteInput(createdRoom.inviteToken);
      setStatusText("Room ready");
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "failed to create room");
      setStatusText("Create room failed");
    }
  }

  async function handleJoinRoom(): Promise<void> {
    setErrorText("");
    setStatusText("Joining room");

    try {
      const token = extractInviteToken(inviteInput);
      const joinResult = await request<JoinResult>(`/api/invites/${token}/join`, {
        method: "POST",
        body: JSON.stringify({ nickname }),
      });
      await finishJoin(joinResult);
      setStatusText("Joined room");
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "failed to join room");
      setStatusText("Join room failed");
    }
  }

  async function handleSendMessage(): Promise<void> {
    const trimmedMessage = messageInput.trim();

    if (!self || isSendingMessage || isPreparingAttachments) {
      return;
    }

    if (!trimmedMessage && pendingAttachments.length === 0) {
      return;
    }

    setErrorText("");
    setIsSendingMessage(true);

    try {
      await request<PublicMessage>(`/api/rooms/${self.roomId}/messages`, {
        method: "POST",
        body: JSON.stringify({
          senderMemberId: self.memberId,
          wsToken: self.wsToken,
          content: trimmedMessage,
          attachmentIds: pendingAttachments.map((attachment) => attachment.id),
        }),
      });
      setMessageInput("");
      setPendingAttachments([]);
      setComposerCaret(0);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "failed to send message");
    } finally {
      setIsSendingMessage(false);
    }
  }

  async function handleComposerFileChange(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) {
      return;
    }

    const selectedFiles = Array.from(files);
    const remainingSlots = MAX_ATTACHMENT_COUNT - pendingAttachments.length;

    if (remainingSlots <= 0) {
      setErrorText(`up to ${MAX_ATTACHMENT_COUNT} attachments are allowed per message`);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      return;
    }

    const acceptedFiles = selectedFiles.slice(0, remainingSlots);
    const oversizedFile = acceptedFiles.find((file) => file.size > MAX_ATTACHMENT_SIZE_BYTES);

    if (oversizedFile) {
      setErrorText(
        `${oversizedFile.name} exceeds ${formatFileSize(MAX_ATTACHMENT_SIZE_BYTES)} per file`,
      );
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      return;
    }

    setErrorText("");
    setIsPreparingAttachments(true);

    try {
      const formData = new FormData();
      formData.set("senderMemberId", self?.memberId ?? "");
      formData.set("wsToken", self?.wsToken ?? "");

      for (const file of acceptedFiles) {
        formData.append("files", file);
      }

      const response = await fetch(`/api/rooms/${self?.roomId ?? ""}/attachments`, {
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
            : "failed to upload attachments",
        );
      }

      const nextAttachments = payload as MessageAttachment[];

      setPendingAttachments((current) => [...current, ...nextAttachments]);

      if (selectedFiles.length > remainingSlots) {
        setFlashText(`Only the first ${remainingSlots} attachments were added`);
      }
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "failed to read attachments");
    } finally {
      setIsPreparingAttachments(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  async function removePendingAttachment(attachmentId: string): Promise<void> {
    if (!self) {
      return;
    }

    setErrorText("");

    try {
      await request<{ ok: true }>(`/api/rooms/${self.roomId}/attachments/${attachmentId}`, {
        method: "DELETE",
        body: JSON.stringify({
          senderMemberId: self.memberId,
          wsToken: self.wsToken,
        }),
      });
      setPendingAttachments((current) =>
        current.filter((attachment) => attachment.id !== attachmentId),
      );
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "failed to remove attachment");
    }
  }

  function applyMentionSuggestion(suggestion: MentionSuggestion): void {
    const textarea = composerRef.current;
    const currentValue = messageInput;
    const caretIndex = textarea?.selectionStart ?? currentValue.length;
    const mentionQuery = getMentionQuery(currentValue, caretIndex);

    if (!mentionQuery) {
      return;
    }

    const before = currentValue.slice(0, mentionQuery.start);
    const after = currentValue.slice(mentionQuery.end);
    const nextValue = `${before}@${suggestion.displayName} ${after}`;
    const nextCaretIndex = `${before}@${suggestion.displayName} `.length;

    setMessageInput(nextValue);
    setSelectedMentionIndex(0);
    setComposerCaret(nextCaretIndex);
    setDismissedMentionSignature("");

    window.requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(nextCaretIndex, nextCaretIndex);
    });
  }

  async function handleCreateAgent(): Promise<void> {
    if (!self || !agentName.trim()) {
      return;
    }

    setErrorText("");

    try {
      await request<PublicMember>(`/api/rooms/${self.roomId}/members/agents`, {
        method: "POST",
        body: JSON.stringify({
          displayName: agentName.trim(),
          roleKind: agentRoleKind,
          actorMemberId: self.memberId,
          wsToken: self.wsToken,
          ownerMemberId: agentRoleKind === "assistant" ? assistantOwnerId || self.memberId : null,
          adapterType: "local_process",
          adapterConfig: {
            command: agentCommand.trim(),
            args: agentArgsText
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean),
            inputFormat: agentInputFormat,
          },
        }),
      });
      const nextMembers = await request<PublicMember[]>(`/api/rooms/${self.roomId}/members`);
      setMembers(nextMembers);
      setStatusText("Agent added");
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "failed to add agent");
    }
  }

  async function handleCreateAssistantInvite(): Promise<void> {
    if (!self) {
      return;
    }

    setErrorText("");

    try {
      const invite = await request<AssistantInviteResult>(
        `/api/rooms/${self.roomId}/assistant-invites`,
        {
          method: "POST",
          body: JSON.stringify({
            actorMemberId: self.memberId,
            wsToken: self.wsToken,
            backendType: "codex_cli",
            presetDisplayName: assistantInviteName.trim() || undefined,
          }),
        },
      );

      const fullInviteUrl = new URL(invite.inviteUrl, window.location.origin).toString();
      setAssistantInviteUrl(fullInviteUrl);
      setFlashText("Assistant invite ready");
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "failed to create assistant invite");
    }
  }

  async function handleCopyAssistantInvite(): Promise<void> {
    if (!assistantInviteUrl) {
      return;
    }

    setErrorText("");
    setIsCopyingAssistantInvite(true);

    try {
      await navigator.clipboard.writeText(assistantInviteUrl);
      setFlashText("Assistant invite copied");
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "failed to copy invite");
    } finally {
      setIsCopyingAssistantInvite(false);
    }
  }

  async function handleApproval(approvalId: string, action: "approve" | "reject"): Promise<void> {
    if (!self) {
      return;
    }

    setErrorText("");
    setApprovalActionId(approvalId);

    try {
      await request<PublicApproval>(`/api/approvals/${approvalId}/${action}`, {
        method: "POST",
        body: JSON.stringify({
          actorMemberId: self.memberId,
          wsToken: self.wsToken,
          grantDuration:
            action === "approve" ? (approvalGrantById[approvalId] ?? "once") : undefined,
        }),
      });
      setFlashText(action === "approve" ? "Approval granted" : "Approval rejected");
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : `failed to ${action} approval`);
    } finally {
      setApprovalActionId("");
    }
  }

  const visibleMessages = sortByCreatedAt([
    ...messages,
    ...Object.values(streams).map((stream) => ({
      id: stream.messageId,
      roomId: self?.roomId ?? "",
      senderMemberId: stream.agentMemberId,
      messageType: "agent_text" as const,
      content: `${stream.content}▌`,
      attachments: [],
      replyToMessageId: null,
      createdAt: new Date().toISOString(),
    })),
  ]);

  const roomInviteUrl = room ? new URL(`/join/${room.inviteToken}`, window.location.origin).toString() : "";
  const mentionQuery = getMentionQuery(messageInput, composerCaret);
  const mentionMenuVisible =
    !!mentionQuery && mentionSignature(mentionQuery) !== dismissedMentionSignature;
  const mentionSuggestions =
    mentionMenuVisible && mentionQuery && self
      ? members
          .filter((member) => member.id !== self.memberId)
          .filter((member) =>
            member.displayName.toLowerCase().startsWith(mentionQuery.query.toLowerCase()),
          )
          .map((member) => ({
            memberId: member.id,
            displayName: member.displayName,
            roleLabel: roleLabel(member),
          }))
      : [];

  function findMember(memberId: string): PublicMember | undefined {
    return members.find((member) => member.id === memberId);
  }

  function formatTime(value: string): string {
    return new Date(value).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function handleMessageStreamScroll(event: UIEvent<HTMLDivElement>): void {
    const container = event.currentTarget;
    const distanceToBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    autoScrollRef.current = distanceToBottom < 48;
  }

  function syncComposerCaret(): void {
    const textarea = composerRef.current;
    if (!textarea) {
      return;
    }

    setComposerCaret(textarea.selectionStart ?? textarea.value.length);
  }

  async function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): Promise<void> {
    const nativeEvent = event.nativeEvent as { isComposing?: boolean; keyCode?: number };
    if (nativeEvent.isComposing || nativeEvent.keyCode === 229) {
      return;
    }

    if (mentionSuggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedMentionIndex((current) => (current + 1) % mentionSuggestions.length);
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedMentionIndex((current) =>
          (current - 1 + mentionSuggestions.length) % mentionSuggestions.length,
        );
        return;
      }

      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        applyMentionSuggestion(
          mentionSuggestions[
            Math.max(0, Math.min(selectedMentionIndex, mentionSuggestions.length - 1))
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
      await handleSendMessage();
    }
  }

  return (
    <main className="lan-shell">
      <aside className="app-rail">
        <div className="brand-mark">AT</div>
        <div className="rail-stack">
          <button className="rail-item rail-item-active" type="button">
            <span>Rooms</span>
          </button>
          <button className="rail-item" type="button">
            <span>Agents</span>
          </button>
          <button className="rail-item" type="button">
            <span>Links</span>
          </button>
        </div>
        <div className="rail-user">{self?.displayName?.slice(0, 1) ?? "?"}</div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="topbar-title">
            <h1>{room?.name ?? "Agent Tavern"}</h1>
            <div className="live-badge">
              <span className="live-dot" />
              <span>{statusText}</span>
            </div>
            {flashText ? <div className="flash-badge">{flashText}</div> : null}
          </div>
          <div className="topbar-meta">
            {roomInviteUrl ? (
              <button
                className="ghost-button"
                disabled={isCopyingRoomInvite}
                onClick={async () => {
                  setErrorText("");
                  setIsCopyingRoomInvite(true);

                  try {
                    await navigator.clipboard.writeText(roomInviteUrl);
                    setFlashText("Room invite copied");
                  } catch (error) {
                    setErrorText(error instanceof Error ? error.message : "failed to copy room invite");
                  } finally {
                    setIsCopyingRoomInvite(false);
                  }
                }}
              >
                {isCopyingRoomInvite ? "Copying..." : "Copy room invite"}
              </button>
            ) : null}
            {errorText ? <p className="error-inline">{errorText}</p> : null}
          </div>
        </header>

        <div className="workspace-grid">
          <aside className="left-tools">
            <section className="tool-card">
              <div className="card-heading">
                <h2>Session</h2>
                <span>{self ? "joined" : "idle"}</span>
              </div>
              <label>
                <span>Room name</span>
                <input value={roomName} onChange={(event) => setRoomName(event.target.value)} />
              </label>
              <label>
                <span>Nickname</span>
                <input value={nickname} onChange={(event) => setNickname(event.target.value)} />
              </label>
              <div className="inline-actions">
                <button onClick={handleCreateRoom}>Create</button>
                <button className="ghost-button" onClick={handleJoinRoom}>
                  Join
                </button>
              </div>
              <label>
                <span>Invite token or URL</span>
                <input
                  value={inviteInput}
                  onChange={(event) => setInviteInput(event.target.value)}
                />
              </label>
              {self ? (
                <div className="session-facts">
                  <p>Room member: {self.displayName}</p>
                  <p>Invite token: {room?.inviteToken ?? "pending"}</p>
                </div>
              ) : null}
            </section>

            <section className="tool-card">
              <div className="card-heading">
                <h2>Invite Codex Thread</h2>
                <span>one-time</span>
              </div>
              <label>
                <span>Preset display name</span>
                <input
                  value={assistantInviteName}
                  onChange={(event) => setAssistantInviteName(event.target.value)}
                  placeholder="CodexThreadA"
                />
              </label>
              <button onClick={handleCreateAssistantInvite} disabled={!self}>
                Create assistant invite
              </button>
              {assistantInviteUrl ? (
                <div className="invite-result">
                  <p className="muted-text">One-time invite URL</p>
                  <textarea readOnly rows={4} value={assistantInviteUrl} />
                  <button
                    className="ghost-button"
                    disabled={isCopyingAssistantInvite}
                    onClick={handleCopyAssistantInvite}
                  >
                    {isCopyingAssistantInvite ? "Copying..." : "Copy invite URL"}
                  </button>
                </div>
              ) : null}
            </section>

            <section className="tool-card">
              <div className="card-heading">
                <h2>Add Local Agent</h2>
                <span>demo</span>
              </div>
              <label>
                <span>Display name</span>
                <input value={agentName} onChange={(event) => setAgentName(event.target.value)} />
              </label>
              <label>
                <span>Role</span>
                <select
                  value={agentRoleKind}
                  onChange={(event) =>
                    setAgentRoleKind(event.target.value as "independent" | "assistant")
                  }
                >
                  <option value="independent">Independent</option>
                  <option value="assistant">Assistant</option>
                </select>
              </label>
              {agentRoleKind === "assistant" ? (
                <label>
                  <span>Owner</span>
                  <select
                    value={assistantOwnerId}
                    onChange={(event) => setAssistantOwnerId(event.target.value)}
                  >
                    {members.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.displayName}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label>
                <span>Command</span>
                <input
                  value={agentCommand}
                  onChange={(event) => setAgentCommand(event.target.value)}
                />
              </label>
              <details className="advanced-config">
                <summary>Advanced config</summary>
                <label>
                  <span>Args</span>
                  <textarea
                    rows={5}
                    value={agentArgsText}
                    onChange={(event) => setAgentArgsText(event.target.value)}
                  />
                </label>
                <label>
                  <span>Input format</span>
                  <select
                    value={agentInputFormat}
                    onChange={(event) =>
                      setAgentInputFormat(event.target.value as "text" | "json")
                    }
                  >
                    <option value="text">text</option>
                    <option value="json">json</option>
                  </select>
                </label>
              </details>
              <button onClick={handleCreateAgent} disabled={!self}>
                Add local agent
              </button>
            </section>
          </aside>

          <section className="chat-stage">
            <div className="day-marker">Today</div>
            <div
              ref={messageStreamRef}
              className="message-stream"
              onScroll={handleMessageStreamScroll}
            >
              {visibleMessages.map((message) => {
                const sender = findMember(message.senderMemberId);
                const isAgent = sender?.type === "agent" || message.messageType === "agent_text";
                const isSelf = message.senderMemberId === self?.memberId;
                const isStreaming = message.id in streams;
                const isSystemNotice = message.messageType === "system_notice";
                const isApprovalMessage =
                  message.messageType === "approval_request" ||
                  message.messageType === "approval_result";
                const isWorkflowMessage = isSystemNotice || isApprovalMessage;
                const bubbleClassName = [
                  "chat-bubble",
                  isAgent && !isWorkflowMessage ? "chat-bubble-agent" : "",
                  isSystemNotice ? "chat-bubble-notice" : "",
                  isApprovalMessage ? "chat-bubble-approval" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                const authorLabel =
                  isApprovalMessage && sender
                    ? `${sender.displayName} workflow`
                    : isSystemNotice && sender
                      ? `${sender.displayName} status`
                    : sender?.displayName ?? message.senderMemberId;
                const metaPillLabel = isApprovalMessage
                  ? "workflow"
                  : isSystemNotice
                    ? "status"
                    : sender
                      ? roleLabel(sender)
                      : null;
                const metaPillClassName = isApprovalMessage
                  ? "agent-pill-workflow"
                  : isSystemNotice
                    ? "agent-pill-system"
                    : "";

                return (
                  <article
                    key={message.id}
                    className={`chat-row ${isAgent && !isWorkflowMessage ? "chat-row-agent" : ""} ${
                      isSelf ? "chat-row-self" : ""
                    } ${
                      isApprovalMessage ? "chat-row-approval" : ""
                    } ${
                      isSystemNotice ? "chat-row-notice" : ""
                    }`}
                  >
                    <header className="chat-meta">
                      <div className="chat-author">
                        <strong>{authorLabel}</strong>
                        {metaPillLabel ? (
                          <span className={`agent-pill ${metaPillClassName}`.trim()}>
                            {metaPillLabel}
                          </span>
                        ) : null}
                        {isStreaming ? <span className="stream-pill">streaming</span> : null}
                      </div>
                      <span>{formatTime(message.createdAt)}</span>
                    </header>
                    <div className={bubbleClassName}>
                      {message.content ? <p>{message.content}</p> : null}
                      {message.attachments.length > 0 ? (
                        <div className="message-attachments">
                          {message.attachments.map((attachment) => (
                            <a
                              key={attachment.id}
                              className="message-attachment"
                              href={attachment.url}
                              download={attachment.name}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {isImageAttachment(attachment) ? (
                                <img
                                  src={attachment.url}
                                  alt={attachment.name}
                                  className="message-attachment-preview"
                                />
                              ) : (
                                <span className="message-attachment-icon">FILE</span>
                              )}
                              <span className="message-attachment-copy">
                                <strong>{attachment.name}</strong>
                                <span>{formatFileSize(attachment.sizeBytes)}</span>
                              </span>
                            </a>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>

            <div className="composer-dock">
              {mentionSuggestions.length > 0 ? (
                <div className="mention-menu">
                  {mentionSuggestions.map((suggestion, index) => (
                    <button
                      key={suggestion.memberId}
                      className={`mention-option ${index === selectedMentionIndex ? "mention-option-active" : ""}`}
                      type="button"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        applyMentionSuggestion(suggestion);
                      }}
                      onClick={() => applyMentionSuggestion(suggestion)}
                    >
                      <strong>{suggestion.displayName}</strong>
                      <span>{suggestion.roleLabel}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              {pendingAttachments.length > 0 ? (
                <div className="pending-attachments">
                  {pendingAttachments.map((attachment) => (
                    <div key={attachment.id} className="pending-attachment-chip">
                      <div className="pending-attachment-copy">
                        <strong>{attachment.name}</strong>
                        <span>{formatFileSize(attachment.sizeBytes)}</span>
                      </div>
                      <button
                        type="button"
                        className="pending-attachment-remove"
                        onClick={() => {
                          void removePendingAttachment(attachment.id);
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="composer-actions">
                <input
                  ref={fileInputRef}
                  className="composer-file-input"
                  type="file"
                  multiple
                  onChange={(event) => {
                    void handleComposerFileChange(event.target.files);
                  }}
                />
                <button
                  type="button"
                  className="ghost-button"
                  disabled={!self || isPreparingAttachments}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {isPreparingAttachments ? "Reading files..." : "Add attachments"}
                </button>
                <span className="composer-hint">
                  Up to {MAX_ATTACHMENT_COUNT} files, {formatFileSize(MAX_ATTACHMENT_SIZE_BYTES)} each
                </span>
              </div>
              <textarea
                ref={composerRef}
                rows={3}
                value={messageInput}
                onChange={(event) => {
                  setMessageInput(event.target.value);
                  setComposerCaret(event.target.selectionStart ?? event.target.value.length);
                }}
                onKeyDown={(event) => void handleComposerKeyDown(event)}
                onBlur={() => {
                  if (mentionQuery) {
                    setDismissedMentionSignature(mentionSignature(mentionQuery));
                  }
                }}
                onClick={syncComposerCaret}
                onKeyUp={syncComposerCaret}
                onSelect={syncComposerCaret}
                placeholder="Type a message, for example: @BackendDev 帮我看一下"
              />
              <button
                onClick={handleSendMessage}
                disabled={
                  !self ||
                  isSendingMessage ||
                  isPreparingAttachments ||
                  (!messageInput.trim() && pendingAttachments.length === 0)
                }
              >
                {isSendingMessage ? "Sending..." : "Send"}
              </button>
            </div>
          </section>

          <aside className="right-sidebar">
            <section className="side-card">
              <div className="card-heading">
                <h2>Active in Room</h2>
                <span>{members.length}</span>
              </div>
              <div className="presence-list">
                {members.map((member) => {
                  const owner = member.ownerMemberId ? findMember(member.ownerMemberId) : null;

                  return (
                    <article key={member.id} className="presence-item">
                      <div className={`presence-avatar ${member.type === "agent" ? "presence-avatar-agent" : ""}`}>
                        {member.displayName.slice(0, 1)}
                      </div>
                      <div className="presence-copy">
                        <div className="presence-title">
                          <strong>{member.displayName}</strong>
                          <span className="agent-pill">{roleLabel(member)}</span>
                          {runtimeLabel(member) ? (
                            <span
                              className={`presence-runtime-pill presence-runtime-pill-${member.runtimeStatus}`}
                            >
                              {runtimeLabel(member)}
                            </span>
                          ) : null}
                        </div>
                        <p>
                          {owner ? `Owner ${owner.displayName}` : "Independent member"}
                        </p>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>

            <section className="side-card">
              <div className="card-heading">
                <h2>Pending approvals</h2>
                <span>{pendingApprovals.length}</span>
              </div>
              <div className="approval-list">
                {pendingApprovals.length === 0 ? <p className="muted-text">No pending approvals.</p> : null}
                {pendingApprovals.map((approval) => {
                  const agent = findMember(approval.agentMemberId);
                  const requester = findMember(approval.requesterMemberId);
                  const owner = findMember(approval.ownerMemberId);

                  return (
                    <article key={approval.id} className="approval-card">
                      <div>
                        <strong>{agent?.displayName ?? approval.agentMemberId}</strong>
                        <p>Role: {agent ? roleLabel(agent) : "agent"}</p>
                        <p>Requester: {requester?.displayName ?? approval.requesterMemberId}</p>
                        <p>Owner: {owner?.displayName ?? approval.ownerMemberId}</p>
                      </div>
                      <div className="approval-actions">
                        <select
                          value={approvalGrantById[approval.id] ?? "once"}
                          onChange={(event) =>
                            setApprovalGrantById((current) => ({
                              ...current,
                              [approval.id]: event.target.value as ApprovalGrantDuration,
                            }))
                          }
                          disabled={approval.ownerMemberId !== self?.memberId || approvalActionId === approval.id}
                        >
                          {approvalGrantOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() => handleApproval(approval.id, "approve")}
                          disabled={approval.ownerMemberId !== self?.memberId || approvalActionId === approval.id}
                        >
                          {approvalActionId === approval.id ? "Working..." : "Approve"}
                        </button>
                        <button
                          className="ghost-button"
                          onClick={() => handleApproval(approval.id, "reject")}
                          disabled={approval.ownerMemberId !== self?.memberId || approvalActionId === approval.id}
                        >
                          Reject
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          </aside>
        </div>
      </section>
    </main>
  );
}

export default App;
