import { expect, test, type Page } from "@playwright/test";

async function createRoom(page: Page, roomName: string, nickname: string) {
  await page.goto("/");
  await page.getByLabel("新房间名称").fill(roomName);
  await page.getByLabel("你的昵称").fill(nickname);
  await page.getByRole("button", { name: "新建并进入", exact: true }).click();
  await expect(page.getByText(new RegExp(`${nickname}（你）`))).toBeVisible();
}

test.describe("chat attachments", () => {
  test("uploads, removes, sends, and rehydrates multi-attachments across members", async ({
    browser,
    page,
  }) => {
    await createRoom(page, "Attachment E2E Room", "Alice");
    await expect(page.getByRole("heading", { name: "Attachment E2E Room" })).toBeVisible();

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
      .getByRole("button", { name: "移除" })
      .click();
    await expect(page.locator(".pending-attachment-chip", { hasText: "notes.txt" })).toHaveCount(0);

    await fileInput.setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("attachment regression notes", "utf8"),
    });

    const composer = page.getByPlaceholder("输入消息，使用 @成员名 触发协作...");
    await composer.fill("Attachment regression message");
    await page.getByRole("button", { name: "发送" }).click();

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

    const inviteToken = await page.locator(".room-current-meta span").nth(1).innerText();
    expect(inviteToken).toBeTruthy();

    const bobContext = await browser.newContext();
    const bobPage = await bobContext.newPage();
    await bobPage.goto("/");
    await bobPage.getByLabel("你的昵称").fill("Bob");
    await bobPage
      .getByLabel("邀请链接或邀请码")
      .fill(new URL(`/join/${inviteToken!}`, page.url()).toString());
    await bobPage.getByRole("button", { name: "通过邀请进入" }).click();

    await expect(
      bobPage.locator(".chat-row").filter({ hasText: "Attachment regression message" }),
    ).toBeVisible({ timeout: 20000 });
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

    await expect(page.locator(".error-inline")).toContainText("too-large.bin 超过单文件 5.0 MB");
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

    await expect(page.getByText(/只添加了前 8 个附件/)).toBeVisible();
    await expect(page.locator(".pending-attachment-chip")).toHaveCount(8);
    await expect(page.locator(".pending-attachment-chip", { hasText: "note-8.txt" })).toHaveCount(1);
    await expect(page.locator(".pending-attachment-chip", { hasText: "note-9.txt" })).toHaveCount(0);
  });

  test("creates and renders a quoted reply", async ({ page }) => {
    await createRoom(page, "Reply Flow Room", "Alice");

    const composer = page.getByPlaceholder("输入消息，使用 @成员名 触发协作...");
    await composer.fill("Base message for reply");
    await page.getByRole("button", { name: "发送" }).click();

    const baseMessage = page.locator(".chat-row").filter({ hasText: "Base message for reply" }).last();
    await expect(baseMessage).toBeVisible();

    await baseMessage.getByRole("button", { name: "回复" }).click();
    await expect(page.locator(".reply-banner")).toContainText("正在回复 Alice");
    await expect(page.locator(".reply-banner")).toContainText("Base message for reply");

    await composer.fill("Quoted follow-up");
    await page.getByRole("button", { name: "发送" }).click();

    await expect(page.locator(".reply-banner")).toHaveCount(0);

    const replyMessage = page.locator(".chat-row").filter({ hasText: "Quoted follow-up" }).last();
    await expect(replyMessage).toBeVisible();
    await expect(replyMessage.locator(".reply-preview")).toContainText("回复给 Alice");
    await expect(replyMessage.locator(".reply-preview")).toContainText("Base message for reply");
  });
});
