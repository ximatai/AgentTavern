import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button, Select } from "antd";
import { CloseOutlined, DownOutlined, RobotOutlined, UpOutlined } from "@ant-design/icons";
import type {
  AgentSessionKind,
  AgentSessionStatus,
  ApprovalGrantDuration,
  PublicMember,
} from "@agent-tavern/shared";

import { useRoomStore } from "../stores/room";
import { useApprovalStore } from "../stores/approval";
import { useSessionStore } from "../stores/session";
import { useMessageStore } from "../stores/message";
import { RoomAssistantModal } from "./RoomAssistantModal";

import "../styles/room-sidebar.css";

/* ── Helpers ── */

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function sessionTone(status: AgentSessionStatus): "success" | "error" | "warning" {
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

function sessionStatusKey(status: AgentSessionStatus): string {
  const map: Record<AgentSessionStatus, string> = {
    pending: "roomSidebar.sessionPending",
    waiting_approval: "roomSidebar.sessionWaitingApproval",
    running: "roomSidebar.sessionRunning",
    completed: "roomSidebar.sessionCompleted",
    rejected: "roomSidebar.sessionRejected",
    failed: "roomSidebar.sessionFailed",
    cancelled: "roomSidebar.sessionCancelled",
  };
  return map[status];
}

function sessionKindKey(kind: AgentSessionKind | "unknown"): string {
  const map: Record<AgentSessionKind | "unknown", string> = {
    message_reply: "roomSidebar.sessionKindReply",
    room_observe: "roomSidebar.sessionKindObserve",
    summary_refresh: "roomSidebar.sessionKindSummarize",
    unknown: "roomSidebar.sessionKindUnknown",
  };
  return map[kind];
}

function getRuntimeLabel(
  member: PublicMember,
  t: (key: string) => string,
): string | null {
  if (member.type === "agent" && member.presenceStatus === "offline" && member.runtimeStatus === null) {
    return t("roomSidebar.runtimeOffline");
  }

  switch (member.runtimeStatus) {
    case "ready":
      return t("roomSidebar.runtimeReady");
    case "pending_bridge":
      return t("roomSidebar.runtimePendingBridge");
    case "waiting_bridge":
      return t("roomSidebar.runtimeWaitingBridge");
    default:
      return null;
  }
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

type OwnerAssistantGroup = { owner: PublicMember; assistants: PublicMember[] };
type CollabItem = {
  id: string;
  createdAt: string;
  node: ReactNode;
};

function buildAssistantTree(members: PublicMember[]): OwnerAssistantGroup[] {
  const assistants = members.filter((m) => m.type === "agent" && m.roleKind === "assistant");
  const groups = new Map<string, PublicMember[]>();
  for (const a of assistants) {
    const key = a.ownerMemberId ?? "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(a);
  }
  const result: OwnerAssistantGroup[] = [];
  for (const [ownerId, asts] of groups) {
    const owner = members.find((m) => m.id === ownerId);
    if (owner) result.push({ owner, assistants: asts });
  }
  return result;
}

const GRANT_OPTIONS: Array<{ value: ApprovalGrantDuration; label: string }> = [
  { value: "once", label: "systemNotice.grantOnce" },
  { value: "10_minutes", label: "systemNotice.grant10m" },
  { value: "30_minutes", label: "systemNotice.grant30m" },
  { value: "1_hour", label: "systemNotice.grant1h" },
  { value: "forever", label: "systemNotice.grantForever" },
];

/* ── Component ── */

export function RoomSidebar() {
  const { t } = useTranslation();
  const room = useRoomStore((s) => s.room);
  const roomSummary = useRoomStore((s) => s.roomSummary);
  const self = useRoomStore((s) => s.self);
  const members = useRoomStore((s) => s.members);
  const pendingApprovals = useApprovalStore((s) => s.pendingApprovals);
  const approvalGrants = useApprovalStore((s) => s.approvalGrants);
  const setGrantDuration = useApprovalStore((s) => s.setGrantDuration);
  const approve = useApprovalStore((s) => s.approve);
  const reject = useApprovalStore((s) => s.reject);
  const sessionSnapshots = useSessionStore((s) => s.sessionSnapshots);
  const messages = useMessageStore((s) => s.messages);
  const streams = useMessageStore((s) => s.streams);

  const [busyApprovalId, setBusyApprovalId] = useState<string | null>(null);
  const [collabExpanded, setCollabExpanded] = useState(false);
  const [dismissedCollabIds, setDismissedCollabIds] = useState<string[]>([]);
  const [assistantModalOpen, setAssistantModalOpen] = useState(false);

  const collabDismissKey = room && self
    ? `agent-tavern-room-sidebar-dismissed:${room.id}:${self.memberId}`
    : null;

  useEffect(() => {
    if (!collabDismissKey) {
      setDismissedCollabIds([]);
      return;
    }
    try {
      const raw = window.localStorage.getItem(collabDismissKey);
      setDismissedCollabIds(raw ? JSON.parse(raw) : []);
    } catch {
      setDismissedCollabIds([]);
    }
  }, [collabDismissKey]);

  useEffect(() => {
    if (!collabDismissKey) return;
    window.localStorage.setItem(collabDismissKey, JSON.stringify(dismissedCollabIds));
  }, [collabDismissKey, dismissedCollabIds]);

  /* Derived data */
  const memberMap = useMemo(() => {
    const map = new Map<string, PublicMember>();
    for (const m of members) map.set(m.id, m);
    return map;
  }, [members]);
  const ownerMemberId = room?.ownerMemberId ?? null;

  const humansWithAssistants = useMemo(() => {
    const sortedHumans = members
      .filter((m) => m.type === "human")
      .sort((a, b) => {
        if (a.id === ownerMemberId && b.id !== ownerMemberId) return -1;
        if (b.id === ownerMemberId && a.id !== ownerMemberId) return 1;
        return a.createdAt.localeCompare(b.createdAt);
      });
    const tree = buildAssistantTree(members);
    const ownerAssistantMap = new Map<string, PublicMember[]>();
    for (const { owner, assistants } of tree) {
      ownerAssistantMap.set(owner.id, assistants);
    }
    return sortedHumans.map((h) => ({
      human: h,
      assistants: ownerAssistantMap.get(h.id) ?? [],
    }));
  }, [members, ownerMemberId]);

  const independentAgents = useMemo(
    () => members.filter((m) => m.type === "agent" && m.roleKind === "independent"),
    [members],
  );
  const secretaryMemberId = room?.secretaryMemberId ?? null;

  const runningSessionSummaries = useMemo(
    () =>
      Object.values(sessionSnapshots)
        .filter((s) => ["pending", "waiting_approval", "running"].includes(s.status))
        .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "")),
    [sessionSnapshots],
  );

  const recentIssueMessages = useMemo(
    () =>
      messages
        .filter((m) => m.systemData && m.systemData.status === "error")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 4),
    [messages],
  );

  /* Actions */
  const focusMessage = (messageId: string) => {
    const el = document.querySelector(`[data-message-id="${messageId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("chat-row-focused");
      setTimeout(() => el.classList.remove("chat-row-focused"), 1800);
    }
  };

  const findApprovalMessage = useCallback(
    (approvalId: string) =>
      messages.find(
        (m) => m.systemData?.approvalId === approvalId && m.messageType === "approval_request",
      ),
    [messages],
  );

  const handleApproval = useCallback(
    (approvalId: string, action: "approve" | "reject") => {
      if (!self) return;
      setBusyApprovalId(approvalId);
      const fn = action === "approve" ? approve : reject;
      fn({
        approvalId,
        actorMemberId: self.memberId,
        wsToken: self.wsToken,
      }).finally(() => setBusyApprovalId(null));
    },
    [approve, reject, self],
  );

  const collabItems = useMemo<CollabItem[]>(() => {
    const items: CollabItem[] = [];

    pendingApprovals.forEach((approval) => {
      const agent = memberMap.get(approval.agentMemberId);
      const requester = memberMap.get(approval.requesterMemberId);
      const owner = memberMap.get(approval.ownerMemberId);
      const mine = approval.ownerMemberId === self?.memberId;
      const approvalMsg = findApprovalMessage(approval.id);
      const selectedGrant = approvalGrants[approval.id] ?? "once";
      const detail = mine
        ? t("roomSidebar.waitingForYouDetail")
        : t("roomSidebar.waitingForOwnerDetail");
      const approvalItems = [
        {
          label: t("roomSidebar.requester"),
          value: requester?.displayName ?? approval.requesterMemberId,
        },
        {
          label: t("roomSidebar.agent"),
          value: agent?.displayName ?? approval.agentMemberId,
        },
        {
          label: t("roomSidebar.owner"),
          value: owner?.displayName ?? approval.ownerMemberId,
        },
        {
          label: t("approval.status"),
          value: mine
            ? t("roomSidebar.waitingForYou")
            : t("roomSidebar.waitingForOwner"),
        },
      ];
      items.push({
        id: `approval:${approval.id}`,
        createdAt: approval.createdAt,
        node: (
          <article className="rs-collab-card rs-collab-card-approval">
            <div className="rs-collab-head">
              <span className="rs-pill rs-pill-warning">{t("approval.pending")}</span>
              <div className="rs-collab-head-side">
                <span className="rs-collab-time">{formatTime(approval.createdAt)}</span>
                <button
                  type="button"
                  className="rs-collab-dismiss"
                  aria-label={t("roomSidebar.dismissStatus")}
                  onClick={() =>
                    setDismissedCollabIds((current) =>
                      current.includes(`approval:${approval.id}`)
                        ? current
                        : [...current, `approval:${approval.id}`],
                    )
                  }
                >
                  <CloseOutlined />
                </button>
              </div>
            </div>
            <strong className="rs-collab-title">
              {agent?.displayName ?? approval.agentMemberId}{" "}
              {t("roomSidebar.waitingOwner")}
            </strong>
            <p className="rs-collab-desc">
              {t("roomSidebar.requester")}:{" "}
              {requester?.displayName ?? approval.requesterMemberId}
            </p>
            <p className="rs-approval-desc">{detail}</p>
            <div className="rs-approval-grid">
              {approvalItems.map((item) => (
                <div key={item.label} className="rs-approval-item">
                  <span className="rs-approval-item-label">{item.label}</span>
                  <strong className="rs-approval-item-value">{item.value}</strong>
                </div>
              ))}
            </div>
            <div className="rs-collab-actions">
              <button
                type="button"
                className="chat-action-button"
                onClick={() => focusMessage(approval.triggerMessageId)}
              >
                {t("chat.viewOriginal")}
              </button>
              {approvalMsg && (
                <button
                  type="button"
                  className="chat-action-button"
                  onClick={() => focusMessage(approvalMsg.id)}
                >
                  {t("roomSidebar.viewApproval")}
                </button>
              )}
            </div>
            {mine && (
              <div className="rs-approval-controls">
                <Select
                  size="small"
                  value={selectedGrant}
                  onChange={(value: ApprovalGrantDuration) =>
                    setGrantDuration(approval.id, value)
                  }
                  disabled={busyApprovalId === approval.id}
                  style={{ width: 110 }}
                  options={GRANT_OPTIONS.map((o) => ({
                    value: o.value,
                    label: t(o.label),
                  }))}
                />
                <Button
                  size="small"
                  type="primary"
                  loading={busyApprovalId === approval.id}
                  onClick={() => handleApproval(approval.id, "approve")}
                >
                  {t("approval.approve")}
                </Button>
                <Button
                  size="small"
                  danger
                  loading={busyApprovalId === approval.id}
                  onClick={() => handleApproval(approval.id, "reject")}
                >
                  {t("approval.reject")}
                </Button>
              </div>
            )}
          </article>
        ),
      });
    });

    runningSessionSummaries.forEach((session) => {
      const agent = memberMap.get(session.agentMemberId);
      const requester = session.requesterMemberId
        ? memberMap.get(session.requesterMemberId)
        : undefined;
      const stream = Object.values(streams).find((s) => s.sessionId === session.id);
      items.push({
        id: `session:${session.id}`,
        createdAt: session.startedAt ?? new Date().toISOString(),
        node: (
          <article className="rs-collab-card">
            <div className="rs-collab-head">
              <span className={`rs-pill rs-pill-${sessionTone(session.status)}`}>
                {t(sessionStatusKey(session.status))}
              </span>
              <div className="rs-collab-head-side">
                <span className="rs-collab-time">
                  {formatTime(session.startedAt ?? new Date().toISOString())}
                </span>
                <button
                  type="button"
                  className="rs-collab-dismiss"
                  aria-label={t("roomSidebar.dismissStatus")}
                  onClick={() =>
                    setDismissedCollabIds((current) =>
                      current.includes(`session:${session.id}`)
                        ? current
                        : [...current, `session:${session.id}`],
                    )
                  }
                >
                  <CloseOutlined />
                </button>
              </div>
            </div>
            <strong className="rs-collab-title">
              {agent?.displayName ?? session.agentMemberId}{" "}
              {t("roomSidebar.processingRequest")}
            </strong>
            <p className="rs-collab-desc">
              {t("roomSidebar.sessionType")}: {t(sessionKindKey(session.kind))}
            </p>
            {session.kind === "message_reply" ? (
              <p className="rs-collab-desc">
                {t("roomSidebar.requester")}:{" "}
                {requester?.displayName ?? session.requesterMemberId ?? "?"}
              </p>
            ) : null}
            <p className="rs-collab-stream">
              {stream?.content
                ? stream.content.slice(-72)
                : t("roomSidebar.waitingForOutput")}
            </p>
            <div className="rs-collab-actions">
              <button
                type="button"
                className="chat-action-button"
                onClick={() => focusMessage(session.triggerMessageId)}
              >
                {t("roomSidebar.viewTrigger")}
              </button>
            </div>
          </article>
        ),
      });
    });

    recentIssueMessages.forEach((message) => {
      items.push({
        id: `issue:${message.id}`,
        createdAt: message.createdAt,
        node: (
          <article className="rs-collab-card">
            <div className="rs-collab-head">
              <span className="rs-pill rs-pill-error">
                {message.systemData?.kind === "bridge_waiting"
                  ? t("roomSidebar.bridgeWaiting")
                  : t("roomSidebar.recentIssue")}
              </span>
              <div className="rs-collab-head-side">
                <span className="rs-collab-time">{formatTime(message.createdAt)}</span>
                <button
                  type="button"
                  className="rs-collab-dismiss"
                  aria-label={t("roomSidebar.dismissStatus")}
                  onClick={() =>
                    setDismissedCollabIds((current) =>
                      current.includes(`issue:${message.id}`)
                        ? current
                        : [...current, `issue:${message.id}`],
                    )
                  }
                >
                  <CloseOutlined />
                </button>
              </div>
            </div>
            <strong className="rs-collab-title">
              {message.systemData?.title ?? t("roomSidebar.systemEvent")}
            </strong>
            <p className="rs-collab-desc">
              {message.systemData?.detail ?? message.content}
            </p>
            <div className="rs-collab-actions">
              <button
                type="button"
                className="chat-action-button"
                onClick={() => focusMessage(message.id)}
              >
                {t("roomSidebar.viewMessage")}
              </button>
            </div>
          </article>
        ),
      });
    });

    return items.filter((item) => !dismissedCollabIds.includes(item.id));
  }, [
    approvalGrants,
    busyApprovalId,
    dismissedCollabIds,
    memberMap,
    pendingApprovals,
    recentIssueMessages,
    runningSessionSummaries,
    self?.memberId,
    findApprovalMessage,
    handleApproval,
    setGrantDuration,
    streams,
    t,
  ]);

  const activeItemCount = collabItems.length;
  const visibleCollabItems = collabExpanded ? collabItems : collabItems.slice(0, 1);
  const hiddenCollabCount = Math.max(0, collabItems.length - visibleCollabItems.length);

  return (
    <div className="room-sidebar-content">
      {/* ── Section 1: Collaboration Status ── */}
      <section className="rs-section">
        <div className="rs-section-header">
          <h4>{t("roomSidebar.collabStatus")}</h4>
          {activeItemCount > 1 ? (
            <button
              type="button"
              className="rs-section-badge rs-section-badge-button"
              onClick={() => setCollabExpanded((value) => !value)}
              aria-expanded={collabExpanded}
            >
              <span>
                {activeItemCount} {t("roomSidebar.activeItems")}
              </span>
              {collabExpanded ? <UpOutlined /> : <DownOutlined />}
            </button>
          ) : (
            <span className="rs-section-badge">
              {activeItemCount} {t("roomSidebar.activeItems")}
            </span>
          )}
        </div>

        <div className="rs-collab-list">
          {activeItemCount === 0 && (
            <p className="rs-muted">{t("roomSidebar.noActivity")}</p>
          )}

          {visibleCollabItems.map((item, index) => (
            <div
              key={item.id}
              className={[
                "rs-collab-stack",
                !collabExpanded && index === 0 && hiddenCollabCount > 0 ? "has-more" : "",
              ].filter(Boolean).join(" ")}
            >
              {item.node}
            </div>
          ))}

        </div>
        {roomSummary ? (
          <div className="rs-summary-card">
            <span className="rs-summary-label">{t("roomSidebar.roomSummary")}</span>
            <p>{roomSummary.summaryText}</p>
          </div>
        ) : null}
      </section>

      {/* ── Section 2: Room Members ── */}
      <section className="rs-section">
        <div className="rs-section-header">
          <div className="rs-section-header-main">
            <h4>{t("roomSidebar.roomMembers")}</h4>
            <span className="rs-section-badge">{members.length}</span>
          </div>
          <button
            type="button"
            className="rs-section-badge rs-section-badge-button"
            onClick={() => setAssistantModalOpen(true)}
          >
            <RobotOutlined />
            <span>{t("roomSidebar.manageAssistants")}</span>
          </button>
        </div>

        <div className="rs-member-list">
          {humansWithAssistants.map(({ human, assistants }) => (
            <div key={human.id} className="rs-human-group">
              <div className="rs-member-row">
                <div
                  className="rs-member-avatar"
                  style={{ background: getMemberColor(human) }}
                >
                  {human.displayName.charAt(0)}
                </div>
                <div className="rs-member-info">
                  <div className="rs-member-title">
                    <strong>
                      {human.displayName}
                      {human.id === self?.memberId && (
                        <span className="rs-self-marker">({t("roomSidebar.you")})</span>
                      )}
                    </strong>
                    {human.id === ownerMemberId ? (
                      <span className="rs-role-badge rs-role-badge-owner">
                        {t("roomSidebar.roomOwner")}
                      </span>
                    ) : null}
                  </div>
                  <p>{t("roomSidebar.inRoom")}</p>
                </div>
              </div>
              {assistants.length > 0 && (
                <div className="rs-assistant-children">
                  {assistants.map((assistant) => (
                    <div key={assistant.id} className="rs-member-row rs-member-row-child">
                      <div
                        className="rs-member-avatar"
                        style={{ background: getMemberColor(assistant) }}
                      >
                        {assistant.displayName.charAt(0)}
                      </div>
                      <div className="rs-member-info">
                        <div className="rs-member-title">
                          <strong>{assistant.displayName}</strong>
                          <span className="rs-role-badge rs-role-badge-agent">
                            Agent
                          </span>
                          {getRuntimeLabel(assistant, t) && (
                            <span
                              className={`rs-runtime-pill rs-runtime-pill-${assistant.runtimeStatus}`}
                            >
                              {getRuntimeLabel(assistant, t)}
                            </span>
                          )}
                        </div>
                        <p>
                          {t("roomSidebar.directReport", {
                            name: human.displayName,
                          })}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          {independentAgents.map((member) => (
            <div key={member.id} className="rs-member-row">
              <div
                className="rs-member-avatar"
                style={{ background: getMemberColor(member) }}
              >
                {member.displayName.charAt(0)}
              </div>
              <div className="rs-member-info">
                <div className="rs-member-title">
                  <strong>{member.displayName}</strong>
                  <span className="rs-role-badge rs-role-badge-agent">
                    Agent
                  </span>
                  {member.id === secretaryMemberId ? (
                    <span className="rs-role-badge rs-role-badge-secretary">
                      {t("roomSidebar.secretary")}
                    </span>
                  ) : null}
                  {getRuntimeLabel(member, t) && (
                    <span
                      className={`rs-runtime-pill rs-runtime-pill-${member.runtimeStatus}`}
                    >
                      {getRuntimeLabel(member, t)}
                    </span>
                  )}
                </div>
                <p>{t("roomSidebar.canBeMentioned")}</p>
              </div>
            </div>
          ))}
        </div>

      </section>
      <RoomAssistantModal open={assistantModalOpen} onClose={() => setAssistantModalOpen(false)} />
    </div>
  );
}
