import { eq } from "drizzle-orm";

import type { AgentBinding, Member } from "@agent-tavern/shared";

import { db } from "../db/client";
import { agentBindings } from "../db/schema";

export function resolveBindingForPrincipal(principalId: string | null): AgentBinding | null {
  if (!principalId) {
    return null;
  }

  const binding = db
    .select()
    .from(agentBindings)
    .where(eq(agentBindings.principalId, principalId))
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
  member: Pick<Member, "id" | "principalId" | "sourcePrivateAssistantId">,
): AgentBinding | null {
  if (member.sourcePrivateAssistantId) {
    return resolveBindingForPrivateAssistant(member.sourcePrivateAssistantId);
  }

  return resolveBindingForPrincipal(member.principalId);
}
