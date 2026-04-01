import { eq } from "drizzle-orm";

import type { AgentBinding, Member } from "@agent-tavern/shared";

import { db } from "../db/client";
import { agentBindings } from "../db/schema";

export function resolveBindingForCitizen(citizenId: string | null): AgentBinding | null {
  if (!citizenId) {
    return null;
  }

  const binding = db
    .select()
    .from(agentBindings)
    .where(eq(agentBindings.citizenId, citizenId))
    .get();

  return binding as AgentBinding | null;
}

export function resolveBindingForPrivateAssistant(
  privateAssistantId: string | null,
): AgentBinding | null {
  if (!privateAssistantId) {
    return null;
  }

  const binding = db
    .select()
    .from(agentBindings)
    .where(eq(agentBindings.privateAssistantId, privateAssistantId))
    .get();

  return binding as AgentBinding | null;
}

export function resolveBindingForMember(
  member: Pick<Member, "id" | "citizenId" | "sourcePrivateAssistantId">,
): AgentBinding | null {
  if (member.sourcePrivateAssistantId) {
    return resolveBindingForPrivateAssistant(member.sourcePrivateAssistantId);
  }

  return resolveBindingForCitizen(member.citizenId);
}
