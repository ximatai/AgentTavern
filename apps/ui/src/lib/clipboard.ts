export async function copyText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  if (typeof document === "undefined") {
    throw new Error("Clipboard is unavailable");
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  let copied = false;

  const handleCopy = (event: ClipboardEvent) => {
    event.preventDefault();
    event.clipboardData?.setData("text/plain", text);
    copied = true;
  };

  document.addEventListener("copy", handleCopy);
  try {
    const execCopied = document.execCommand("copy");
    if (!execCopied && !copied) {
      throw new Error("Clipboard copy failed");
    }
  } finally {
    document.removeEventListener("copy", handleCopy);
    document.body.removeChild(textarea);
  }

  if (!copied) {
    throw new Error("Clipboard copy failed");
  }
}
