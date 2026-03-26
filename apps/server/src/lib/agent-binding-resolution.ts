import { eq } from "drizzle-orm";

import type { AgentBinding, Member } from "@agent-tavern/shared";

import { db } from "../db/client";
import { agentBindings, members } from "../db/schema";

export function resolveBindingForMember(member: Pick<Member, "id" | "sourcePrivateAssistantId">): AgentBinding | null {
  const direct = db
    .select()
    .from(agentBindings)
    .where(eq(agentBindings.memberId, member.id))
    .get();

  if (direct) {
    return direct as AgentBinding;
  }

  if (!member.sourcePrivateAssistantId) {
    return null;
  }

  const siblingProjection = db
    .select()
    .from(members)
    .where(eq(members.sourcePrivateAssistantId, member.sourcePrivateAssistantId))
    .all()
    .find((item) => item.id !== member.id);

  if (!siblingProjection) {
    return null;
  }

  const siblingBinding = db
    .select()
    .from(agentBindings)
    .where(eq(agentBindings.memberId, siblingProjection.id))
    .get();

  return (siblingBinding as AgentBinding | undefined) ?? null;
}
