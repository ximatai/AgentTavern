import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const E2E_SERVER_ORIGIN = "http://127.0.0.1:18787";

async function loginAsHuman(page: Page, email: string, displayName: string) {
  await page.goto("/");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("用于恢复身份").fill(email);
  await dialog.getByPlaceholder("输入显示名称").fill(displayName);
  await dialog.getByRole("button", { name: "登 录" }).click();
  await expect(dialog).toBeHidden();

  await expect(page.locator(".identity-name")).toHaveText(displayName);
  await expect(page.getByText(`${displayName} (你)`, { exact: true })).toBeVisible();
}

function roomItem(page: Page, roomName: string) {
  return page.locator(".room-item").filter({
    has: page.locator(".room-item-name", { hasText: roomName }),
  });
}

async function openOnlineMembers(page: Page) {
  await page.getByRole("button", { name: /在线成员/ }).click();
  const tooltip = page.getByRole("tooltip").filter({
    has: page.getByText("在线用户", { exact: true }),
  });
  await expect(tooltip).toBeVisible();
  return tooltip;
}

async function createRoom(page: Page, roomName: string) {
  await page.getByRole("button", { name: /创建房间/ }).click();
  const dialog = page.getByRole("dialog", { name: "新建或进入聊天室" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("输入房间名称").fill(roomName);
  await dialog.getByRole("button", { name: "新建并进入" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".header-room-name")).toHaveText(roomName);
}

async function acceptRoomAssistantInvite(
  request: APIRequestContext,
  inviteUrl: string,
  backendThreadId: string,
) {
  const inviteToken = inviteUrl.split("/").at(-1);
  if (!inviteToken) {
    throw new Error(`invalid invite url: ${inviteUrl}`);
  }

  const acceptResponse = await request.post(
    `${E2E_SERVER_ORIGIN}/api/assistant-invites/${inviteToken}/accept`,
    {
      data: {
        backendThreadId,
        cwd: "/tmp/agent-tavern-e2e-assistant",
      },
    },
  );
  expect(acceptResponse.ok()).toBeTruthy();
  return acceptResponse.json();
}

async function registerBridge(request: APIRequestContext) {
  const bridgeInstanceId = `binst_e2e_${Date.now()}`;
  const response = await request.post(`${E2E_SERVER_ORIGIN}/api/bridges/register`, {
    data: {
      bridgeName: "Playwright E2E Bridge",
      bridgeInstanceId,
    },
  });
  expect(response.ok()).toBeTruthy();
  const payload = await response.json();
  return {
    bridgeId: payload.bridgeId as string,
    bridgeToken: payload.bridgeToken as string,
  };
}

async function attachAssistantToBridge(
  request: APIRequestContext,
  params: {
    bridgeId: string;
    bridgeToken: string;
    privateAssistantId: string;
    backendThreadId: string;
  },
) {
  const response = await request.post(
    `${E2E_SERVER_ORIGIN}/api/bridges/${params.bridgeId}/agents/attach`,
    {
      data: {
        bridgeToken: params.bridgeToken,
        privateAssistantId: params.privateAssistantId,
        backendThreadId: params.backendThreadId,
        cwd: "/tmp/agent-tavern-e2e-assistant",
      },
    },
  );
  expect(response.ok()).toBeTruthy();
}

test.describe("ui critical flows", () => {
  test("lobby header hides connection state when user has not entered a room", async ({ page }) => {
    await loginAsHuman(page, "alice@example.com", "Alice");

    await expect(page.getByText("未连接")).toHaveCount(0);
    await expect(page.getByText("已断开")).toHaveCount(0);
    await expect(page.getByText("已连接")).toHaveCount(0);
  });

  test("online members panel includes self and shows the correct count", async ({ browser, page }) => {
    const alicePage = page;
    await loginAsHuman(alicePage, "alice@example.com", "Alice");

    const bobContext = await browser.newContext();
    const bobPage = await bobContext.newPage();
    await loginAsHuman(bobPage, "bob@example.com", "Bob");

    await expect(alicePage.getByRole("button", { name: /在线成员 2/ })).toBeVisible();
    await expect(alicePage.getByText("2 在线", { exact: true })).toBeVisible();

    const membersPopover = await openOnlineMembers(alicePage);
    await expect(membersPopover.getByText("2 在线", { exact: true })).toBeVisible();
    await expect(membersPopover.getByText("Alice (你)", { exact: true })).toBeVisible();
    await expect(membersPopover.getByRole("button", { name: "当前用户" })).toBeVisible();
    await expect(membersPopover.getByText("Bob", { exact: true })).toBeVisible();
    await expect(membersPopover.getByRole("button", { name: "开始聊天" })).toBeVisible();

    await bobContext.close();
  });

  test("lobby online count updates immediately when another principal comes online", async ({
    browser,
    page,
  }) => {
    const alicePage = page;
    await loginAsHuman(alicePage, "alice-immediate@example.com", "Alice Immediate");

    await expect(alicePage.getByRole("button", { name: /在线成员 1/ })).toBeVisible();

    const bobContext = await browser.newContext();
    const bobPage = await bobContext.newPage();
    await loginAsHuman(bobPage, "bob-immediate@example.com", "Bob Immediate");

    await expect(alicePage.getByRole("button", { name: /在线成员 2/ })).toBeVisible({
      timeout: 3_000,
    });

    const membersPopover = await openOnlineMembers(alicePage);
    await expect(membersPopover.getByText("2 在线", { exact: true })).toBeVisible();
    await expect(membersPopover.getByText("Bob Immediate", { exact: true })).toBeVisible();

    await bobContext.close();
  });

  test("creating a room enters the room and adds it to recent rooms", async ({ page }) => {
    await loginAsHuman(page, "alice@example.com", "Alice");

    const roomName = "Launch Room";
    await createRoom(page, roomName);
    await expect(roomItem(page, roomName)).toBeVisible();
    await expect(page.getByPlaceholder("输入消息，使用 @成员名 触发协作...")).toBeVisible();
    await expect(page.getByText("房间成员", { exact: true })).toBeVisible();
  });

  test("room assistant invite becomes ready after bridge attach", async ({ page, request }) => {
    await loginAsHuman(page, "owner@example.com", "Owner");
    await createRoom(page, "Assistant Bridge Room");

    await page.getByRole("button", { name: "助理" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("邀请助理加入当前聊天室", { exact: true })).toBeVisible();

    await dialog.getByPlaceholder("助理在房间中的显示名称").fill("架构助理");
    await dialog.getByRole("button", { name: "生成房间邀请" }).click();

    const inviteUrlLocator = dialog
      .locator(".am-invite-tip")
      .filter({ hasText: "/assistant-invites/" });
    await expect(inviteUrlLocator).toBeVisible();

    const inviteUrl = await inviteUrlLocator.textContent();
    if (!inviteUrl) {
      throw new Error("room assistant invite url not found");
    }

    const backendThreadId = `thread_e2e_room_assistant_${Date.now()}`;
    const accepted = await acceptRoomAssistantInvite(request, inviteUrl.trim(), backendThreadId);

    await expect(page.getByText("架构助理", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("待绑定", { exact: true })).toBeVisible({ timeout: 10_000 });

    const bridge = await registerBridge(request);
    await attachAssistantToBridge(request, {
      bridgeId: bridge.bridgeId,
      bridgeToken: bridge.bridgeToken,
      privateAssistantId: accepted.privateAssistantId as string,
      backendThreadId,
    });

    await expect(page.getByText("已连接", { exact: true })).toBeVisible({ timeout: 10_000 });
  });

  test("online members can start a direct chat and the peer sees the room entry via realtime event", async ({
    browser,
    page,
  }) => {
    const alicePage = page;
    await loginAsHuman(alicePage, "alice@example.com", "Alice");

    const bobContext = await browser.newContext();
    const bobPage = await bobContext.newPage();
    await loginAsHuman(bobPage, "bob@example.com", "Bob");

    const membersPopover = await openOnlineMembers(alicePage);
    await expect(alicePage.getByRole("button", { name: "当前用户" })).toHaveCount(1);
    await expect(membersPopover.getByText("Alice (你)", { exact: true })).toBeVisible();
    await expect(membersPopover.getByText("Bob", { exact: true })).toBeVisible();

    await membersPopover.getByRole("button", { name: "开始聊天" }).click();

    const roomName = "Alice · Bob";
    await expect(roomItem(alicePage, roomName)).toBeVisible();
    await expect(roomItem(bobPage, roomName)).toBeVisible({
      timeout: 10_000,
    });

    const composer = alicePage.getByPlaceholder("输入消息，使用 @成员名 触发协作...");
    await composer.fill("Hello Bob");
    await composer.press("Enter");

    await roomItem(bobPage, roomName).click();
    await expect(bobPage.getByText("Hello Bob")).toBeVisible({ timeout: 10_000 });

    await bobContext.close();
  });
});
