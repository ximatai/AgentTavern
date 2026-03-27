import type { ApprovalGrantDuration, PublicApproval } from "@agent-tavern/shared";

import { request } from "./client";

async function resolveApproval(
  approvalId: string,
  action: "approve" | "reject",
  params: {
    actorMemberId: string;
    wsToken: string;
    grantDuration?: ApprovalGrantDuration;
  },
): Promise<PublicApproval> {
  return request<PublicApproval>(`/api/approvals/${approvalId}/${action}`, {
    method: "POST",
    body: JSON.stringify({
      actorMemberId: params.actorMemberId,
      wsToken: params.wsToken,
      grantDuration: action === "approve" ? params.grantDuration : undefined,
    }),
  });
}

async function deleteAttachment(attachmentId: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/attachments/${attachmentId}`, {
    method: "DELETE",
  });
}

export { resolveApproval, deleteAttachment };
