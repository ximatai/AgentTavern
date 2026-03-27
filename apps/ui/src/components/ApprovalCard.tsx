import { useTranslation } from "react-i18next";
import { Button, Select } from "antd";
import { useMemo, useState } from "react";
import type { ApprovalGrantDuration, PublicMember, SystemMessageData } from "@agent-tavern/shared";

import { useApprovalStore } from "../stores/approval";
import { useRoomStore } from "../stores/room";

/* ── Helpers ── */

const GRANT_OPTIONS: Array<{ value: ApprovalGrantDuration; label: string }> = [
  { value: "once", label: "approval.grantOnce" },
  { value: "10_minutes", label: "approval.grant10m" },
  { value: "30_minutes", label: "approval.grant30m" },
  { value: "1_hour", label: "approval.grant1h" },
  { value: "forever", label: "approval.grantForever" },
];

function kindBadge(
  kind: SystemMessageData["kind"],
  t: (key: string) => string,
): string {
  switch (kind) {
    case "approval_required":
      return t("approval.pending");
    case "approval_granted":
      return t("approval.approved");
    case "approval_rejected":
      return t("approval.rejected");
    case "approval_expired":
      return t("approval.expired");
    default:
      return t("approval.title");
  }
}

function cardStatus(
  status: SystemMessageData["status"],
): "warning" | "success" | "error" {
  switch (status) {
    case "success":
      return "success";
    case "error":
      return "error";
    default:
      return "warning";
  }
}

function grantText(
  duration: ApprovalGrantDuration | null | undefined,
  t: (key: string) => string,
): string {
  if (!duration) return "";
  const opt = GRANT_OPTIONS.find((o) => o.value === duration);
  return opt ? t(opt.label) : "";
}

/* ── Types ── */

type SummaryItem = { label: string; value: string };

type ApprovalCardProps = {
  sysData: SystemMessageData;
  memberMap: Map<string, PublicMember>;
  replyToMessageId: string | null;
  onFocusMessage: (messageId: string) => void;
};

/* ── Component ── */

export function ApprovalCard({
  sysData,
  memberMap,
  replyToMessageId,
  onFocusMessage,
}: ApprovalCardProps) {
  const { t } = useTranslation();
  const self = useRoomStore((s) => s.self);
  const pendingApprovals = useApprovalStore((s) => s.pendingApprovals);
  const approvalGrants = useApprovalStore((s) => s.approvalGrants);
  const setGrantDuration = useApprovalStore((s) => s.setGrantDuration);
  const approve = useApprovalStore((s) => s.approve);
  const reject = useApprovalStore((s) => s.reject);

  const [busyId, setBusyId] = useState<string | null>(null);

  const status = cardStatus(sysData.status);
  const badge = kindBadge(sysData.kind, t);
  const grant = grantText(sysData.grantDuration, t);

  const linkedPending = useMemo(
    () => (sysData.approvalId ? pendingApprovals.find((a) => a.id === sysData.approvalId) : undefined),
    [pendingApprovals, sysData.approvalId],
  );

  const canResolve = !!linkedPending && linkedPending.ownerMemberId === self?.memberId;
  const selectedGrant = linkedPending
    ? approvalGrants[linkedPending.id] ?? "once"
    : "once";

  const items: SummaryItem[] = useMemo(() => {
    const out: SummaryItem[] = [];
    if (sysData.requesterMemberId) {
      const m = memberMap.get(sysData.requesterMemberId);
      out.push({ label: t("systemNotice.requester"), value: m?.displayName ?? sysData.requesterMemberId });
    }
    if (sysData.agentMemberId) {
      const m = memberMap.get(sysData.agentMemberId);
      out.push({ label: t("systemNotice.agent"), value: m?.displayName ?? sysData.agentMemberId });
    }
    if (sysData.ownerMemberId) {
      const m = memberMap.get(sysData.ownerMemberId);
      out.push({ label: t("systemNotice.owner"), value: m?.displayName ?? sysData.ownerMemberId });
    }
    out.push({ label: t("approval.status"), value: badge });
    return out;
  }, [sysData, memberMap, t, badge]);

  const handleApprove = () => {
    if (!linkedPending || !self) return;
    setBusyId(linkedPending.id);
    void approve({
      approvalId: linkedPending.id,
      actorMemberId: self.memberId,
      wsToken: self.wsToken,
    }).finally(() => setBusyId(null));
  };

  const handleReject = () => {
    if (!linkedPending || !self) return;
    setBusyId(linkedPending.id);
    void reject({
      approvalId: linkedPending.id,
      actorMemberId: self.memberId,
      wsToken: self.wsToken,
    }).finally(() => setBusyId(null));
  };

  const handleGrantChange = (value: ApprovalGrantDuration) => {
    if (linkedPending) setGrantDuration(linkedPending.id, value);
  };

  const borderColor = status === "success" ? "#34D399" : status === "error" ? "#F87171" : "#FBBF24";
  const badgeBg = status === "success" ? "#34D39920" : status === "error" ? "#F8717120" : "#FBBF2420";
  const badgeColor = status === "success" ? "#34D399" : status === "error" ? "#F87171" : "#FBBF24";

  return (
    <div style={{ background: "var(--bg-surface, #1E293B)", borderRadius: 8, padding: 14, borderLeft: `3px solid ${borderColor}` }}>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 500, padding: "1px 8px", borderRadius: 6, background: badgeBg, color: badgeColor }}>
          {badge}
        </span>
        {grant && (
          <span style={{ fontSize: 11, color: "var(--font-tertiary, #64748B)" }}>{grant}</span>
        )}
      </div>

      {/* Title + detail */}
      {sysData.title && (
        <strong style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--font-secondary, #94A3B8)", marginBottom: 4 }}>
          {sysData.title}
        </strong>
      )}
      {sysData.detail && (
        <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--font-secondary, #94A3B8)", lineHeight: 1.4 }}>
          {sysData.detail}
        </p>
      )}

      {/* Summary grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 16px", marginBottom: 10 }}>
        {items.map((item) => (
          <div key={item.label} style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <span style={{ fontSize: 10, color: "var(--font-muted, #475569)" }}>{item.label}</span>
            <strong style={{ fontSize: 12, color: "var(--font-secondary, #94A3B8)" }}>{item.value}</strong>
          </div>
        ))}
      </div>

      {/* Links / controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {replyToMessageId && (
          <button
            type="button"
            className="chat-action-button"
            onClick={() => onFocusMessage(replyToMessageId)}
          >
            {t("chat.viewOriginal")}
          </button>
        )}
        {linkedPending && canResolve && (
          <>
            <Select
              size="small"
              value={selectedGrant}
              onChange={handleGrantChange}
              disabled={busyId === linkedPending.id}
              style={{ width: 110 }}
              options={GRANT_OPTIONS.map((o) => ({ value: o.value, label: t(o.label) }))}
            />
            <Button
              size="small"
              type="primary"
              loading={busyId === linkedPending.id}
              onClick={handleApprove}
            >
              {t("approval.approve")}
            </Button>
            <Button
              size="small"
              danger
              loading={busyId === linkedPending.id}
              onClick={handleReject}
            >
              {t("approval.reject")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
