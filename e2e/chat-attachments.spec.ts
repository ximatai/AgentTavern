import { expect, test, type Page } from "@playwright/test";

async function createRoom(page: Page, roomName: string, nickname: string) {
  await page.goto("/");
  await page.getByLabel("Room name").fill(roomName);
  await page.getByLabel("Nickname").fill(nickname);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByText(`Room member: ${nickname}`)).toBeVisible();
}

test.describe("chat attachments", () => {
  test("uploads, removes, sends, and rehydrates multi-attachments across members", async ({
    browser,
    page,
  }) => {
    await createRoom(page, "Attachment E2E Room", "Alice");
    await expect(page.getByText(/Invite token:/)).toBeVisible();

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles([
      {
        name: "diagram.png",
        mimeType: "image/png",
        buffer: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9l9o8AAAAASUVORK5CYII=",
          "base64",
        ),
      },
      {
        name: "notes.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("attachment regression notes", "utf8"),
      },
    ]);

    await expect(page.getByText("diagram.png")).toBeVisible();
    await expect(page.getByText("notes.txt")).toBeVisible();

    await page
      .locator(".pending-attachment-chip", { hasText: "notes.txt" })
      .getByRole("button", { name: "Remove" })
      .click();
    await expect(page.locator(".pending-attachment-chip", { hasText: "notes.txt" })).toHaveCount(0);

    await fileInput.setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("attachment regression notes", "utf8"),
    });

    const composer = page.getByPlaceholder("Type a message, for example: @BackendDev 帮我看一下");
    await composer.fill("Attachment regression message");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.locator(".pending-attachment-chip")).toHaveCount(0);
    await expect(page.locator(".chat-row").filter({ hasText: "Attachment regression message" })).toBeVisible();
    await expect(page.locator(".message-attachment", { hasText: "diagram.png" })).toBeVisible();
    await expect(page.locator(".message-attachment", { hasText: "notes.txt" })).toBeVisible();
    const imagePreview = page.locator('img[alt="diagram.png"]');
    await expect(imagePreview).toBeVisible();
    const imageUrl = await imagePreview.getAttribute("src");
    expect(imageUrl).toBeTruthy();
    const imageResponse = await page.request.get(imageUrl!);
    expect(imageResponse.ok()).toBeTruthy();
    expect(imageResponse.headers()["content-type"]).toContain("image/png");

    const inviteFacts = page.locator(".session-facts");
    const inviteText = await inviteFacts.textContent();
    const inviteToken = inviteText?.match(/Invite token:\s*(\S+)/)?.[1];
    expect(inviteToken).toBeTruthy();

    const bobContext = await browser.newContext();
    const bobPage = await bobContext.newPage();
    await bobPage.goto("/");
    await bobPage.getByLabel("Nickname").fill("Bob");
    await bobPage.getByLabel("Invite token or URL").fill(inviteToken!);
    await bobPage.getByRole("button", { name: "Join" }).click();

    await expect(bobPage.getByText("Room member: Bob")).toBeVisible();
    await expect(
      bobPage.locator(".chat-row").filter({ hasText: "Attachment regression message" }),
    ).toBeVisible();
    const bobImageAttachment = bobPage.locator(".message-attachment", { hasText: "diagram.png" });
    const bobFileAttachment = bobPage.locator(".message-attachment", { hasText: "notes.txt" });
    await expect(bobImageAttachment).toBeVisible();
    await expect(bobFileAttachment).toBeVisible();

    const downloadPromise = bobPage.waitForEvent("download");
    await bobFileAttachment.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("notes.txt");

    await bobContext.close();
  });

  test("shows a validation error for oversized attachments before upload", async ({ page }) => {
    await createRoom(page, "Attachment Limit Room", "Alice");

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: "too-large.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 1),
    });

    await expect(page.getByText(/too-large\.bin exceeds 5\.0 MB per file/i)).toBeVisible();
    await expect(page.locator(".pending-attachment-chip")).toHaveCount(0);
  });

  test("keeps only the first eight attachments and tells the user", async ({ page }) => {
    await createRoom(page, "Attachment Count Room", "Alice");

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(
      Array.from({ length: 9 }, (_, index) => ({
        name: `note-${index + 1}.txt`,
        mimeType: "text/plain",
        buffer: Buffer.from(`note-${index + 1}`, "utf8"),
      })),
    );

    await expect(page.getByText(/Only the first 8 attachments were added/i)).toBeVisible();
    await expect(page.locator(".pending-attachment-chip")).toHaveCount(8);
    await expect(page.locator(".pending-attachment-chip", { hasText: "note-8.txt" })).toHaveCount(1);
    await expect(page.locator(".pending-attachment-chip", { hasText: "note-9.txt" })).toHaveCount(0);
  });
});
