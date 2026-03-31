import type { Member } from "@agent-tavern/shared";

export function isActiveRoomMember(member: Pick<Member, "membershipStatus">): boolean {
  return (member.membershipStatus ?? "active") === "active";
}

export function isVisibleRoomMember(member: Pick<Member, "membershipStatus" | "sourcePrivateAssistantId" | "presenceStatus">): boolean {
  return isActiveRoomMember(member) && !(member.sourcePrivateAssistantId && member.presenceStatus === "offline");
}
