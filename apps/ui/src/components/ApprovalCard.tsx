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
    <div
      className="approval-card"
      style={{ borderLeftColor: borderColor }}
    >
      <div className="approval-card-header">
        <span
          className="approval-card-badge"
          style={{ background: badgeBg, color: badgeColor }}
        >
          {badge}
        </span>
        {grant && (
          <span className="approval-card-grant">{grant}</span>
        )}
      </div>

      {sysData.title && (
        <strong className="approval-card-title">
          {sysData.title}
        </strong>
      )}
      {sysData.detail && (
        <p className="approval-card-detail">
          {sysData.detail}
        </p>
      )}

      <div className="approval-card-grid">
        {items.map((item) => (
          <div key={item.label} className="approval-card-item">
            <span className="approval-card-item-label">{item.label}</span>
            <strong className="approval-card-item-value">{item.value}</strong>
          </div>
        ))}
      </div>

      <div className="approval-card-actions">
        {replyToMessageId && (
          <div className="approval-card-links">
            <button
              type="button"
              className="chat-action-button"
              onClick={() => onFocusMessage(replyToMessageId)}
            >
              {t("chat.viewOriginal")}
            </button>
          </div>
        )}
        {linkedPending && canResolve && (
          <div className="approval-card-controls">
            <div className="approval-card-select-wrap">
              <span className="approval-card-select-label">{t("approval.grantLabel")}</span>
              <Select
                size="small"
                value={selectedGrant}
                onChange={handleGrantChange}
                disabled={busyId === linkedPending.id}
                className="approval-card-select"
                placement="topLeft"
                popupMatchSelectWidth={false}
                getPopupContainer={(trigger) => trigger.parentElement ?? document.body}
                options={GRANT_OPTIONS.map((o) => ({ value: o.value, label: t(o.label) }))}
              />
            </div>
            <div className="approval-card-buttons">
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
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
