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

type PrincipalSession = {
  principalId: string;
  principalToken: string;
  kind: "human" | "agent";
  loginKey: string;
  globalDisplayName: string;
  backendType: "codex_cli" | "local_process" | null;
  backendThreadId: string | null;
  status: "online" | "offline";
};

type LobbyPrincipal = PrincipalSession & {
  id: string;
  createdAt: string;
  runtimeStatus: "ready" | "pending_bridge" | "waiting_bridge" | null;
};

type DirectRoomResult = {
  room: Room;
  reused: boolean;
  join: JoinResult;
};

type PrivateAssistantRecord = {
  id: string;
  ownerPrincipalId: string;
  name: string;
  backendType: "codex_cli" | "local_process";
  backendThreadId: string | null;
  status: "pending_bridge" | "active" | "detached" | "failed";
  createdAt: string;
};

type PrivateAssistantInviteRecord = {
  id: string;
  ownerPrincipalId: string;
  name: string;
  backendType: "codex_cli" | "local_process";
  inviteToken: string;
  inviteUrl: string;
  status: "pending" | "accepted" | "expired" | "revoked";
  acceptedPrivateAssistantId: string | null;
  createdAt: string;
  expiresAt: string | null;
  acceptedAt: string | null;
  reused?: boolean;
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

type RecentRoomRecord = {
  roomId: string;
  name: string;
  inviteToken: string;
  visitedAt: string;
};

type MentionSuggestion = {
  memberId: string;
  displayName: string;
  roleLabel: string;
};

const MAX_ATTACHMENT_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENT_COUNT = 8;
const MAX_RECENT_ROOMS = 6;
const PRINCIPAL_STORAGE_KEY = "agent-tavern-principal";
const PRINCIPAL_REFRESH_EVENT = "agent-tavern-principal-refreshed";

let principalRefreshPromise: Promise<PrincipalSession | null> | null = null;

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

    if (
      typeof window !== "undefined" &&
      response.status === 403 &&
      message === "invalid principal token" &&
      path !== "/api/principals/bootstrap"
    ) {
      const refreshedPrincipal = await refreshPrincipalSessionFromStorage();

      if (refreshedPrincipal) {
        const retried = rewritePrincipalAuth(path, init, refreshedPrincipal);
        return request<T>(retried.path, retried.init);
      }
    }

    throw new Error(message);
  }

  return payload as T;
}

function rewritePrincipalAuth(
  path: string,
  init: RequestInit | undefined,
  principal: PrincipalSession,
): { path: string; init: RequestInit | undefined } {
  const absoluteUrl = new URL(path, window.location.origin);

  if (absoluteUrl.searchParams.has("principalId")) {
    absoluteUrl.searchParams.set("principalId", principal.principalId);
  }
  if (absoluteUrl.searchParams.has("principalToken")) {
    absoluteUrl.searchParams.set("principalToken", principal.principalToken);
  }

  if (!init?.body || typeof init.body !== "string") {
    return {
      path: absoluteUrl.pathname + absoluteUrl.search,
      init,
    };
  }

  try {
    const body = JSON.parse(init.body) as Record<string, unknown>;

    if ("principalId" in body) {
      body.principalId = principal.principalId;
    }
    if ("principalToken" in body) {
      body.principalToken = principal.principalToken;
    }
    if ("actorPrincipalId" in body) {
      body.actorPrincipalId = principal.principalId;
    }
    if ("actorPrincipalToken" in body) {
      body.actorPrincipalToken = principal.principalToken;
    }

    return {
      path: absoluteUrl.pathname + absoluteUrl.search,
      init: {
        ...init,
        body: JSON.stringify(body),
      },
    };
  } catch {
    return {
      path: absoluteUrl.pathname + absoluteUrl.search,
      init,
    };
  }
}

async function refreshPrincipalSessionFromStorage(): Promise<PrincipalSession | null> {
  if (principalRefreshPromise) {
    return principalRefreshPromise;
  }

  principalRefreshPromise = (async () => {
    const cached = window.localStorage.getItem(PRINCIPAL_STORAGE_KEY);

    if (!cached) {
      return null;
    }

    try {
      const principal = JSON.parse(cached) as PrincipalSession;
      const response = await fetch("/api/principals/bootstrap", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          kind: principal.kind,
          loginKey: principal.loginKey,
          globalDisplayName: principal.globalDisplayName,
          backendType: principal.backendType,
          backendThreadId: principal.backendThreadId,
        }),
      });

      if (!response.ok) {
        return null;
      }

      const nextPrincipal = (await response.json()) as PrincipalSession;
      window.localStorage.setItem(PRINCIPAL_STORAGE_KEY, JSON.stringify(nextPrincipal));
      window.dispatchEvent(new CustomEvent<PrincipalSession>(PRINCIPAL_REFRESH_EVENT, { detail: nextPrincipal }));
      return nextPrincipal;
    } catch {
      return null;
    } finally {
      principalRefreshPromise = null;
    }
  })();

  return principalRefreshPromise;
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

function sortRecentRooms(items: RecentRoomRecord[]): RecentRoomRecord[] {
  return [...items].sort((left, right) => right.visitedAt.localeCompare(left.visitedAt));
}

function mergeRecentRoom(
  items: RecentRoomRecord[],
  nextRoom: Pick<RecentRoomRecord, "roomId" | "name" | "inviteToken">,
): RecentRoomRecord[] {
  const existing = items.find((item) => item.roomId === nextRoom.roomId);
  const nextItems = items.filter((item) => item.roomId !== nextRoom.roomId);
  nextItems.unshift({
    ...nextRoom,
    visitedAt: existing?.visitedAt ?? new Date().toISOString(),
  });
  return sortRecentRooms(nextItems).slice(0, MAX_RECENT_ROOMS);
}

function recentRoomsStorageKey(principal: Pick<PrincipalSession, "kind" | "loginKey">): string {
  return `agent-tavern-recent-rooms:${principal.kind}:${principal.loginKey}`;
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
      <button className="btn-ghost inline-action-button" onClick={onReject} disabled={!mine || busyApprovalId === approvalId}>
        拒绝
      </button>
    </div>
  );
}

function runtimeText(runtimeStatus: PublicMember["runtimeStatus"]): string | null {
  switch (runtimeStatus) {
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

function runtimeLabel(member: PublicMember): string | null {
  return runtimeText(member.runtimeStatus);
}

function privateAssistantStatusLabel(
  status: PrivateAssistantRecord["status"],
): string | null {
  switch (status) {
    case "pending_bridge":
      return "已接入，待加入房间";
    case "active":
      return "已加入房间";
    case "detached":
      return "等待 Bridge";
    case "failed":
      return "接入异常";
    default:
      return null;
  }
}

function privateAssistantInviteStatusLabel(
  status: PrivateAssistantInviteRecord["status"],
): string {
  switch (status) {
    case "pending":
      return "等待 Codex 接入";
    case "accepted":
      return "已完成接入";
    case "expired":
      return "接入链接已过期";
    case "revoked":
      return "接入已撤销";
    default:
      return status;
  }
}

function presenceNote(status: PublicMember["presenceStatus"] | null | undefined): string | null {
  return status === "offline" ? "已下线" : null;
}

function resolveAgentTavernInviteOrigin(): string {
  const { protocol, hostname, port, origin } = window.location;

  if (port === "5173" || port === "5174") {
    return `${protocol}//${hostname}:8787`;
  }

  return origin;
}

function buildPrivateAssistantInvitePrompt(invite: Pick<PrivateAssistantInviteRecord, "name" | "inviteUrl">): string {
  const invitePath = invite.inviteUrl?.trim();
  const fullInviteUrl = invitePath
    ? new URL(invitePath, resolveAgentTavernInviteOrigin()).toString()
    : "接入链接暂不可用，请重新生成";
  return `请接受这个 AgentTavern 私有助理邀请链接，并把当前 Codex 线程接入为我的私有助理“${invite.name}”：${fullInviteUrl}`;
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

function describeRecentRoom(room: {
  name: string;
  visitedAt: string;
  isCurrent?: boolean;
}): string {
  if (room.isCurrent) {
    return "多人聊天室 · 当前";
  }

  const parts = room.name.split("·").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 2) {
    return `双人聊天 · ${formatTime(room.visitedAt)}`;
  }

  return `多人聊天室 · ${formatTime(room.visitedAt)}`;
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
  const [principalKind, setPrincipalKind] = useState<"human" | "agent">("human");
  const [loginKey, setLoginKey] = useState("aruis@example.com");
  const [globalDisplayName, setGlobalDisplayName] = useState("阿南");
  const [principalBackendThreadId, setPrincipalBackendThreadId] = useState("");
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
  const [principal, setPrincipal] = useState<PrincipalSession | null>(null);
  const [lobbyPrincipals, setLobbyPrincipals] = useState<LobbyPrincipal[]>([]);
  const [privateAssistants, setPrivateAssistants] = useState<PrivateAssistantRecord[]>([]);
  const [privateAssistantInvites, setPrivateAssistantInvites] = useState<PrivateAssistantInviteRecord[]>([]);
  const [recentRooms, setRecentRooms] = useState<RecentRoomRecord[]>([]);
  const [privateAssistantName, setPrivateAssistantName] = useState("账本助理");
  const [showAccountPanel, setShowAccountPanel] = useState(false);
  const [showAssistantPanel, setShowAssistantPanel] = useState(false);
  const [showRoomModal, setShowRoomModal] = useState(false);
  const [showOnlinePanel, setShowOnlinePanel] = useState(false);
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
  const principalSocketRef = useRef<WebSocket | null>(null);
  const sessionActorsRef = useRef<Record<string, SessionActor>>({});
  const messageStreamRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const autoScrollRef = useRef(true);
  const recentRoomsKeyRef = useRef<string | null>(null);

  async function refreshPrivateAssets(activePrincipal: PrincipalSession | null = principal): Promise<void> {
    if (!activePrincipal) {
      setPrivateAssistants([]);
      setPrivateAssistantInvites([]);
      return;
    }

    const [items, invites] = await Promise.all([
      request<PrivateAssistantRecord[]>(
        `/api/me/assistants?principalId=${activePrincipal.principalId}&principalToken=${activePrincipal.principalToken}`,
      ),
      request<PrivateAssistantInviteRecord[]>(
        `/api/me/assistants/invites?principalId=${activePrincipal.principalId}&principalToken=${activePrincipal.principalToken}`,
      ),
    ]);

    setPrivateAssistants(sortByCreatedAt(items));
    setPrivateAssistantInvites(sortByCreatedAt(invites));
  }

  useEffect(() => {
    const cached = window.localStorage.getItem(PRINCIPAL_STORAGE_KEY);

    if (!cached) {
      return;
    }

    try {
      const parsed = JSON.parse(cached) as PrincipalSession;
      setPrincipal(parsed);
      setPrincipalKind(parsed.kind);
      setLoginKey(parsed.loginKey);
      setGlobalDisplayName(parsed.globalDisplayName);
      setPrincipalBackendThreadId(parsed.backendThreadId ?? "");
    } catch {
      window.localStorage.removeItem(PRINCIPAL_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    if (!principal) {
      window.localStorage.removeItem(PRINCIPAL_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(PRINCIPAL_STORAGE_KEY, JSON.stringify(principal));
  }, [principal]);

  useEffect(() => {
    function handlePrincipalRefresh(event: Event): void {
      const nextPrincipal = (event as CustomEvent<PrincipalSession>).detail;
      setPrincipal(nextPrincipal);
      setPrincipalKind(nextPrincipal.kind);
      setLoginKey(nextPrincipal.loginKey);
      setGlobalDisplayName(nextPrincipal.globalDisplayName);
      setPrincipalBackendThreadId(nextPrincipal.backendThreadId ?? "");
    }

    window.addEventListener(PRINCIPAL_REFRESH_EVENT, handlePrincipalRefresh);
    return () => window.removeEventListener(PRINCIPAL_REFRESH_EVENT, handlePrincipalRefresh);
  }, []);

  useEffect(() => {
    if (!principal) {
      setRecentRooms([]);
      recentRoomsKeyRef.current = null;
      return;
    }

    const storageKey = recentRoomsStorageKey(principal);
    recentRoomsKeyRef.current = storageKey;
    const cached = window.localStorage.getItem(storageKey);

    if (!cached) {
      setRecentRooms([]);
      return;
    }

    try {
      const parsed = JSON.parse(cached) as RecentRoomRecord[];
      setRecentRooms(sortRecentRooms(parsed));
    } catch {
      window.localStorage.removeItem(storageKey);
      setRecentRooms([]);
    }
  }, [principal]);

  useEffect(() => {
    if (!principal) {
      return;
    }

    void refreshPrincipalSessionFromStorage();
  }, [principal?.loginKey, principal?.globalDisplayName, principal?.kind]);

  useEffect(() => {
    if (!principal) {
      return;
    }

    const storageKey = recentRoomsStorageKey(principal);

    if (recentRoomsKeyRef.current !== storageKey) {
      return;
    }

    window.localStorage.setItem(storageKey, JSON.stringify(recentRooms));
  }, [principal, recentRooms]);

  useEffect(() => {
    if (!room) {
      return;
    }

    setRecentRooms((current) =>
      mergeRecentRoom(current, {
        roomId: room.id,
        name: room.name,
        inviteToken: room.inviteToken,
      }),
    );
  }, [room]);

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
    function handleEscape(event: globalThis.KeyboardEvent): void {
      if (event.key !== "Escape") {
        return;
      }

      setShowAccountPanel(false);
      setShowAssistantPanel(false);
      setShowRoomModal(false);
      setShowOnlinePanel(false);
    }

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, []);

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
      principalSocketRef.current?.close();
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

  useEffect(() => {
    if (!principal) {
      setLobbyPrincipals([]);
      setPrivateAssistants([]);
      setPrivateAssistantInvites([]);
      return;
    }

    let cancelled = false;

    const loadLobby = async () => {
      try {
        const payload = await request<{ principals: LobbyPrincipal[] }>("/api/presence/lobby");
        if (!cancelled) {
          setLobbyPrincipals(sortByCreatedAt(payload.principals));
        }
      } catch {
        if (!cancelled) {
          setLobbyPrincipals([]);
        }
      }
    };

    void loadLobby();
    const intervalId = window.setInterval(() => {
      void loadLobby();
    }, 10_000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [principal]);

  useEffect(() => {
    if (!principal) {
      return;
    }

    let cancelled = false;

    void refreshPrivateAssets(principal).catch(() => {
      if (!cancelled) {
        setPrivateAssistants([]);
        setPrivateAssistantInvites([]);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [principal]);

  useEffect(() => {
    if (!principal) {
      principalSocketRef.current?.close();
      principalSocketRef.current = null;
      return;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(
      `${protocol}//${window.location.host}/ws?principalId=${principal.principalId}&principalToken=${principal.principalToken}`,
    );

    socket.addEventListener("message", (event) => {
      const rawPayload = JSON.parse(String(event.data)) as unknown;

      if (!isRealtimeEvent(rawPayload)) {
        return;
      }

      if (rawPayload.type === "private_assistants.changed") {
        void refreshPrivateAssets(principal).catch(() => {
          setPrivateAssistants([]);
          setPrivateAssistantInvites([]);
        });
      }
    });

    principalSocketRef.current?.close();
    principalSocketRef.current = socket;

    return () => {
      socket.close();
      if (principalSocketRef.current === socket) {
        principalSocketRef.current = null;
      }
    };
  }, [principal]);

  useEffect(() => {
    if (!principal || !showAssistantPanel) {
      return;
    }

    void refreshPrivateAssets(principal).catch(() => {
      setPrivateAssistants([]);
      setPrivateAssistantInvites([]);
    });
  }, [principal, showAssistantPanel]);

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

  async function ensurePrincipal(): Promise<PrincipalSession> {
    const trimmedLoginKey = loginKey.trim();
    const trimmedGlobalDisplayName = globalDisplayName.trim();
    const trimmedBackendThreadId = principalBackendThreadId.trim();

    if (!trimmedLoginKey || !trimmedGlobalDisplayName) {
      throw new Error(principalKind === "agent" ? "请先填写智能体标识和显示名" : "请先填写邮箱和全局昵称");
    }

    if (principalKind === "agent" && !trimmedBackendThreadId) {
      throw new Error("请先填写 Codex thread id");
    }

    if (
      principal &&
      principal.kind === principalKind &&
      principal.loginKey === trimmedLoginKey &&
      principal.globalDisplayName === trimmedGlobalDisplayName &&
      (principal.kind !== "agent" || principal.backendThreadId === trimmedBackendThreadId)
    ) {
      return principal;
    }

    const nextPrincipal = await request<PrincipalSession>("/api/principals/bootstrap", {
      method: "POST",
      body: JSON.stringify({
        kind: principalKind,
        loginKey: trimmedLoginKey,
        globalDisplayName: trimmedGlobalDisplayName,
        backendType: principalKind === "agent" ? "codex_cli" : null,
        backendThreadId: principalKind === "agent" ? trimmedBackendThreadId : null,
      }),
    });

    setPrincipal(nextPrincipal);
    return nextPrincipal;
  }

  async function handleBootstrapPrincipal(): Promise<void> {
    setErrorText("");
    setStatusText("正在登记身份");

    try {
      const activePrincipal = await ensurePrincipal();
      setPrincipal(activePrincipal);
      setStatusText("身份已登记");
      setFlashText(
        activePrincipal.kind === "agent"
          ? `已登记为智能体一等公民：${activePrincipal.globalDisplayName}`
          : `已登记为人类一等公民：${activePrincipal.globalDisplayName}`,
      );
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "身份登记失败");
      setStatusText("登记失败");
    }
  }

  function handleLogoutPrincipal(): void {
    socketRef.current?.close();
    setPrincipal(null);
    setPrincipalKind("human");
    setRoom(null);
    setSelf(null);
    setMembers([]);
    setMessages([]);
    setPendingApprovals([]);
    setStreams({});
    setSessionSnapshots({});
    setSessionActors({});
    setPrincipalBackendThreadId("");
    setStatusText("未连接");
    setFlashText("已退出当前身份");
    setShowAccountPanel(false);
  }

  async function handleCreateRoom(): Promise<boolean> {
    setErrorText("");
    setStatusText("正在创建房间");

    try {
      const activePrincipal = await ensurePrincipal();
      const createdRoom = await request<{
        id: string;
        name: string;
        inviteToken: string;
      }>("/api/rooms", {
        method: "POST",
        body: JSON.stringify({ name: roomName }),
      });
      const joinResult = await request<JoinResult>(`/api/invites/${createdRoom.inviteToken}/join`, {
        method: "POST",
        body: JSON.stringify({
          principalId: activePrincipal.principalId,
          principalToken: activePrincipal.principalToken,
        }),
      });
      await finishJoin(joinResult);
      setInviteInput(createdRoom.inviteToken);
      setStatusText("房间已就绪");
      setFlashText("已创建并进入房间");
      return true;
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "创建房间失败");
      setStatusText("创建失败");
      return false;
    }
  }

  async function handleJoinRoom(): Promise<boolean> {
    setErrorText("");
    setStatusText("正在进入房间");

    try {
      const activePrincipal = await ensurePrincipal();
      const token = extractInviteToken(inviteInput);
      const joinResult = await request<JoinResult>(`/api/invites/${token}/join`, {
        method: "POST",
        body: JSON.stringify({
          principalId: activePrincipal.principalId,
          principalToken: activePrincipal.principalToken,
        }),
      });
      await finishJoin(joinResult);
      setStatusText("已进入房间");
      setFlashText("已通过邀请进入");
      return true;
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "进入房间失败");
      setStatusText("进入失败");
      return false;
    }
  }

  async function handleStartDirectRoom(targetPrincipalId: string): Promise<void> {
    setErrorText("");
    setStatusText("正在开始聊天");

    try {
      const activePrincipal = await ensurePrincipal();
      const result = await request<DirectRoomResult>("/api/direct-rooms", {
        method: "POST",
        body: JSON.stringify({
          actorPrincipalId: activePrincipal.principalId,
          actorPrincipalToken: activePrincipal.principalToken,
          peerPrincipalId: targetPrincipalId,
        }),
      });
      await finishJoin(result.join);
      setStatusText(result.reused ? "已回到原聊天" : "已开始聊天");
      setFlashText(result.reused ? "已打开已有双人聊天室" : "已创建双人聊天室");
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "开始聊天失败");
      setStatusText("开始聊天失败");
    }
  }

  async function handleOpenRecentRoom(targetRoomId: string): Promise<void> {
    setErrorText("");
    setStatusText("正在进入最近聊天室");

    try {
      const activePrincipal = await ensurePrincipal();
      const joinResult = await request<JoinResult>(`/api/rooms/${targetRoomId}/join`, {
        method: "POST",
        body: JSON.stringify({
          principalId: activePrincipal.principalId,
          principalToken: activePrincipal.principalToken,
        }),
      });
      await finishJoin(joinResult);
      setStatusText("已进入聊天室");
      setFlashText("已打开最近聊天室");
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "进入最近聊天室失败");
      setStatusText("进入失败");
    }
  }

  async function handlePullPrincipal(targetPrincipalId: string): Promise<void> {
    if (!self) {
      return;
    }

    setErrorText("");
    setStatusText("正在拉人进房间");

    try {
      await request<JoinResult>(`/api/rooms/${self.roomId}/pull`, {
        method: "POST",
        body: JSON.stringify({
          actorMemberId: self.memberId,
          wsToken: self.wsToken,
          targetPrincipalId,
        }),
      });
      setStatusText("已拉入房间");
      setFlashText("已将成员拉入当前聊天室");
      await hydrateRoomState(self.roomId);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "拉人失败");
      setStatusText("拉人失败");
    }
  }

  async function handleCreatePrivateAssistant(): Promise<void> {
    setErrorText("");
    setStatusText("正在生成助理接入链接");

    try {
      const activePrincipal = await ensurePrincipal();
      const created = await request<PrivateAssistantInviteRecord>("/api/me/assistants/invites", {
        method: "POST",
        body: JSON.stringify({
          principalId: activePrincipal.principalId,
          principalToken: activePrincipal.principalToken,
          name: privateAssistantName,
          backendType: "codex_cli",
        }),
      });
      setPrivateAssistantInvites((current) => {
        const next = current.filter((item) => item.id !== created.id);
        next.push(created);
        return sortByCreatedAt(next);
      });
      if (created.reused) {
        setStatusText("已找到现有接入链接");
        setFlashText("同名助理已有待接入链接，已直接展示");
      } else {
        setStatusText("接入链接已生成");
        setFlashText("私有助理接入链接已生成");
      }
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "生成私有助理接入链接失败");
      setStatusText("生成链接失败");
    }
  }

  async function handleCopyPrivateAssistantInvite(
    invite: Pick<PrivateAssistantInviteRecord, "name" | "inviteUrl">,
  ): Promise<void> {
    setErrorText("");
    setIsCopyingAssistantInvite(true);

    try {
      await navigator.clipboard.writeText(buildPrivateAssistantInvitePrompt(invite));
      setFlashText("私有助理接入文案已复制");
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "复制接入文案失败");
    } finally {
      setIsCopyingAssistantInvite(false);
    }
  }

  async function handleAdoptPrivateAssistant(privateAssistantId: string): Promise<void> {
    if (!self) {
      return;
    }

    setErrorText("");
    setStatusText("正在加入私有助理");

    try {
      await request<PublicMember>(`/api/rooms/${self.roomId}/assistants/adopt`, {
        method: "POST",
        body: JSON.stringify({
          actorMemberId: self.memberId,
          wsToken: self.wsToken,
          privateAssistantId,
        }),
      });
      setStatusText("私有助理已加入");
      setFlashText("已将私有助理加入当前聊天室");
      await hydrateRoomState(self.roomId);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "加入私有助理失败");
      setStatusText("加入私有助理失败");
    }
  }

  async function handleRemovePrivateAssistant(privateAssistantId: string): Promise<void> {
    if (!principal) {
      return;
    }

    setErrorText("");
    setStatusText("正在移除私有助理");

    try {
      await request<{ ok: true }>(
        `/api/me/assistants/${privateAssistantId}?principalId=${principal.principalId}&principalToken=${principal.principalToken}`,
        {
          method: "DELETE",
        },
      );
      setPrivateAssistants((current) =>
        current.filter((assistant) => assistant.id !== privateAssistantId),
      );
      setStatusText("已移除私有助理");
      setFlashText("私有助理已移除");
      if (room) {
        await hydrateRoomState(room.id);
      }
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "移除私有助理失败");
      setStatusText("移除失败");
    }
  }

  async function handleRemovePrivateAssistantInvite(inviteId: string): Promise<void> {
    if (!principal) {
      return;
    }

    setErrorText("");
    setStatusText("正在移除接入记录");

    try {
      await request<{ ok: true }>(
        `/api/me/assistants/invites/${inviteId}?principalId=${principal.principalId}&principalToken=${principal.principalToken}`,
        {
          method: "DELETE",
        },
      );
      setPrivateAssistantInvites((current) => current.filter((invite) => invite.id !== inviteId));
      setStatusText("接入记录已移除");
      setFlashText("已移除这条接入记录");
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "移除接入记录失败");
      setStatusText("移除失败");
    }
  }

  async function handleTakePrivateAssistantOffline(assistantMemberId: string): Promise<void> {
    if (!self) {
      return;
    }

    setErrorText("");
    setStatusText("正在下线助理");

    try {
      await request<{ ok: true }>(`/api/rooms/${self.roomId}/assistants/${assistantMemberId}/offline`, {
        method: "POST",
        body: JSON.stringify({
          actorMemberId: self.memberId,
          wsToken: self.wsToken,
        }),
      });
      setStatusText("助理已从聊天室下线");
      setFlashText("已从当前聊天室下线该助理");
      await hydrateRoomState(self.roomId);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "下线助理失败");
      setStatusText("下线失败");
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

      const fullInviteUrl = new URL(invite.inviteUrl, resolveAgentTavernInviteOrigin()).toString();
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
    ...Object.values(streams).map((stream) => {
      const streamSender = findMember(stream.agentMemberId);

      return {
        id: stream.messageId,
        roomId: self?.roomId ?? "",
        senderMemberId: stream.agentMemberId,
        senderDisplayName: streamSender?.displayName ?? stream.agentMemberId,
        senderType: streamSender?.type ?? "agent",
        senderRoleKind: streamSender?.roleKind ?? "assistant",
        senderPresenceStatus: streamSender?.presenceStatus ?? "online",
        messageType: "agent_text" as const,
        content: `${stream.content}▌`,
        attachments: [],
        systemData: null,
        replyToMessageId: null,
        createdAt: new Date().toISOString(),
      };
    }),
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
  const pendingPrivateAssistantInvites = useMemo(
    () => privateAssistantInvites.filter((invite) => invite.status === "pending"),
    [privateAssistantInvites],
  );
  const archivedPrivateAssistantInvites = useMemo(
    () => privateAssistantInvites.filter((invite) => invite.status !== "pending"),
    [privateAssistantInvites],
  );
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

  const visibleLobbyPrincipals = useMemo(() => lobbyPrincipals, [lobbyPrincipals]);
  const roomPrincipalIds = useMemo(
    () => new Set(members.map((member) => member.principalId).filter(Boolean)),
    [members],
  );
  const joinedPrivateAssistantIds = useMemo(
    () => new Set(members.map((member) => member.sourcePrivateAssistantId).filter(Boolean)),
    [members],
  );
  const loginKeyLabel = principalKind === "agent" ? "智能体标识" : "邮箱";
  const loginKeyPlaceholder =
    principalKind === "agent" ? "例如 agent:finance-bot" : "用于恢复身份";
  const principalStatusLine = principal
    ? principal.kind === "agent"
      ? `当前已登记为智能体一等公民：${principal.globalDisplayName}`
      : `当前已登记为人类一等公民：${principal.globalDisplayName}`
    : "首次进入需要先登记身份";
  const joinedRooms = useMemo<Array<RecentRoomRecord & { isCurrent: boolean }>>(() => {
    const items = recentRooms.map((item) => ({
      ...item,
      isCurrent: room?.id === item.roomId,
    }));

    if (room && !items.find((item) => item.roomId === room.id)) {
      items.unshift({
        roomId: room.id,
        name: room.name,
        inviteToken: room.inviteToken,
        visitedAt: new Date().toISOString(),
        isCurrent: true,
      });
    }

    return [...items].sort((left, right) => right.visitedAt.localeCompare(left.visitedAt));
  }, [recentRooms, room]);

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
            <h2>我的聊天室</h2>
              <button
                type="button"
                className="btn-icon icon-button"
                onClick={() => setShowRoomModal(true)}
              >
                ＋
            </button>
          </div>
          {joinedRooms.length > 0 ? (
            <div className="room-list">
              {joinedRooms.map((joinedRoom) => (
                <button
                  key={joinedRoom.roomId}
                  type="button"
                  className={`btn-ghost room-list-item ${joinedRoom.isCurrent ? "room-list-item-active" : ""}`}
                  onClick={() => void handleOpenRecentRoom(joinedRoom.roomId)}
                  disabled={joinedRoom.isCurrent}
                >
                  <span className="room-list-name">{joinedRoom.name}</span>
                  <span className="room-list-meta">{describeRecentRoom(joinedRoom)}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="muted-text">你加入过的聊天室会显示在这里，点击右上角可新建或通过邀请进入。</p>
          )}
        </section>
      </aside>

      <section className="chat-shell">
        <header className="chat-header">
          <div className="chat-header-bar">
            <div className="chat-header-brand">
              <strong>AgentTavern</strong>
              <span className="chat-header-context">
                {room ? `${members.length} 位成员在线` : "局域网聊天室"}
              </span>
            </div>
            <div className="chat-header-actions">
              <button
                type="button"
                className="btn-ghost header-utility-button"
                onClick={() => {
                  setShowAssistantPanel((current) => !current);
                  setShowAccountPanel(false);
                }}
              >
                助理
                <span className="header-utility-count">{privateAssistants.length}</span>
              </button>
              <button
                type="button"
                className="btn-ghost header-account-button"
                onClick={() => {
                  setShowAccountPanel((current) => !current);
                  setShowAssistantPanel(false);
                }}
              >
                {principal ? (
                  <>
                    <span className="header-account-name">{principal.globalDisplayName}</span>
                    <span className="header-account-meta">
                      {principal.kind === "agent" ? principal.loginKey : principal.loginKey}
                    </span>
                  </>
                ) : (
                  <span className="header-account-name">登录</span>
                )}
              </button>
            </div>
          </div>

          <div className="chat-header-main">
            <div className="chat-title-row">
              <p className="eyebrow">{room ? "当前聊天室" : "首页"}</p>
              <h1>{room?.name ?? "聊天室与在线成员入口"}</h1>
            </div>
            <div className="chat-title-tools">
              {roomInviteUrl ? (
                <button
                  type="button"
                  className="btn-secondary header-invite-button"
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
                  {isCopyingRoomInvite ? "复制中..." : "分享"}
                </button>
              ) : null}
              <div className="status-badge">
                <span className="status-dot" />
                <span>{statusText}</span>
              </div>
            </div>
          </div>
          {flashText || errorText ? (
            <div className={`feedback-strip ${errorText ? "feedback-strip-error" : "feedback-strip-info"}`}>
              {errorText || flashText}
            </div>
          ) : null}
        </header>

        <div className="chat-layout">
          <section className="message-panel">
            {room ? (
              <>
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
                const senderType = sender?.type ?? message.senderType;
                const senderRoleKind = sender?.roleKind ?? message.senderRoleKind ?? "none";
                const senderPresence = sender?.presenceStatus ?? message.senderPresenceStatus ?? null;
                const senderForLabel = sender
                  ? sender
                  : senderType
                    ? {
                        type: senderType,
                        roleKind: senderRoleKind,
                      }
                    : null;
                const isAgent = senderType === "agent" || message.messageType === "agent_text";
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
                const authorLabel = sender?.displayName ?? message.senderDisplayName ?? message.senderMemberId;
                const authorPresenceNote = presenceNote(senderPresence);

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
                        {authorPresenceNote ? (
                          <span className="sender-status-note">{authorPresenceNote}</span>
                        ) : null}
                        {senderForLabel ? (
                          <span className={`role-pill role-pill-${roleTone(senderForLabel)}`}>
                            {roleLabel(senderForLabel)}
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
              </>
            ) : (
              <div className="home-stage">
                <section className="home-hero-card">
                  <p className="eyebrow">进入方式</p>
                  <h2>先登记身份，再开始聊天或进入已有聊天室</h2>
                  <p>
                    这是一个局域网协作聊天室。你可以先登记人类或智能体身份，再通过统一入口进入协作：
                  </p>
                  <div className="home-bullet-list">
                    <span>新建一个聊天室并立即进入</span>
                    <span>通过邀请链接加入已有聊天室</span>
                    <span>从右下角在线用户入口直接开始双人聊天</span>
                    <span>提前保存自己的私有助理，再带入房间</span>
                  </div>
                </section>

                <section className="home-grid">
                  <article className="home-card">
                    <div className="section-heading">
                      <h2>在线用户</h2>
                      <span>{visibleLobbyPrincipals.length} 在线</span>
                    </div>
                    <p className="muted-text">
                      右下角会显示当前在线成员。你可以直接发起双人聊天；进入聊天室后，也可以把他们拉进当前房间。
                    </p>
                  </article>

                  <article className="home-card">
                    <div className="section-heading">
                      <h2>私有助理</h2>
                      <span>{privateAssistants.length} 个</span>
                    </div>
                    <p className="muted-text">
                      私有助理默认只对你可见。你可以先保存、先唤醒，之后在任意聊天室中把它们加入为助理成员。
                    </p>
                  </article>

                  <article className="home-card">
                    <div className="section-heading">
                      <h2>最近聊天室</h2>
                      <span>{recentRooms.length} 个</span>
                    </div>
                    {recentRooms.length > 0 ? (
                      <div className="lobby-list">
                        {recentRooms.slice(0, 3).map((recentRoom) => (
                          <div key={recentRoom.roomId} className="lobby-row">
                            <div className="lobby-copy">
                              <strong>{recentRoom.name}</strong>
                              <span>{describeRecentRoom(recentRoom)}</span>
                            </div>
                            <button
                              className="btn-ghost inline-link-button"
                              type="button"
                              onClick={() => handleOpenRecentRoom(recentRoom.roomId)}
                            >
                              进入
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="muted-text">进入过的聊天室会显示在这里，方便快速回到最近协作空间。</p>
                    )}
                  </article>
                </section>
              </div>
            )}
          </section>

          <aside className="member-sidebar">
            {room ? (
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
            ) : (
              <>
                <section className="side-card">
                  <div className="section-heading">
                    <h2>首页提示</h2>
                    <span>开始前</span>
                  </div>
                  <div className="collab-state-list">
                    <article className="collab-state-card">
                      <div className="collab-state-head">
                        <span className="collab-state-pill collab-state-pill-warning">第一步</span>
                      </div>
                      <strong>先登记你的身份</strong>
                      <p>支持人类和智能体两种身份。人类用邮箱登记，智能体用标识和 Codex thread id 登记。</p>
                    </article>
                    <article className="collab-state-card">
                      <div className="collab-state-head">
                        <span className="collab-state-pill collab-state-pill-success">第二步</span>
                      </div>
                      <strong>开始聊天或创建房间</strong>
                      <p>你可以先从右下角在线用户入口发起双人聊天，也可以直接新建一个多人聊天室。</p>
                    </article>
                  </div>
                </section>

                <section className="side-card">
                  <div className="section-heading">
                    <h2>在线快照</h2>
                    <span>{visibleLobbyPrincipals.length} 在线</span>
                  </div>
                  <div className="collab-state-list">
                    {visibleLobbyPrincipals.slice(0, 4).map((item) => (
                      <article key={item.id} className="collab-state-card">
                        <div className="collab-state-head">
                          <span className="collab-state-pill collab-state-pill-success">
                            {item.kind === "agent" ? "智能体" : "人类"}
                          </span>
                        </div>
                        <strong>{item.globalDisplayName}</strong>
                        <p>
                          {item.loginKey}
                          {item.kind === "agent" && item.runtimeStatus
                            ? ` · ${runtimeText(item.runtimeStatus)}`
                            : ""}
                        </p>
                      </article>
                    ))}
                    {visibleLobbyPrincipals.length === 0 ? (
                      <p className="muted-text">登录后，这里会显示当前在线成员的快照。</p>
                    ) : null}
                  </div>
                </section>
              </>
            )}

            {room ? (
              <>
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
                                  {owner.id === self?.memberId && assistant.sourcePrivateAssistantId ? (
                                    <button
                                      type="button"
                                      className="btn-ghost inline-link-button"
                                      onClick={() => void handleTakePrivateAssistantOffline(assistant.id)}
                                    >
                                      从本房间移除
                                    </button>
                                  ) : null}
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
                                  onClick={() =>
                                    focusMessage(approval.triggerMessageId, "已定位到触发消息")
                                  }
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
              </>
            ) : null}
          </aside>
        </div>
      </section>

      {showAccountPanel ? (
        <div className="screen-overlay" onClick={() => setShowAccountPanel(false)}>
          <section className="floating-panel account-panel" onClick={(event) => event.stopPropagation()}>
            <div className="section-heading">
              <h2>{principal ? "编辑身份" : "登录身份"}</h2>
              <button type="button" className="btn-icon icon-button" onClick={() => setShowAccountPanel(false)}>
                ×
              </button>
            </div>
            <label>
              <span>身份类型</span>
              <select
                value={principalKind}
                onChange={(event) => setPrincipalKind(event.target.value as "human" | "agent")}
              >
                <option value="human">人类</option>
                <option value="agent">智能体</option>
              </select>
            </label>
            <label>
              <span>{loginKeyLabel}</span>
              <input
                value={loginKey}
                onChange={(event) => setLoginKey(event.target.value)}
                placeholder={loginKeyPlaceholder}
              />
            </label>
            <label>
              <span>全局昵称</span>
              <input
                value={globalDisplayName}
                onChange={(event) => setGlobalDisplayName(event.target.value)}
              />
            </label>
            {principalKind === "agent" ? (
              <label>
                <span>Codex Thread ID</span>
                <input
                  value={principalBackendThreadId}
                  onChange={(event) => setPrincipalBackendThreadId(event.target.value)}
                  placeholder="例如 thread_agent_principal_finance"
                />
              </label>
            ) : null}
            <div className="floating-panel-actions">
              <button type="button" className="btn-primary" onClick={() => void handleBootstrapPrincipal()}>
                {principal ? "保存身份" : "登录"}
              </button>
              {principal ? (
                <button type="button" className="btn-ghost inline-link-button" onClick={handleLogoutPrincipal}>
                  退出
                </button>
              ) : null}
            </div>
            <div className="sidebar-tip">{principalStatusLine}</div>
          </section>
        </div>
      ) : null}

      {showAssistantPanel ? (
        <div className="screen-overlay" onClick={() => setShowAssistantPanel(false)}>
          <section className="floating-panel assistant-panel" onClick={(event) => event.stopPropagation()}>
            <div className="section-heading">
              <h2>我的私有助理</h2>
              <span>{privateAssistants.length} 个已接入</span>
            </div>
            <label>
              <span>助理名称</span>
              <input
                value={privateAssistantName}
                onChange={(event) => setPrivateAssistantName(event.target.value)}
              />
            </label>
            <button type="button" className="btn-primary" onClick={() => void handleCreatePrivateAssistant()}>
              生成接入链接
            </button>
            <div className="sidebar-tip">
              先生成链接，再把链接发给要接入的 Codex。接入成功后，这个助理会出现在下方列表，并可加入任意聊天室。
            </div>
            {errorText ? <div className="assistant-panel-error">{errorText}</div> : null}
            {pendingPrivateAssistantInvites.length > 0 ? (
              <div className="assistant-invite-section">
                <div className="section-heading">
                  <h2>待处理接入</h2>
                  <span>{pendingPrivateAssistantInvites.length} 条</span>
                </div>
                <div className="lobby-list">
                {pendingPrivateAssistantInvites.map((invite) => (
                  <div key={invite.id} className="lobby-row">
                    <div className="lobby-copy assistant-invite-copy">
                      <strong>{invite.name}</strong>
                      <span>{privateAssistantInviteStatusLabel(invite.status)}</span>
                      <div className="assistant-invite-prompt">
                        {buildPrivateAssistantInvitePrompt(invite)}
                      </div>
                    </div>
                    <div className="assistant-row-actions">
                      <button
                        type="button"
                        className="btn-secondary inline-action-button"
                        disabled={isCopyingAssistantInvite}
                        onClick={() => void handleCopyPrivateAssistantInvite(invite)}
                      >
                        {isCopyingAssistantInvite ? "复制中..." : "复制接入文案"}
                      </button>
                      <button
                        type="button"
                        className="btn-ghost inline-link-button"
                        onClick={() => void handleRemovePrivateAssistantInvite(invite.id)}
                      >
                        撤销接入
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              </div>
            ) : null}
            {archivedPrivateAssistantInvites.length > 0 ? (
              <div className="assistant-invite-section">
                <div className="section-heading">
                  <h2>接入记录</h2>
                  <span>{archivedPrivateAssistantInvites.length} 条</span>
                </div>
                <div className="lobby-list">
                  {archivedPrivateAssistantInvites.map((invite) => (
                    <div key={invite.id} className="lobby-row">
                      <div className="lobby-copy">
                        <strong>{invite.name}</strong>
                        <span>{privateAssistantInviteStatusLabel(invite.status)}</span>
                      </div>
                      <button
                        type="button"
                        className="btn-ghost inline-link-button"
                        onClick={() => void handleRemovePrivateAssistantInvite(invite.id)}
                      >
                        移除记录
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {privateAssistants.length > 0 ? (
              <div className="assistant-invite-section">
                <div className="section-heading">
                  <h2>已接入私有助理</h2>
                  <span>{privateAssistants.length} 个</span>
                </div>
                <div className="lobby-list">
                {privateAssistants.map((assistant) => (
                  <div key={assistant.id} className="lobby-row">
                    <div className="lobby-copy">
                      <strong>{assistant.name}</strong>
                      <span>
                        {assistant.backendType === "codex_cli" ? "Codex 助理" : assistant.backendType}
                        {privateAssistantStatusLabel(assistant.status)
                          ? ` · ${privateAssistantStatusLabel(assistant.status)}`
                          : ""}
                      </span>
                    </div>
                    <div className="assistant-row-actions">
                      {room ? (
                        <button
                          type="button"
                          className="btn-secondary inline-action-button"
                          disabled={joinedPrivateAssistantIds.has(assistant.id)}
                          onClick={() => void handleAdoptPrivateAssistant(assistant.id)}
                        >
                          {joinedPrivateAssistantIds.has(assistant.id) ? "已加入" : "加入房间"}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="btn-ghost inline-link-button"
                        onClick={() => void handleRemovePrivateAssistant(assistant.id)}
                      >
                        移除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              </div>
            ) : (
              <p className="muted-text">先生成接入链接，把 Codex 接进来；完成后就能把私有助理加入任意聊天室。</p>
            )}
          </section>
        </div>
      ) : null}

      {showRoomModal ? (
        <div className="screen-overlay" onClick={() => setShowRoomModal(false)}>
          <section className="floating-panel room-modal" onClick={(event) => event.stopPropagation()}>
            <div className="section-heading">
              <h2>新建或进入聊天室</h2>
              <button type="button" className="btn-icon icon-button" onClick={() => setShowRoomModal(false)}>
                ×
              </button>
            </div>
            <label>
              <span>新房间名称</span>
              <input value={roomName} onChange={(event) => setRoomName(event.target.value)} />
            </label>
            <button
              type="button"
              className="btn-primary"
              onClick={async () => {
                const success = await handleCreateRoom();
                if (success) {
                  setShowRoomModal(false);
                }
              }}
            >
              新建并进入
            </button>
            <label>
              <span>邀请链接或邀请码</span>
              <input
                value={inviteInput}
                onChange={(event) => setInviteInput(event.target.value)}
                placeholder="粘贴 /join/... 或邀请码"
              />
            </label>
            <button
              type="button"
              className="btn-secondary modal-action-button"
              onClick={async () => {
                const success = await handleJoinRoom();
                if (success) {
                  setShowRoomModal(false);
                }
              }}
            >
              通过邀请进入
            </button>
          </section>
        </div>
      ) : null}

      <div className={`online-dock ${showOnlinePanel ? "online-dock-open" : ""}`}>
        <button
          type="button"
          className="btn-primary online-dock-trigger"
          onClick={() => setShowOnlinePanel((current) => !current)}
        >
          在线成员
          <span className="online-dock-count">{visibleLobbyPrincipals.length}</span>
        </button>
        {showOnlinePanel ? (
          <section className="online-dock-panel">
            <div className="section-heading">
              <h2>在线用户</h2>
              <span>{visibleLobbyPrincipals.length} 在线</span>
            </div>
            {visibleLobbyPrincipals.length > 0 ? (
              <div className="lobby-list">
                {visibleLobbyPrincipals.map((item) => (
                  <div key={item.id} className="lobby-row">
                    <div className="lobby-copy">
                      <strong>
                        {item.globalDisplayName}
                        {item.id === principal?.principalId ? "（你）" : ""}
                      </strong>
                      <span>
                        {item.kind === "agent"
                          ? `智能体 · ${item.loginKey}${item.runtimeStatus ? ` · ${runtimeText(item.runtimeStatus)}` : ""}`
                          : `人类 · ${item.loginKey}`}
                      </span>
                    </div>
                    {item.id === principal?.principalId ? (
                      <button
                        type="button"
                        className="btn-ghost inline-action-button"
                        disabled
                      >
                        自己
                      </button>
                    ) : room && roomPrincipalIds.has(item.id) ? (
                      <button
                        type="button"
                        className="btn-ghost inline-action-button"
                        disabled
                      >
                        已在房间
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn-secondary inline-action-button"
                        onClick={() => void (room ? handlePullPrincipal(item.id) : handleStartDirectRoom(item.id))}
                      >
                        {room ? "拉入房间" : "开始聊天"}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted-text">登录后，这里会显示当前在线成员。</p>
            )}
          </section>
        ) : null}
      </div>
    </main>
  );
}

export default App;
