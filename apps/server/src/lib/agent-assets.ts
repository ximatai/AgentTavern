import { and, eq } from "drizzle-orm";

import type { Member, PrivateAssistant } from "@agent-tavern/shared";

import { db } from "../db/client";
import { agentBindings, citizens, members, privateAssistantInvites, privateAssistants } from "../db/schema";

export function removeCitizenAsset(citizenId: string, timestamp: string): Member[] {
  const roomMemberships = db
    .select()
    .from(members)
    .where(eq(members.citizenId, citizenId))
    .all() as Member[];

  db.transaction((tx) => {
    tx
      .update(members)
      .set({
        citizenId: null,
        presenceStatus: "offline",
        membershipStatus: "left",
        leftAt: timestamp,
      })
      .where(eq(members.citizenId, citizenId))
      .run();
    tx.delete(agentBindings).where(eq(agentBindings.citizenId, citizenId)).run();
    tx.delete(citizens).where(eq(citizens.id, citizenId)).run();
  });

  return roomMemberships;
}

export function removePrivateAssistantAsset(
  assistantId: string,
): { assistant: PrivateAssistant | null; projections: Member[] } {
  const assistant = db
    .select()
    .from(privateAssistants)
    .where(eq(privateAssistants.id, assistantId))
    .get() as PrivateAssistant | undefined;

  if (!assistant) {
    return { assistant: null, projections: [] };
  }

  const projections = db
    .select()
    .from(members)
    .where(eq(members.sourcePrivateAssistantId, assistantId))
    .all() as Member[];

  db.transaction((tx) => {
    tx
      .update(members)
      .set({ presenceStatus: "offline" })
      .where(eq(members.sourcePrivateAssistantId, assistantId))
      .run();
    tx
      .update(privateAssistantInvites)
      .set({ status: "revoked", acceptedPrivateAssistantId: null })
      .where(
        and(
          eq(privateAssistantInvites.ownerCitizenId, assistant.ownerCitizenId),
          eq(privateAssistantInvites.acceptedPrivateAssistantId, assistantId),
        ),
      )
      .run();
    tx.delete(agentBindings).where(eq(agentBindings.privateAssistantId, assistantId)).run();
    tx.delete(privateAssistants).where(eq(privateAssistants.id, assistantId)).run();
  });

  return { assistant, projections };
}

export function listPrivateAssistantIdsByServerConfig(configId: string): string[] {
  return db
    .select({ id: privateAssistants.id })
    .from(privateAssistants)
    .where(eq(privateAssistants.sourceServerConfigId, configId))
    .all()
    .map((item) => item.id);
}

export function listCitizenIdsByServerConfig(configId: string): string[] {
  return db
    .select({ id: citizens.id })
    .from(citizens)
    .where(eq(citizens.sourceServerConfigId, configId))
    .all()
    .map((item) => item.id);
}

export function deleteAgentAssetsForServerConfig(configId: string, timestamp: string): {
  removedCitizenIds: string[];
  removedPrivateAssistantIds: string[];
  citizenMemberships: Member[];
  assistantProjections: Member[];
} {
  const citizenIds = listCitizenIdsByServerConfig(configId);
  const assistantIds = listPrivateAssistantIdsByServerConfig(configId);
  const citizenMemberships: Member[] = [];
  const assistantProjections: Member[] = [];

  for (const citizenId of citizenIds) {
    citizenMemberships.push(...removeCitizenAsset(citizenId, timestamp));
  }

  for (const assistantId of assistantIds) {
    assistantProjections.push(...removePrivateAssistantAsset(assistantId).projections);
  }

  return {
    removedCitizenIds: citizenIds,
    removedPrivateAssistantIds: assistantIds,
    citizenMemberships,
    assistantProjections,
  };
}
