import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type UIEvent,
} from "react";

import type {
  ApprovalGrantDuration,
  AgentSession,
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

type SessionSnapshot = AgentSession & {
  lastError?: string | null;
  outputMessageId?: string | null;
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

const demoAgentArgs = [
  "--input-type=module",
  "-e",
  "let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',async()=>{const lines=input.trim().split('\\n').filter(Boolean);const tail=lines.at(-1) ?? 'ready';const reply=`酒馆演示 Agent：${tail}`;for (const chunk of [reply.slice(0, 16), reply.slice(16)]) { if (!chunk) continue; process.stdout.write(chunk); await new Promise(r=>setTimeout(r,120)); }});",
].join("\n");

const approvalGrantOptions: Array<{ value: ApprovalGrantDuration; label: string }> = [
  { value: "once", label: "仅本次" },
  { value: "10_minutes", label: "10 分钟" },
  { value: "30_minutes", label: "30 分钟" },
  { value: "1_hour", label: "1 小时" },
  { value: "forever", label: "始终允许" },
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
        : `请求失败：${response.status}`;
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
    return "人类";
  }

  return member.roleKind === "assistant" ? "助理" : "独立 Agent";
}

function roleTone(member: Pick<PublicMember, "type" | "roleKind">): string {
  if (member.type !== "agent") {
    return "human";
  }

  return member.roleKind === "assistant" ? "assistant" : "independent";
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

function summarizeMessage(message: PublicMessage): string {
  if (message.systemData?.detail) {
    return message.systemData.detail.length > 72
      ? `${message.systemData.detail.slice(0, 69)}...`
      : message.systemData.detail;
  }

  const trimmed = message.content.trim();
  if (trimmed) {
    return trimmed.length > 72 ? `${trimmed.slice(0, 69)}...` : trimmed;
  }

  if (message.attachments.length > 0) {
    return `${message.attachments.length} 个附件`;
  }

  return "空消息";
}

function approvalGrantLabel(value: ApprovalGrantDuration | null | undefined): string | null {
  const option = approvalGrantOptions.find((item) => item.value === value);
  return option?.label ?? null;
}

function approvalKindLabel(kind: PublicMessage["systemData"] extends infer T
  ? T extends { kind: infer K }
    ? K
    : never
  : never): string {
  switch (kind) {
    case "approval_required":
      return "待审批";
    case "approval_granted":
      return "已批准";
    case "approval_rejected":
      return "已拒绝";
    case "approval_expired":
      return "已过期";
    case "approval_owner_offline":
      return "Owner 离线";
    default:
      return "审批";
  }
}

function approvalCardStatus(status: PublicMessage["systemData"] extends infer T
  ? T extends { status: infer S }
    ? S
    : never
  : never): "warning" | "success" | "error" {
  switch (status) {
    case "success":
      return "success";
    case "error":
      return "error";
    default:
      return "warning";
  }
}

function sessionStatusLabel(status: AgentSession["status"]): string {
  switch (status) {
    case "pending":
      return "排队中";
    case "waiting_approval":
      return "等待审批";
    case "running":
      return "运行中";
    case "completed":
      return "已完成";
    case "rejected":
      return "已拒绝";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    default:
      return status;
  }
}

function sessionTone(status: AgentSession["status"]): "warning" | "success" | "error" {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
    case "rejected":
    case "cancelled":
      return "error";
    default:
      return "warning";
  }
}

type ApprovalCardItem = {
  label: string;
  value: string;
};

type ApprovalSummaryCardProps = {
  variant: "message" | "sidebar";
  status: "warning" | "success" | "error";
  badge: string;
  grantLabel?: string | null;
  title: string;
  detail: string;
  items: ApprovalCardItem[];
  children?: ReactNode;
};

function ApprovalSummaryCard({
  variant,
  status,
  badge,
  grantLabel,
  title,
  detail,
  items,
  children,
}: ApprovalSummaryCardProps) {
  return (
    <div className={`approval-surface approval-surface-${variant} approval-surface-${status}`}>
      <div className="approval-surface-head">
        <span className="approval-surface-badge">{badge}</span>
        {grantLabel ? <span className="approval-surface-grant">{grantLabel}</span> : null}
      </div>
      <div className="approval-surface-copy">
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
      <div className="approval-surface-grid">
        {items.map((item) => (
          <div key={`${item.label}:${item.value}`}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </div>
        ))}
      </div>
      {children}
    </div>
  );
}

type ApprovalDecisionControlsProps = {
  approvalId: string;
  mine: boolean;
  selectedGrant: ApprovalGrantDuration;
  busyApprovalId: string;
  onGrantChange: (value: ApprovalGrantDuration) => void;
  onApprove: () => void;
  onReject: () => void;
};

function ApprovalDecisionControls({
  approvalId,
  mine,
  selectedGrant,
  busyApprovalId,
  onGrantChange,
  onApprove,
  onReject,
}: ApprovalDecisionControlsProps) {
  return (
    <div className="approval-actions">
      <select
        value={selectedGrant}
        onChange={(event) => onGrantChange(event.target.value as ApprovalGrantDuration)}
        disabled={!mine || busyApprovalId === approvalId}
      >
        {approvalGrantOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <button onClick={onApprove} disabled={!mine || busyApprovalId === approvalId}>
        {busyApprovalId === approvalId ? "处理中..." : "批准"}
      </button>
      <button className="ghost-button" onClick={onReject} disabled={!mine || busyApprovalId === approvalId}>
        拒绝
      </button>
    </div>
  );
}

function runtimeLabel(member: PublicMember): string | null {
  switch (member.runtimeStatus) {
    case "ready":
      return "已连接";
    case "pending_bridge":
      return "待绑定";
    case "waiting_bridge":
      return "等待 Bridge";
    default:
      return null;
  }
}

function mentionSignature(mention: { start: number; query: string } | null): string {
  return mention ? `${mention.start}:${mention.query}` : "";
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

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildOwnerTree(members: PublicMember[]): Array<{
  owner: PublicMember;
  assistants: PublicMember[];
}> {
  const assistantsByOwner = new Map<string, PublicMember[]>();

  for (const member of members) {
    if (member.roleKind !== "assistant" || !member.ownerMemberId) {
      continue;
    }

    const next = assistantsByOwner.get(member.ownerMemberId) ?? [];
    next.push(member);
    assistantsByOwner.set(member.ownerMemberId, next);
  }

  return members
    .filter((member) => assistantsByOwner.has(member.id))
    .map((owner) => ({
      owner,
      assistants: sortByCreatedAt(assistantsByOwner.get(owner.id) ?? []),
    }));
}

function App() {
  const [roomName, setRoomName] = useState("策略室");
  const [nickname, setNickname] = useState("阿南");
  const [inviteInput, setInviteInput] = useState("");
  const [messageInput, setMessageInput] = useState("");
  const [replyTargetId, setReplyTargetId] = useState<string | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<MessageAttachment[]>([]);
  const [agentName, setAgentName] = useState("财务助手");
  const [agentRoleKind, setAgentRoleKind] = useState<"independent" | "assistant">(
    "independent",
  );
  const [agentCommand, setAgentCommand] = useState("node");
  const [agentArgsText, setAgentArgsText] = useState(demoAgentArgs);
  const [agentInputFormat, setAgentInputFormat] = useState<"text" | "json">("text");
  const [assistantOwnerId, setAssistantOwnerId] = useState("");
  const [assistantInviteName, setAssistantInviteName] = useState("架构助理");
  const [assistantInviteUrl, setAssistantInviteUrl] = useState("");
  const [room, setRoom] = useState<Room | null>(null);
  const [self, setSelf] = useState<JoinResult | null>(null);
  const [members, setMembers] = useState<PublicMember[]>([]);
  const [messages, setMessages] = useState<PublicMessage[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<PublicApproval[]>([]);
  const [streams, setStreams] = useState<Record<string, SessionStream>>({});
  const [sessionSnapshots, setSessionSnapshots] = useState<Record<string, SessionSnapshot>>({});
  const [sessionActors, setSessionActors] = useState<Record<string, SessionActor>>({});
  const [statusText, setStatusText] = useState("未连接");
  const [flashText, setFlashText] = useState("");
  const [errorText, setErrorText] = useState("");
  const [focusedMessageId, setFocusedMessageId] = useState<string | null>(null);
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
  const sessionActorsRef = useRef<Record<string, SessionActor>>({});
  const messageStreamRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const autoScrollRef = useRef(true);

  useEffect(() => {
    sessionActorsRef.current = sessionActors;
  }, [sessionActors]);

  useEffect(() => {
    if (!flashText) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setFlashText("");
    }, 2400);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [flashText]);

  useEffect(() => {
    if (!focusedMessageId) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setFocusedMessageId((current) => (current === focusedMessageId ? null : current));
    }, 1800);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [focusedMessageId]);

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
          // Ignore transient failures.
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
    setSessionSnapshots({});
    setSessionActors({});
  }

  function connectSocket(joinResult: JoinResult): void {
    socketRef.current?.close();

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(
      `${protocol}//${window.location.host}/ws?roomId=${joinResult.roomId}&memberId=${joinResult.memberId}&wsToken=${joinResult.wsToken}`,
    );

    socket.addEventListener("open", () => {
      setStatusText("实时已连接");
    });

    socket.addEventListener("close", () => {
      setStatusText("实时已断开");
    });

    socket.addEventListener("message", (event) => {
      const rawPayload = JSON.parse(String(event.data)) as unknown;

      if (!isRealtimeEvent(rawPayload)) {
        return;
      }

      const payload = rawPayload;

      if (payload.type === "member.joined" || payload.type === "member.updated") {
        setMembers((current) => {
          const next = current.filter((member) => member.id !== payload.payload.member.id);
          next.push(payload.payload.member);
          return next;
        });
        return;
      }

      if (payload.type === "member.left") {
        setMembers((current) => current.filter((member) => member.id !== payload.payload.memberId));
        return;
      }

      if (payload.type === "message.created" || payload.type === "message.updated") {
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
        setSessionSnapshots((current) => ({
          ...current,
          [payload.payload.session.id]: {
            ...payload.payload.session,
            lastError: null,
            outputMessageId: current[payload.payload.session.id]?.outputMessageId ?? null,
          },
        }));
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
        setSessionSnapshots((current) => ({
          ...current,
          [payload.payload.sessionId]: current[payload.payload.sessionId]
            ? {
                ...current[payload.payload.sessionId],
                outputMessageId: payload.payload.message.id,
              }
            : ({
                id: payload.payload.sessionId,
                roomId: payload.payload.message.roomId,
                agentMemberId: payload.payload.message.senderMemberId,
                triggerMessageId: payload.payload.message.replyToMessageId ?? payload.payload.message.id,
                requesterMemberId: "",
                approvalId: null,
                approvalRequired: false,
                status: "completed",
                startedAt: payload.payload.message.createdAt,
                endedAt: payload.payload.message.createdAt,
                lastError: null,
                outputMessageId: payload.payload.message.id,
              } satisfies SessionSnapshot),
        }));
        setStreams((current) => {
          const next = { ...current };
          delete next[payload.payload.message.id];
          return next;
        });
        return;
      }

      if (payload.type === "agent.session.completed") {
        setSessionSnapshots((current) => ({
          ...current,
          [payload.payload.session.id]: {
            ...payload.payload.session,
            lastError: null,
            outputMessageId: current[payload.payload.session.id]?.outputMessageId ?? null,
          },
        }));
        return;
      }

      if (payload.type === "agent.session.failed") {
        setSessionSnapshots((current) => ({
          ...current,
          [payload.payload.session.id]: {
            ...payload.payload.session,
            lastError: payload.payload.error,
            outputMessageId: current[payload.payload.session.id]?.outputMessageId ?? null,
          },
        }));
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
    setStatusText("正在创建房间");

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
      setStatusText("房间已就绪");
      setFlashText("已创建并进入房间");
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "创建房间失败");
      setStatusText("创建失败");
    }
  }

  async function handleJoinRoom(): Promise<void> {
    setErrorText("");
    setStatusText("正在进入房间");

    try {
      const token = extractInviteToken(inviteInput);
      const joinResult = await request<JoinResult>(`/api/invites/${token}/join`, {
        method: "POST",
        body: JSON.stringify({ nickname }),
      });
      await finishJoin(joinResult);
      setStatusText("已进入房间");
      setFlashText("已通过邀请进入");
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "进入房间失败");
      setStatusText("进入失败");
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
          replyToMessageId: replyTargetId,
        }),
      });
      setMessageInput("");
      setReplyTargetId(null);
      setPendingAttachments([]);
      setComposerCaret(0);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "发送消息失败");
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
      setErrorText(`每条消息最多上传 ${MAX_ATTACHMENT_COUNT} 个附件`);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      return;
    }

    const acceptedFiles = selectedFiles.slice(0, remainingSlots);
    const oversizedFile = acceptedFiles.find((file) => file.size > MAX_ATTACHMENT_SIZE_BYTES);

    if (oversizedFile) {
      setErrorText(`${oversizedFile.name} 超过单文件 ${formatFileSize(MAX_ATTACHMENT_SIZE_BYTES)}`);
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
            : "上传附件失败",
        );
      }

      const nextAttachments = payload as MessageAttachment[];
      setPendingAttachments((current) => [...current, ...nextAttachments]);

      if (selectedFiles.length > remainingSlots) {
        setFlashText(`只添加了前 ${remainingSlots} 个附件`);
      }
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "读取附件失败");
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
      setErrorText(error instanceof Error ? error.message : "移除附件失败");
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
      setFlashText("已添加本地 Agent");
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "添加本地 Agent 失败");
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
      setFlashText("助理邀请已生成");
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "创建助理邀请失败");
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
      setFlashText("助理邀请已复制");
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "复制邀请失败");
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
      setFlashText(action === "approve" ? "已批准执行" : "已拒绝请求");
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "处理审批失败");
    } finally {
      setApprovalActionId("");
    }
  }

  function findMember(memberId: string): PublicMember | undefined {
    return members.find((member) => member.id === memberId);
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
      systemData: null,
      replyToMessageId: null,
      createdAt: new Date().toISOString(),
    })),
  ]);

  function findMessage(messageId: string | null): PublicMessage | undefined {
    if (!messageId) {
      return undefined;
    }

    return visibleMessages.find((message) => message.id === messageId);
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

  function focusMessage(messageId: string | null, successText = "已定位到相关消息"): void {
    if (!messageId) {
      setErrorText("关联消息已不可用");
      return;
    }

    const container = messageStreamRef.current;
    const target = container?.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);

    if (!target) {
      setErrorText("关联消息已不可用");
      return;
    }

    autoScrollRef.current = false;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    setFocusedMessageId(messageId);
    setFlashText(successText);
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
        const mentionQuery = getMentionQuery(messageInput, composerCaret);
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

  const roomInviteUrl = room
    ? new URL(`/join/${room.inviteToken}`, window.location.origin).toString()
    : "";
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

  const selectedReplyTarget = findMessage(replyTargetId);
  const selectedReplyTargetSender = selectedReplyTarget
    ? findMember(selectedReplyTarget.senderMemberId)
    : undefined;

  const humans = useMemo(
    () => sortByCreatedAt(members.filter((member) => member.type === "human")),
    [members],
  );
  const independentAgents = useMemo(
    () =>
      sortByCreatedAt(
        members.filter(
          (member) => member.type === "agent" && member.roleKind === "independent",
        ),
      ),
    [members],
  );
  const assistantTree = useMemo(() => buildOwnerTree(members), [members]);
  const myPendingApprovals = pendingApprovals.filter(
    (approval) => approval.ownerMemberId === self?.memberId,
  );
  const runningSessionSummaries = useMemo(
    () =>
      [...Object.values(sessionSnapshots)]
        .filter(
          (session) =>
            session.status === "pending" ||
            session.status === "waiting_approval" ||
            session.status === "running",
        )
        .sort((left, right) =>
          (left.startedAt ?? left.endedAt ?? "").localeCompare(right.startedAt ?? right.endedAt ?? ""),
        ),
    [sessionSnapshots],
  );
  const recentIssueMessages = useMemo(
    () =>
      sortByCreatedAt(
        visibleMessages.filter(
          (message) =>
            message.systemData?.kind === "agent_failed" ||
            message.systemData?.kind === "bridge_waiting" ||
            message.systemData?.kind === "approval_owner_offline",
        ),
      ).slice(-4),
    [visibleMessages],
  );
  function findPendingApproval(approvalId: string | null | undefined): PublicApproval | undefined {
    if (!approvalId) {
      return undefined;
    }

    return pendingApprovals.find((approval) => approval.id === approvalId);
  }

  function findApprovalMessage(approvalId: string, messageType?: "approval_request" | "approval_result") {
    return visibleMessages.find(
      (message) =>
        message.systemData?.approvalId === approvalId &&
        (!messageType || message.messageType === messageType),
    );
  }

  return (
    <main className="lan-shell">
      <aside className="room-sidebar">
        <div className="brand-card">
          <div className="brand-icon">AT</div>
          <div>
            <strong>AgentTavern</strong>
            <span>局域网协作聊天室</span>
          </div>
        </div>

        <section className="sidebar-card">
          <div className="section-heading">
            <h2>聊天室</h2>
            <span>{room ? "当前在线" : "未进入"}</span>
          </div>
          {room ? (
            <div className="room-current">
              <strong>{room.name}</strong>
              <p>邀请制加入，可在同一房间内实时协作。</p>
              <div className="room-current-meta">
                <span>{members.length} 位成员</span>
                <span>{room.inviteToken}</span>
              </div>
            </div>
          ) : (
            <p className="muted-text">先创建一个聊天室，或通过邀请链接进入已有房间。</p>
          )}
        </section>

        <section className="sidebar-card">
          <div className="section-heading">
            <h2>切换 / 进入</h2>
            <span>核心导航</span>
          </div>
          <label>
            <span>你的昵称</span>
            <input value={nickname} onChange={(event) => setNickname(event.target.value)} />
          </label>
          <label>
            <span>新房间名称</span>
            <input value={roomName} onChange={(event) => setRoomName(event.target.value)} />
          </label>
          <div className="inline-actions">
            <button onClick={handleCreateRoom}>新建并进入</button>
            <button className="ghost-button" onClick={handleJoinRoom}>
              通过邀请进入
            </button>
          </div>
          <label>
            <span>邀请链接或邀请码</span>
            <input
              value={inviteInput}
              onChange={(event) => setInviteInput(event.target.value)}
              placeholder="粘贴 /join/... 或邀请码"
            />
          </label>
        </section>

        <section className="sidebar-card">
          <div className="section-heading">
            <h2>本地接入</h2>
            <span>可选</span>
          </div>

          <details className="subpanel" open>
            <summary>邀请 Codex 助理</summary>
            <label>
              <span>预设显示名</span>
              <input
                value={assistantInviteName}
                onChange={(event) => setAssistantInviteName(event.target.value)}
              />
            </label>
            <button onClick={handleCreateAssistantInvite} disabled={!self}>
              生成一次性邀请
            </button>
            {assistantInviteUrl ? (
              <div className="invite-box">
                <textarea readOnly rows={4} value={assistantInviteUrl} />
                <button
                  className="ghost-button"
                  disabled={isCopyingAssistantInvite}
                  onClick={handleCopyAssistantInvite}
                >
                  {isCopyingAssistantInvite ? "复制中..." : "复制邀请链接"}
                </button>
              </div>
            ) : null}
          </details>

          <details className="subpanel">
            <summary>添加本地 Agent</summary>
            <label>
              <span>显示名</span>
              <input value={agentName} onChange={(event) => setAgentName(event.target.value)} />
            </label>
            <label>
              <span>类型</span>
              <select
                value={agentRoleKind}
                onChange={(event) =>
                  setAgentRoleKind(event.target.value as "independent" | "assistant")
                }
              >
                <option value="independent">独立 Agent</option>
                <option value="assistant">助理</option>
              </select>
            </label>
            {agentRoleKind === "assistant" ? (
              <label>
                <span>直属 owner</span>
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
              <span>命令</span>
              <input
                value={agentCommand}
                onChange={(event) => setAgentCommand(event.target.value)}
              />
            </label>
            <label>
              <span>参数（每行一个）</span>
              <textarea
                rows={5}
                value={agentArgsText}
                onChange={(event) => setAgentArgsText(event.target.value)}
              />
            </label>
            <label>
              <span>输入格式</span>
              <select
                value={agentInputFormat}
                onChange={(event) =>
                  setAgentInputFormat(event.target.value as "text" | "json")
                }
              >
                <option value="text">文本</option>
                <option value="json">JSON</option>
              </select>
            </label>
            <button onClick={handleCreateAgent} disabled={!self}>
              添加本地 Agent
            </button>
          </details>
        </section>

        <div className="sidebar-footer">
          <button type="button" className="sidebar-create-room-button" onClick={handleCreateRoom}>
            新建聊天室
          </button>
        </div>
      </aside>

      <section className="chat-shell">
        <header className="chat-header">
          <div className="chat-header-bar">
            <div className="chat-header-brand">
              <strong>AgentTavern</strong>
              <nav className="chat-header-nav" aria-label="房间导航">
                <button type="button" className="header-nav-item header-nav-item-active">
                  房间
                </button>
                <button type="button" className="header-nav-item">
                  邀请
                </button>
                <button type="button" className="header-nav-item">
                  成员
                </button>
                <button type="button" className="header-nav-item">
                  设置
                </button>
              </nav>
            </div>
            <div className="chat-header-actions">
              {roomInviteUrl ? (
                <button
                  className="header-invite-button"
                  disabled={isCopyingRoomInvite}
                  onClick={async () => {
                    setErrorText("");
                    setIsCopyingRoomInvite(true);

                    try {
                      await navigator.clipboard.writeText(roomInviteUrl);
                      setFlashText("房间邀请已复制");
                    } catch (error) {
                      setErrorText(error instanceof Error ? error.message : "复制房间邀请失败");
                    } finally {
                      setIsCopyingRoomInvite(false);
                    }
                  }}
                >
                  {isCopyingRoomInvite ? "复制中..." : "邀请成员"}
                </button>
              ) : null}
            </div>
          </div>

          <div className="chat-header-main">
            <div>
              <p className="eyebrow">当前聊天室</p>
              <h1>{room?.name ?? "AgentTavern"}</h1>
            </div>
            <div className="status-badge">
              <span className="status-dot" />
              <span>{statusText}</span>
            </div>
            {flashText ? <div className="flash-badge">{flashText}</div> : null}
            {errorText ? <p className="error-inline">{errorText}</p> : null}
          </div>
        </header>

        <div className="chat-layout">
          <section className="message-panel">
            <div className="message-divider">
              <div className="message-divider-line" />
              <div className="day-marker">今天</div>
              <div className="message-divider-line" />
            </div>

            <div
              ref={messageStreamRef}
              className="message-stream"
              onScroll={handleMessageStreamScroll}
            >
              {visibleMessages.map((message) => {
                const sender = findMember(message.senderMemberId);
                const replyTarget = findMessage(message.replyToMessageId);
                const replyTargetSender = replyTarget
                  ? findMember(replyTarget.senderMemberId)
                  : undefined;
                const isAgent = sender?.type === "agent" || message.messageType === "agent_text";
                const isSelf = message.senderMemberId === self?.memberId;
                const isStreaming = message.id in streams;
                const isSystemNotice = message.messageType === "system_notice";
                const isApprovalMessage =
                  message.messageType === "approval_request" ||
                  message.messageType === "approval_result";
                const systemData = message.systemData;
                const approvalAgent = systemData?.agentMemberId
                  ? findMember(systemData.agentMemberId)
                  : undefined;
                const approvalOwner = systemData?.ownerMemberId
                  ? findMember(systemData.ownerMemberId)
                  : undefined;
                const approvalRequester = systemData?.requesterMemberId
                  ? findMember(systemData.requesterMemberId)
                  : undefined;
                const approvalGrant = approvalGrantLabel(systemData?.grantDuration);
                const linkedPendingApproval = findPendingApproval(systemData?.approvalId);
                const canResolveLinkedApproval =
                  !!linkedPendingApproval && linkedPendingApproval.ownerMemberId === self?.memberId;
                const selectedLinkedGrant = linkedPendingApproval
                  ? approvalGrantById[linkedPendingApproval.id] ?? "once"
                  : "once";
                const approvalSummaryItems = systemData
                  ? [
                      {
                        label: "Requester",
                        value: approvalRequester?.displayName ?? systemData.requesterMemberId ?? "未知",
                      },
                      {
                        label: "Agent",
                        value: approvalAgent?.displayName ?? systemData.agentMemberId ?? "未知",
                      },
                      {
                        label: "Owner",
                        value: approvalOwner?.displayName ?? systemData.ownerMemberId ?? "未知",
                      },
                      {
                        label: "状态",
                        value: approvalKindLabel(systemData.kind),
                      },
                    ]
                  : [];
                const systemFacts = systemData
                  ? [
                      systemData.agentMemberId
                        ? `Agent：${approvalAgent?.displayName ?? systemData.agentMemberId}`
                        : null,
                      systemData.ownerMemberId
                        ? `Owner：${approvalOwner?.displayName ?? systemData.ownerMemberId}`
                        : null,
                      systemData.requesterMemberId
                        ? `Requester：${approvalRequester?.displayName ?? systemData.requesterMemberId}`
                        : null,
                      approvalGrant ? `授权：${approvalGrant}` : null,
                    ].filter((value): value is string => Boolean(value))
                  : [];
                const tone = isApprovalMessage
                  ? "approval"
                  : isSystemNotice
                    ? "notice"
                    : isAgent
                      ? "agent"
                      : "human";
                const authorLabel = sender?.displayName ?? message.senderMemberId;

                return (
                  <article
                    key={message.id}
                    data-message-id={message.id}
                    className={`chat-row chat-row-${tone} ${isSelf ? "chat-row-self" : ""} ${
                      focusedMessageId === message.id ? "chat-row-focused" : ""
                    }`}
                  >
                    <header className="chat-meta">
                      <div className="chat-author">
                        <strong>{authorLabel}</strong>
                        {sender ? (
                          <span className={`role-pill role-pill-${roleTone(sender)}`}>
                            {roleLabel(sender)}
                          </span>
                        ) : null}
                        {isSystemNotice ? <span className="role-pill role-pill-notice">系统提示</span> : null}
                        {isApprovalMessage ? <span className="role-pill role-pill-approval">审批事件</span> : null}
                        {isStreaming ? <span className="stream-pill">流式输出中</span> : null}
                      </div>
                      <span>{formatTime(message.createdAt)}</span>
                    </header>

                    <div className={`chat-bubble chat-bubble-${tone}`}>
                      {systemData && isApprovalMessage ? (
                        <ApprovalSummaryCard
                          variant="message"
                          status={approvalCardStatus(systemData.status)}
                          badge={approvalKindLabel(systemData.kind)}
                          grantLabel={approvalGrant}
                          title={systemData.title}
                          detail={systemData.detail}
                          items={approvalSummaryItems}
                        >
                          <div className="approval-surface-links">
                            {message.replyToMessageId ? (
                              <button
                                type="button"
                                className="chat-action-button"
                                onClick={() =>
                                  focusMessage(message.replyToMessageId, "已定位到触发消息")
                                }
                              >
                                查看原消息
                              </button>
                            ) : null}
                            {linkedPendingApproval ? (
                              <ApprovalDecisionControls
                                approvalId={linkedPendingApproval.id}
                                mine={canResolveLinkedApproval}
                                selectedGrant={selectedLinkedGrant}
                                busyApprovalId={approvalActionId}
                                onGrantChange={(value) =>
                                  setApprovalGrantById((current) => ({
                                    ...current,
                                    [linkedPendingApproval.id]: value,
                                  }))
                                }
                                onApprove={() =>
                                  void handleApproval(linkedPendingApproval.id, "approve")
                                }
                                onReject={() =>
                                  void handleApproval(linkedPendingApproval.id, "reject")
                                }
                              />
                            ) : null}
                          </div>
                        </ApprovalSummaryCard>
                      ) : systemData ? (
                        <div className="system-message-copy">
                          <strong>{systemData.title}</strong>
                          <p>{systemData.detail}</p>
                          {systemFacts.length > 0 ? (
                            <div className="system-message-facts">
                              {systemFacts.map((fact) => (
                                <span key={fact}>{fact}</span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                      {message.replyToMessageId ? (
                        <button
                          type="button"
                          className="reply-preview"
                          onClick={() => {
                            if (!replyTarget) {
                              return;
                            }

                            setReplyTargetId(replyTarget.id);
                            setFlashText("已载入回复目标");
                            composerRef.current?.focus();
                          }}
                        >
                          <strong>回复给 {replyTargetSender?.displayName ?? "某条消息"}</strong>
                          <span>{summarizeMessage(replyTarget ?? message)}</span>
                        </button>
                      ) : null}

                      {!systemData && message.content ? <p>{message.content}</p> : null}

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
                                <span className="message-attachment-icon">文件</span>
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

                    {!isApprovalMessage && !isSystemNotice ? (
                      <div className="chat-actions">
                        <button
                          type="button"
                          className="chat-action-button"
                          onClick={() => {
                            setReplyTargetId(message.id);
                            composerRef.current?.focus();
                          }}
                        >
                          回复
                        </button>
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>

            <div className="composer-dock">
              {replyTargetId ? (
                <div className="reply-banner">
                  <div className="reply-banner-copy">
                    <strong>正在回复 {selectedReplyTargetSender?.displayName ?? "某条消息"}</strong>
                    <span>
                      {selectedReplyTarget
                        ? summarizeMessage(selectedReplyTarget)
                        : "原始消息已不可用"}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="reply-banner-clear"
                    onClick={() => setReplyTargetId(null)}
                  >
                    取消
                  </button>
                </div>
              ) : null}

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
                        移除
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="composer-toolbar">
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
                  className="composer-icon-button"
                  disabled={!self || isPreparingAttachments}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {isPreparingAttachments ? "…" : "＋"}
                </button>
                <span className="composer-hint">
                  最多 {MAX_ATTACHMENT_COUNT} 个附件，单个 {formatFileSize(MAX_ATTACHMENT_SIZE_BYTES)}
                </span>
              </div>

              <div className="composer-main">
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
                  placeholder="输入消息，使用 @成员名 触发协作..."
                />
                <div className="composer-side-actions">
                  <button type="button" className="composer-mini-button">
                    @
                  </button>
                  <button
                    type="button"
                    className="composer-mini-button"
                    disabled={!self || isPreparingAttachments}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    附
                  </button>
                </div>
                <button
                  className="composer-send-button"
                  onClick={handleSendMessage}
                  disabled={
                    !self ||
                    isSendingMessage ||
                    isPreparingAttachments ||
                    (!messageInput.trim() && pendingAttachments.length === 0)
                  }
                >
                  {isSendingMessage ? "…" : "➜"}
                </button>
              </div>
              <p className="composer-footnote">回车发送，Shift + Enter 换行</p>
            </div>
          </section>

          <aside className="member-sidebar">
            <section className="side-card">
              <div className="section-heading">
                <h2>协作状态</h2>
                <span>
                  {pendingApprovals.length + runningSessionSummaries.length + recentIssueMessages.length} 条动态
                </span>
              </div>

              <div className="collab-state-list">
                {pendingApprovals.length === 0 &&
                runningSessionSummaries.length === 0 &&
                recentIssueMessages.length === 0 ? (
                  <p className="muted-text">当前没有需要关注的协作状态。</p>
                ) : null}

                {pendingApprovals.map((approval) => {
                  const agent = findMember(approval.agentMemberId);
                  const requester = findMember(approval.requesterMemberId);

                  return (
                    <article key={`approval:${approval.id}`} className="collab-state-card">
                      <div className="collab-state-head">
                        <span className="collab-state-pill collab-state-pill-warning">待审批</span>
                        <span>{formatTime(approval.createdAt)}</span>
                      </div>
                      <strong>
                        {agent?.displayName ?? approval.agentMemberId} 正在等待 owner 放行
                      </strong>
                      <p>
                        请求人：{requester?.displayName ?? approval.requesterMemberId}
                      </p>
                      <div className="collab-state-actions">
                        <button
                          type="button"
                          className="chat-action-button"
                          onClick={() => focusMessage(approval.triggerMessageId, "已定位到触发消息")}
                        >
                          查看原消息
                        </button>
                        {findApprovalMessage(approval.id, "approval_request") ? (
                          <button
                            type="button"
                            className="chat-action-button"
                            onClick={() =>
                              focusMessage(
                                findApprovalMessage(approval.id, "approval_request")?.id ?? null,
                                "已定位到审批消息",
                              )
                            }
                          >
                            查看审批消息
                          </button>
                        ) : null}
                      </div>
                    </article>
                  );
                })}

                {runningSessionSummaries.map((session) => {
                  const agent = findMember(session.agentMemberId);
                  const requester = session.requesterMemberId
                    ? findMember(session.requesterMemberId)
                    : undefined;
                  const stream = Object.values(streams).find((item) => item.sessionId === session.id);

                  return (
                    <article key={`session:${session.id}`} className="collab-state-card">
                      <div className="collab-state-head">
                        <span className={`collab-state-pill collab-state-pill-${sessionTone(session.status)}`}>
                          {sessionStatusLabel(session.status)}
                        </span>
                        <span>{formatTime(session.startedAt ?? new Date().toISOString())}</span>
                      </div>
                      <strong>{agent?.displayName ?? session.agentMemberId} 正在处理请求</strong>
                      <p>
                        请求人：{requester?.displayName ?? session.requesterMemberId ?? "未知"}
                      </p>
                      <p>{stream?.content ? `${stream.content.slice(-72)}` : "等待输出或结果消息..."}</p>
                      <div className="collab-state-actions">
                        <button
                          type="button"
                          className="chat-action-button"
                          onClick={() => focusMessage(session.triggerMessageId, "已定位到触发消息")}
                        >
                          查看触发消息
                        </button>
                      </div>
                    </article>
                  );
                })}

                {recentIssueMessages.map((message) => (
                  <article key={`issue:${message.id}`} className="collab-state-card">
                    <div className="collab-state-head">
                      <span className="collab-state-pill collab-state-pill-error">
                        {message.systemData?.kind === "bridge_waiting" ? "等待 Bridge" : "最近异常"}
                      </span>
                      <span>{formatTime(message.createdAt)}</span>
                    </div>
                    <strong>{message.systemData?.title ?? "系统事件"}</strong>
                    <p>{message.systemData?.detail ?? message.content}</p>
                    <div className="collab-state-actions">
                      <button
                        type="button"
                        className="chat-action-button"
                        onClick={() => focusMessage(message.id, "已定位到相关系统消息")}
                      >
                        查看消息
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>

            <section className="side-card">
              <div className="section-heading">
                <h2>房间成员</h2>
                <span>{members.length} 位在线/可见成员</span>
              </div>

              <div className="member-section">
                <h3>人类成员</h3>
                <div className="member-list">
                  {humans.map((member) => (
                    <article key={member.id} className="member-row">
                      <div className="member-avatar">{member.displayName.slice(0, 1)}</div>
                      <div className="member-copy">
                        <div className="member-title">
                          <strong>
                            {member.displayName}
                            {member.id === self?.memberId ? "（你）" : ""}
                          </strong>
                          <span className="role-pill role-pill-human">人类</span>
                        </div>
                        <p>在当前聊天室中协作</p>
                      </div>
                    </article>
                  ))}
                </div>
              </div>

              <div className="member-section">
                <h3>独立 Agent</h3>
                <div className="member-list">
                  {independentAgents.length === 0 ? (
                    <p className="muted-text">暂无独立 Agent。</p>
                  ) : (
                    independentAgents.map((member) => (
                      <article key={member.id} className="member-row">
                        <div className="member-avatar member-avatar-agent">
                          {member.displayName.slice(0, 1)}
                        </div>
                        <div className="member-copy">
                          <div className="member-title">
                            <strong>{member.displayName}</strong>
                            <span className="role-pill role-pill-independent">独立 Agent</span>
                            {runtimeLabel(member) ? (
                              <span className={`runtime-pill runtime-pill-${member.runtimeStatus}`}>
                                {runtimeLabel(member)}
                              </span>
                            ) : null}
                          </div>
                          <p>可被直接 @ 并执行</p>
                        </div>
                      </article>
                    ))
                  )}
                </div>
              </div>

              <div className="member-section">
                <h3>助理树</h3>
                <div className="assistant-tree">
                  {assistantTree.length === 0 ? (
                    <p className="muted-text">暂无助理成员。</p>
                  ) : (
                    assistantTree.map(({ owner, assistants }) => (
                      <div key={owner.id} className="assistant-branch">
                        <div className="assistant-owner-label">
                          <span>归属于 {owner.displayName}</span>
                          <div className="assistant-owner-line" />
                        </div>

                        <div className="assistant-children">
                          {assistants.map((assistant) => (
                            <article key={assistant.id} className="member-row member-row-child">
                              <div className="member-avatar member-avatar-agent">
                                {assistant.displayName.slice(0, 1)}
                              </div>
                              <div className="member-copy">
                                <div className="member-title">
                                  <strong>{assistant.displayName}</strong>
                                  <span className="role-pill role-pill-assistant">助理</span>
                                  {runtimeLabel(assistant) ? (
                                    <span
                                      className={`runtime-pill runtime-pill-${assistant.runtimeStatus}`}
                                    >
                                      {runtimeLabel(assistant)}
                                    </span>
                                  ) : null}
                                </div>
                                <p>直属于 {owner.displayName}</p>
                              </div>
                            </article>
                          ))}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </section>

            <section className="side-card">
              <div className="section-heading">
                <h2>待处理审批</h2>
                <span>{pendingApprovals.length} 条</span>
              </div>
              <div className="approval-list">
                {pendingApprovals.length === 0 ? (
                  <p className="muted-text">当前没有待处理审批。</p>
                ) : (
                  pendingApprovals.map((approval) => {
                    const agent = findMember(approval.agentMemberId);
                    const requester = findMember(approval.requesterMemberId);
                    const owner = findMember(approval.ownerMemberId);
                    const mine = approval.ownerMemberId === self?.memberId;
                    const approvalMessage = findApprovalMessage(approval.id, "approval_request");
                    const selectedGrant = approvalGrantById[approval.id] ?? "once";
                    const sidebarItems = [
                      {
                        label: "Requester",
                        value: requester?.displayName ?? approval.requesterMemberId,
                      },
                      {
                        label: "Agent",
                        value: agent?.displayName ?? approval.agentMemberId,
                      },
                      {
                        label: "Owner",
                        value: owner?.displayName ?? approval.ownerMemberId,
                      },
                      {
                        label: "状态",
                        value: mine ? "等待你处理" : "等待直属 owner",
                      },
                    ];
                    const sidebarDetail = mine
                      ? "正在等待你决定是否放行。"
                      : "等待直属 owner 处理后继续执行。";

                    return (
                      <article key={approval.id} className="approval-card">
                        <ApprovalSummaryCard
                          variant="sidebar"
                          status="warning"
                          badge="待审批"
                          grantLabel={approvalGrantLabel(selectedGrant)}
                          title={`${requester?.displayName ?? approval.requesterMemberId} 正在请求调用`}
                          detail={sidebarDetail}
                          items={sidebarItems}
                        >
                          <div className="approval-surface-links">
                            <button
                              type="button"
                              className="chat-action-button"
                              onClick={() => focusMessage(approval.triggerMessageId, "已定位到触发消息")}
                            >
                              查看原消息
                            </button>
                            {approvalMessage ? (
                              <button
                                type="button"
                                className="chat-action-button"
                                onClick={() => focusMessage(approvalMessage.id, "已定位到审批消息")}
                              >
                                查看审批消息
                              </button>
                            ) : null}
                          </div>
                          <ApprovalDecisionControls
                            approvalId={approval.id}
                            mine={mine}
                            selectedGrant={selectedGrant}
                            busyApprovalId={approvalActionId}
                            onGrantChange={(value) =>
                              setApprovalGrantById((current) => ({
                                ...current,
                                [approval.id]: value,
                              }))
                            }
                            onApprove={() => void handleApproval(approval.id, "approve")}
                            onReject={() => void handleApproval(approval.id, "reject")}
                          />
                        </ApprovalSummaryCard>
                      </article>
                    );
                  })
                )}
              </div>
              {myPendingApprovals.length > 0 ? (
                <p className="approval-summary">你当前有 {myPendingApprovals.length} 条审批待处理。</p>
              ) : null}
            </section>

            <section className="protocol-card">
              <div className="protocol-title">
                <span className="protocol-dot" />
                <strong>房间协作协议已启用</strong>
              </div>
              <p>
                当前聊天室中的互动会在本地实时同步；若助理依赖本地 Bridge，则其可用性会随连接状态变化。
              </p>
            </section>
          </aside>
        </div>
      </section>
    </main>
  );
}

export default App;
