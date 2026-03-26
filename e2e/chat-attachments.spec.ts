import { expect, test, type Page } from "@playwright/test";

async function createRoom(page: Page, roomName: string, nickname: string) {
  await page.goto("/");
  await page.getByLabel("新房间名称").fill(roomName);
  await page.getByLabel("你的昵称").fill(nickname);
  await page.getByRole("button", { name: "新建并进入", exact: true }).click();
  await expect(page.getByText(new RegExp(`${nickname}（你）`))).toBeVisible();
}

async function addAssistant(page: Page, assistantName: string) {
  const agentPanel = page.locator("details.subpanel").filter({ hasText: "添加本地 Agent" });
  if (!(await agentPanel.evaluate((node) => node.hasAttribute("open")))) {
    await agentPanel.locator("summary").click();
  }
  await agentPanel.getByLabel("显示名").fill(assistantName);
  await agentPanel.getByLabel("类型").selectOption("assistant");
  await page.getByRole("button", { name: "添加本地 Agent", exact: true }).click();
  await expect(page.locator(".assistant-tree").getByText(assistantName)).toBeVisible();
}

async function addIndependentAgent(
  page: Page,
  options: {
    name: string;
    command?: string;
    argsText?: string;
  },
) {
  const agentPanel = page.locator("details.subpanel").filter({ hasText: "添加本地 Agent" });
  if (!(await agentPanel.evaluate((node) => node.hasAttribute("open")))) {
    await agentPanel.locator("summary").click();
  }
  await agentPanel.getByLabel("显示名").fill(options.name);
  await agentPanel.getByLabel("类型").selectOption("independent");
  if (options.command !== undefined) {
    await agentPanel.getByLabel("命令").fill(options.command);
  }
  if (options.argsText !== undefined) {
    await agentPanel.getByLabel("参数（每行一个）").fill(options.argsText);
  }
  await page.getByRole("button", { name: "添加本地 Agent", exact: true }).click();
  await expect(page.locator(".member-section").filter({ hasText: "独立 Agent" }).getByText(options.name)).toBeVisible();
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

  test("closes the approval loop from sidebar navigation to chat decision", async ({
    browser,
    page,
  }) => {
    await createRoom(page, "Approval Flow Room", "Alice");
    await addAssistant(page, "架构助理");

    const inviteToken = await page.locator(".room-current-meta span").nth(1).innerText();
    const bobContext = await browser.newContext();
    const bobPage = await bobContext.newPage();
    await bobPage.goto("/");
    await bobPage.getByLabel("你的昵称").fill("Bob");
    await bobPage
      .getByLabel("邀请链接或邀请码")
      .fill(new URL(`/join/${inviteToken}`, page.url()).toString());
    await bobPage.getByRole("button", { name: "通过邀请进入" }).click();

    const bobComposer = bobPage.getByPlaceholder("输入消息，使用 @成员名 触发协作...");
    await bobComposer.fill("@架构助理 帮我看一下预算方案");
    await bobPage.getByRole("button", { name: "发送" }).click();

    await expect(page.getByText("你当前有 1 条审批待处理。")).toBeVisible();
    const pendingCard = page.locator(".approval-card").filter({ hasText: "Bob 正在请求调用" });
    await expect(pendingCard).toBeVisible();

    await pendingCard.getByRole("button", { name: "查看审批消息" }).click();
    await expect(page.locator(".flash-badge")).toContainText("已定位到审批消息");

    const requestMessage = page
      .locator(".chat-row")
      .filter({ hasText: "Owner approval required" })
      .filter({ hasText: "架构助理 is waiting for owner approval." })
      .last();
    await expect(requestMessage).toBeVisible();

    await requestMessage.getByRole("button", { name: "查看原消息" }).click();
    await expect(page.locator(".flash-badge")).toContainText("已定位到触发消息");

    const triggerMessage = page
      .locator(".chat-row")
      .filter({ hasText: "@架构助理 帮我看一下预算方案" })
      .last();
    await expect(triggerMessage).toBeVisible();

    await pendingCard.getByRole("combobox").selectOption("10_minutes");
    await requestMessage.getByRole("button", { name: "批准" }).click();

    await expect(page.getByText("当前没有待处理审批。")).toBeVisible();
    const approvalResult = page
      .locator(".chat-row")
      .filter({ hasText: "Approval granted" })
      .filter({ hasText: "10 分钟" })
      .last();
    await expect(approvalResult).toBeVisible();

    await bobContext.close();
  });

  test("shows running and recent failure summaries for agent collaboration", async ({ page }) => {
    await createRoom(page, "Collab State Room", "Alice");
    await addIndependentAgent(page, { name: "执行助手" });
    await addIndependentAgent(page, {
      name: "故障助手",
      command: "definitely-not-a-real-command",
      argsText: "",
    });

    const composer = page.getByPlaceholder("输入消息，使用 @成员名 触发协作...");
    await composer.fill("@执行助手 帮我整理一下会议纪要");
    await page.getByRole("button", { name: "发送" }).click();

    const runningCard = page.locator(".collab-state-card").filter({ hasText: "执行助手 正在处理请求" });
    await expect(runningCard).toContainText("运行中");
    await expect(runningCard).toContainText("查看触发消息");

    await composer.fill("@故障助手 试着执行一下");
    await page.getByRole("button", { name: "发送" }).click();

    const issueCard = page.locator(".collab-state-card").filter({ hasText: "Agent run failed" });
    await expect(issueCard).toContainText("最近异常");
    await expect(issueCard).toContainText("查看消息");
  });
});
