export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function createInviteToken(): string {
  return crypto.randomUUID().replace(/-/g, "");
}
