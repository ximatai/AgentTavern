export function maskLoginKey(loginKey: string): string {
  const trimmed = loginKey.trim();
  if (!trimmed) {
    return "";
  }

  const atIndex = trimmed.indexOf("@");
  if (atIndex > 0 && atIndex < trimmed.length - 1) {
    const localPart = trimmed.slice(0, atIndex);
    const domainPart = trimmed.slice(atIndex + 1);
    const maskedLocal = maskSegment(localPart, 2);
    const maskedDomain = maskDomain(domainPart);
    return `${maskedLocal}@${maskedDomain}`;
  }

  return maskSegment(trimmed, 3);
}

function maskDomain(domain: string): string {
  const segments = domain.split(".");
  if (segments.length === 0) {
    return maskSegment(domain, 2);
  }

  const [host, ...rest] = segments;
  const maskedHost = maskSegment(host, 2);
  return [maskedHost, ...rest].join(".");
}

function maskSegment(value: string, visibleChars: number): string {
  if (value.length <= visibleChars) {
    return value;
  }

  if (value.length <= visibleChars + 2) {
    return `${value.slice(0, 1)}***${value.slice(-1)}`;
  }

  return `${value.slice(0, visibleChars)}***${value.slice(-1)}`;
}
