import { eq } from "drizzle-orm";

import type { AgentBinding, Member } from "@agent-tavern/shared";

import { db } from "../db/client";
import { agentBindings, members } from "../db/schema";

export function resolveBindingForMember(
  member: Pick<Member, "id" | "principalId" | "sourcePrivateAssistantId">,
): AgentBinding | null {
  const direct = db
    .select()
    .from(agentBindings)
    .where(eq(agentBindings.memberId, member.id))
    .get();

  if (direct) {
    return direct as AgentBinding;
  }

  if (member.sourcePrivateAssistantId) {
    const siblingProjection = db
      .select()
      .from(members)
      .where(eq(members.sourcePrivateAssistantId, member.sourcePrivateAssistantId))
      .all()
      .filter((item) => item.id !== member.id);

    for (const sibling of siblingProjection) {
      const siblingBinding = db
        .select()
        .from(agentBindings)
        .where(eq(agentBindings.memberId, sibling.id))
        .get();

      if (siblingBinding) {
        return siblingBinding as AgentBinding;
      }
    }
  }

  if (!member.principalId) {
    return null;
  }

  const siblingPrincipals = db
    .select()
    .from(members)
    .where(eq(members.principalId, member.principalId))
    .all()
    .filter((item) => item.id !== member.id && item.type === "agent");

  for (const sibling of siblingPrincipals) {
    const siblingBinding = db
      .select()
      .from(agentBindings)
      .where(eq(agentBindings.memberId, sibling.id))
      .get();

    if (siblingBinding) {
      return siblingBinding as AgentBinding;
    }
  }

  return null;
}
