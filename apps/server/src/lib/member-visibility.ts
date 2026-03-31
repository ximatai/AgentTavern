export function isActiveRoomMember(member: { membershipStatus?: string | null }): boolean {
  return (member.membershipStatus ?? "active") === "active";
}

export function isVisibleRoomMember(member: {
  membershipStatus?: string | null;
  sourcePrivateAssistantId?: string | null;
  presenceStatus?: string | null;
  assistantStatus?: string | null;
}): boolean {
  return (
    isActiveRoomMember(member) &&
    !(
      member.sourcePrivateAssistantId &&
      member.presenceStatus === "offline" &&
      member.assistantStatus !== "paused"
    )
  );
}
