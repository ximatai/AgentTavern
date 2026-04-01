import { useState, useEffect, useMemo, useCallback } from "react";
import { Modal, Input, Button, Typography, Tag, Select } from "antd";
import {
  ApiOutlined,
  RobotOutlined,
  CopyOutlined,
  PlusOutlined,
  DeleteOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";

import { toast } from "../lib/feedback";
import { copyText } from "../lib/clipboard";
import { usePrincipalStore } from "../stores/principal";
import {
  getPrivateAssistants,
  getAssistantInvites,
  createManagedAssistant,
  createAssistantInvite,
  removeAssistantInvite,
  removePrivateAssistant,
  pausePrivateAssistant,
  resumePrivateAssistant,
} from "../api/assistants";
import type {
  PrivateAssistantRecord,
  PrivateAssistantInviteRecord,
} from "../api/assistants";
import {
  getMyServerConfigs,
  getSharedServerConfigs,
  createServerConfig,
  updateServerConfig,
  removeServerConfig,
} from "../api/server-configs";
import type { ServerConfigRecord, SharedServerConfigRecord } from "../api/server-configs";
import type { AgentBackendType } from "@agent-tavern/shared";
import { createAgentCitizen } from "../api/principals";
import { useRoomStore } from "../stores/room";

import "../styles/assistant-management.css";

const { Text } = Typography;

function sortByCreatedAt<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function resolveInviteOrigin(): string {
  const { protocol, hostname, port, origin } = window.location;
  if (port === "5173" || port === "5174") {
    return `${protocol}//${hostname}:8787`;
  }
  return origin;
}

function backendPromptName(type: AgentBackendType): string {
  if (type === "claude_code") return "Claude Code";
  if (type === "codex_cli") return "Codex";
  if (type === "opencode") return "OpenCode";
  if (type === "openai_compatible") return "OpenAI Compatible";
  return type;
}

function sourceIcon(type: AgentBackendType) {
  return type === "openai_compatible" ? <ApiOutlined /> : <RobotOutlined />;
}

function buildInvitePrompt(
  invite: Pick<PrivateAssistantInviteRecord, "name" | "inviteUrl" | "backendType">,
): string {
  const path = invite.inviteUrl?.trim();
  const fullUrl = path
    ? new URL(path, resolveInviteOrigin()).toString()
    : "接入链接暂不可用，请重新生成";
  return `请使用 join-agent-tavern skill 接受这个 AgentTavern 私有助理邀请，并把当前 ${backendPromptName(invite.backendType)} 会话接入为我的私有助理“${invite.name}”：${fullUrl}`;
}

interface AssistantManagementModalProps {
  open: boolean;
  onClose: () => void;
}

export function AssistantManagementModal({ open, onClose }: AssistantManagementModalProps) {
  const { t } = useTranslation();
  const principal = usePrincipalStore((s) => s.principal);
  const refreshLobbyPresence = useRoomStore((s) => s.refreshLobbyPresence);

  const [assistants, setAssistants] = useState<PrivateAssistantRecord[]>([]);
  const [invites, setInvites] = useState<PrivateAssistantInviteRecord[]>([]);
  const [serverConfigs, setServerConfigs] = useState<ServerConfigRecord[]>([]);
  const [sharedServerConfigs, setSharedServerConfigs] = useState<SharedServerConfigRecord[]>([]);
  const [nameInput, setNameInput] = useState("");
  const [managedNameInput, setManagedNameInput] = useState("");
  const [managedServerConfigId, setManagedServerConfigId] = useState<string>("");
  const [serverConfigNameInput, setServerConfigNameInput] = useState("");
  const [serverConfigBaseUrl, setServerConfigBaseUrl] = useState("");
  const [serverConfigModel, setServerConfigModel] = useState("");
  const [serverConfigApiKey, setServerConfigApiKey] = useState("");
  const [serverConfigVisibility, setServerConfigVisibility] = useState<"private" | "shared">("private");
  const [agentCitizenLoginKey, setAgentCitizenLoginKey] = useState("");
  const [agentCitizenDisplayName, setAgentCitizenDisplayName] = useState("");
  const [agentCitizenServerConfigId, setAgentCitizenServerConfigId] = useState<string>("");
  const [creatingManaged, setCreatingManaged] = useState(false);
  const [creatingServerConfig, setCreatingServerConfig] = useState(false);
  const [creatingAgentCitizen, setCreatingAgentCitizen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removingInviteId, setRemovingInviteId] = useState<string | null>(null);
  const [removingServerConfigId, setRemovingServerConfigId] = useState<string | null>(null);
  const [updatingServerConfigId, setUpdatingServerConfigId] = useState<string | null>(null);
  const [togglingAssistantId, setTogglingAssistantId] = useState<string | null>(null);
  const [inviteBackendType, setInviteBackendType] = useState<AgentBackendType>("claude_code");

  const refreshData = useCallback(async () => {
    if (!principal) {
      setAssistants([]);
      setInvites([]);
      setServerConfigs([]);
      setSharedServerConfigs([]);
      return;
    }
    try {
      const [items, inviteItems, ownServerConfigs, sharedConfigs] = await Promise.all([
        getPrivateAssistants(principal.principalId, principal.principalToken),
        getAssistantInvites(principal.principalId, principal.principalToken),
        getMyServerConfigs(principal.principalId, principal.principalToken),
        getSharedServerConfigs(principal.principalId, principal.principalToken),
      ]);
      setAssistants(sortByCreatedAt(items));
      setInvites(sortByCreatedAt(inviteItems));
      setServerConfigs(sortByCreatedAt(ownServerConfigs));
      setSharedServerConfigs(sortByCreatedAt(sharedConfigs));
    } catch {
      setAssistants([]);
      setInvites([]);
      setServerConfigs([]);
      setSharedServerConfigs([]);
    }
  }, [principal]);

  const privateAssetsVersion = usePrincipalStore((s) => s.privateAssetsVersion);

  useEffect(() => {
    if (open) {
      void refreshData();
    }
  }, [open, refreshData, privateAssetsVersion]);

  const pendingInvites = useMemo(
    () => invites.filter((invite) => invite.status === "pending"),
    [invites],
  );
  const availableServerConfigOptions = useMemo(() => {
    const ownOptions = serverConfigs.map((config) => ({
      value: config.id,
      label: `${config.name} · ${config.config.model}`,
    }));
    const sharedOptions = sharedServerConfigs.map((config) => ({
      value: config.id,
      label: `${config.name} · ${config.config.model} · ${t("assistantPanel.sharedSourceLabel")}`,
    }));
    return [...ownOptions, ...sharedOptions];
  }, [serverConfigs, sharedServerConfigs, t]);

  useEffect(() => {
    if (!availableServerConfigOptions.some((item) => item.value === managedServerConfigId)) {
      setManagedServerConfigId(availableServerConfigOptions[0]?.value ?? "");
    }
  }, [availableServerConfigOptions, managedServerConfigId]);

  useEffect(() => {
    if (!availableServerConfigOptions.some((item) => item.value === agentCitizenServerConfigId)) {
      setAgentCitizenServerConfigId(availableServerConfigOptions[0]?.value ?? "");
    }
  }, [availableServerConfigOptions, agentCitizenServerConfigId]);

  async function handleCreate() {
    const name = nameInput.trim();
    if (!name || !principal) return;
    setCreating(true);
    try {
      const created = await createAssistantInvite(
        principal.principalId,
        principal.principalToken,
        name,
        inviteBackendType,
      );
      setInvites((prev) => {
        const next = prev.filter((i) => i.id !== created.id);
        next.push(created);
        return sortByCreatedAt(next);
      });
      setNameInput("");
      toast().success(created.reused ? t("assistantPanel.inviteReused") : t("assistantPanel.inviteCreated"));
    } catch (err) {
      toast().error(err instanceof Error ? err.message : t("assistantPanel.createFailed"));
    } finally {
      setCreating(false);
    }
  }

  async function handleCreateManaged() {
    const name = managedNameInput.trim();
    if (!name || !managedServerConfigId || !principal) return;

    setCreatingManaged(true);
    try {
      const created = await createManagedAssistant(
        principal.principalId,
        principal.principalToken,
        name,
        { serverConfigId: managedServerConfigId },
      );
      setAssistants((prev) => sortByCreatedAt([...prev, created]));
      setManagedNameInput("");
      toast().success(t("assistantPanel.directCreateSuccess"));
    } catch (err) {
      toast().error(err instanceof Error ? err.message : t("assistantPanel.directCreateFailed"));
    } finally {
      setCreatingManaged(false);
    }
  }

  async function handleCopy(invite: PrivateAssistantInviteRecord) {
    setCopyingId(invite.id);
    try {
      await copyText(buildInvitePrompt(invite));
      toast().success(t("common.copied"));
    } catch {
      toast().error(t("assistantPanel.copyFailed"));
    } finally {
      setCopyingId(null);
    }
  }

  async function handleRemove(assistant: PrivateAssistantRecord) {
    if (!principal) return;
    Modal.confirm({
      title: t("assistantPanel.removeConfirmTitle"),
      content: t("assistantPanel.removeConfirmMessage", { name: assistant.name }),
      okText: t("assistantPanel.remove"),
      cancelText: t("common.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        setRemovingId(assistant.id);
        try {
          await removePrivateAssistant(assistant.id, principal.principalId, principal.principalToken);
          setAssistants((prev) => prev.filter((a) => a.id !== assistant.id));
          toast().success(t("assistantPanel.removeSuccess"));
        } catch (err) {
          toast().error(err instanceof Error ? err.message : t("assistantPanel.removeFailed"));
        } finally {
          setRemovingId(null);
        }
      },
    });
  }

  async function handleToggleAssistant(assistant: PrivateAssistantRecord) {
    if (!principal) return;

    setTogglingAssistantId(assistant.id);
    try {
      const updated = assistant.status === "paused"
        ? await resumePrivateAssistant(assistant.id, principal.principalId, principal.principalToken)
        : await pausePrivateAssistant(assistant.id, principal.principalId, principal.principalToken);
      setAssistants((prev) =>
        sortByCreatedAt(prev.map((item) => (item.id === assistant.id ? updated : item))),
      );
      toast().success(
        assistant.status === "paused"
          ? t("assistantPanel.resumeSuccess")
          : t("assistantPanel.pauseSuccess"),
      );
    } catch (err) {
      toast().error(
        err instanceof Error
          ? err.message
          : assistant.status === "paused"
            ? t("assistantPanel.resumeFailed")
            : t("assistantPanel.pauseFailed"),
      );
    } finally {
      setTogglingAssistantId(null);
    }
  }

  async function handleRemoveInvite(inviteId: string) {
    if (!principal) return;

    setRemovingInviteId(inviteId);
    try {
      await removeAssistantInvite(inviteId, principal.principalId, principal.principalToken);
      setInvites((prev) => prev.filter((invite) => invite.id !== inviteId));
      toast().success(t("assistantPanel.removeInviteSuccess"));
    } catch (err) {
      toast().error(err instanceof Error ? err.message : t("assistantPanel.removeInviteFailed"));
    } finally {
      setRemovingInviteId(null);
    }
  }

  async function handleCreateServerConfig() {
    const name = serverConfigNameInput.trim();
    const baseUrl = serverConfigBaseUrl.trim();
    const model = serverConfigModel.trim();
    if (!principal || !name || !baseUrl || !model) return;

    setCreatingServerConfig(true);
    try {
      const created = await createServerConfig({
        principalId: principal.principalId,
        principalToken: principal.principalToken,
        name,
        backendType: "openai_compatible",
        visibility: serverConfigVisibility,
        config: {
          baseUrl,
          model,
          ...(serverConfigApiKey.trim() ? { apiKey: serverConfigApiKey.trim() } : {}),
        },
      });
      setServerConfigs((prev) => sortByCreatedAt([...prev, created]));
      setManagedServerConfigId(created.id);
      setServerConfigNameInput("");
      setServerConfigBaseUrl("");
      setServerConfigModel("");
      setServerConfigApiKey("");
      setServerConfigVisibility("private");
      toast().success(t("assistantPanel.configCreateSuccess"));
    } catch (err) {
      toast().error(err instanceof Error ? err.message : t("assistantPanel.configCreateFailed"));
    } finally {
      setCreatingServerConfig(false);
    }
  }

  async function handleCreateAgentCitizen() {
    const loginKey = agentCitizenLoginKey.trim();
    const globalDisplayName = agentCitizenDisplayName.trim();
    if (!principal || !loginKey || !globalDisplayName || !agentCitizenServerConfigId) return;

    setCreatingAgentCitizen(true);
    try {
      await createAgentCitizen({
        actorPrincipalId: principal.principalId,
        actorPrincipalToken: principal.principalToken,
        loginKey,
        globalDisplayName,
        serverConfigId: agentCitizenServerConfigId,
      });
      setAgentCitizenLoginKey("");
      setAgentCitizenDisplayName("");
      await refreshLobbyPresence();
      toast().success(t("assistantPanel.agentCitizenCreateSuccess"));
    } catch (err) {
      toast().error(
        err instanceof Error ? err.message : t("assistantPanel.agentCitizenCreateFailed"),
      );
    } finally {
      setCreatingAgentCitizen(false);
    }
  }

  async function handleToggleServerConfigVisibility(config: ServerConfigRecord) {
    if (!principal) return;

    setUpdatingServerConfigId(config.id);
    try {
      const updated = await updateServerConfig({
        configId: config.id,
        principalId: principal.principalId,
        principalToken: principal.principalToken,
        visibility: config.visibility === "shared" ? "private" : "shared",
      });
      setServerConfigs((prev) =>
        sortByCreatedAt(prev.map((item) => (item.id === config.id ? updated : item))),
      );
      await refreshData();
      toast().success(
        updated.visibility === "shared"
          ? t("assistantPanel.configShareSuccess")
          : t("assistantPanel.configPrivatizeSuccess"),
      );
    } catch (err) {
      toast().error(err instanceof Error ? err.message : t("assistantPanel.configUpdateFailed"));
    } finally {
      setUpdatingServerConfigId(null);
    }
  }

  async function handleRemoveServerConfig(config: ServerConfigRecord) {
    if (!principal) return;

    Modal.confirm({
      title: t("assistantPanel.removeConfigConfirmTitle"),
      content: t("assistantPanel.removeConfigConfirmMessage", { name: config.name }),
      okText: t("assistantPanel.removeConfig"),
      cancelText: t("common.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        setRemovingServerConfigId(config.id);
        try {
          await removeServerConfig(config.id, principal.principalId, principal.principalToken);
          setServerConfigs((prev) => prev.filter((item) => item.id !== config.id));
          toast().success(t("assistantPanel.removeConfigSuccess"));
        } catch (err) {
          toast().error(err instanceof Error ? err.message : t("assistantPanel.removeConfigFailed"));
        } finally {
          setRemovingServerConfigId(null);
        }
      },
    });
  }

  function inviteStatusLabel(status: PrivateAssistantInviteRecord["status"]): string {
    return t(`assistantPanel.inviteStatus.${status}`);
  }

  function serverConfigVisibilityLabel(visibility: "private" | "shared"): string {
    return t(`assistantPanel.serverConfigVisibility.${visibility}`);
  }

  function renderServerConfigSummary(
    config: Pick<ServerConfigRecord, "config"> | Pick<SharedServerConfigRecord, "config">,
  ): string {
    return `${config.config.model} · ${config.config.baseUrl}`;
  }

  function backendTypeLabel(type: string): string {
    if (type === "codex_cli") return t("assistantPanel.backendCodex");
    if (type === "claude_code") return t("assistantPanel.backendClaudeCode");
    if (type === "opencode") return t("assistantPanel.backendOpenCode");
    if (type === "openai_compatible") return t("login.backendOpenAICompatible");
    return type;
  }

  return (
    <Modal
      title={null}
      open={open}
      onCancel={onClose}
      footer={null}
      destroyOnHidden
      width={640}
      className="assistant-management-modal"
    >
      <div className="am-panel">
        {/* Panel header */}
        <div className="am-panel-header">
          <div className="am-panel-header-left">
            <span className="am-panel-title">
              <RobotOutlined style={{ marginRight: 8 }} />
              {t("assistantPanel.title")}
            </span>
            {assistants.length > 0 && (
              <span className="am-count-badge">{assistants.length}</span>
            )}
          </div>
        </div>

        {/* Connected assistants */}
        {assistants.length > 0 ? (
          <div className="am-section">
            <div className="am-list">
              {assistants.map((assistant) => (
                <div key={assistant.id} className="am-list-item">
                  <div className="am-item-left">
                    <div className="am-item-name-row">
                      <span className="am-source-icon" aria-hidden="true">
                        {sourceIcon(assistant.backendType)}
                      </span>
                      <div className="am-item-name">{assistant.name}</div>
                    </div>
                    <div className="am-item-meta">
                      <Tag className="am-backend-tag">{backendTypeLabel(assistant.backendType)}</Tag>
                      <Tag className="am-status-tag">
                        {t(`assistantPanel.assistantStatus.${assistant.status}`)}
                      </Tag>
                    </div>
                  </div>
                  <div className="am-item-actions">
                    <Button
                      size="small"
                      loading={togglingAssistantId === assistant.id}
                      onClick={() => void handleToggleAssistant(assistant)}
                    >
                      {assistant.status === "paused"
                        ? t("assistantPanel.resumeAssistant")
                        : t("assistantPanel.pauseAssistant")}
                    </Button>
                    <Button
                      size="small"
                      type="text"
                      danger
                      loading={removingId === assistant.id}
                      onClick={() => void handleRemove(assistant)}
                      icon={<DeleteOutlined />}
                    >
                      {t("assistantPanel.remove")}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* Pending invites */}
        {pendingInvites.length > 0 ? (
          <div className="am-section">
            <div className="am-section-header">
              <span className="am-section-title">{t("assistantPanel.pendingTitle")}</span>
            </div>
            <div className="am-list">
              {pendingInvites.map((invite) => (
                <div key={invite.id} className="am-list-item">
                  <div className="am-item-left">
                    <div className="am-item-name-row">
                      <span className="am-source-icon" aria-hidden="true">
                        {sourceIcon(invite.backendType)}
                      </span>
                      <div className="am-item-name">{invite.name}</div>
                    </div>
                    <div className="am-item-meta">
                      <Tag className="am-backend-tag">{backendTypeLabel(invite.backendType)}</Tag>
                      <Tag className="am-status-tag">{inviteStatusLabel(invite.status)}</Tag>
                      <Text type="secondary" className="am-invite-prompt">
                        {buildInvitePrompt(invite)}
                      </Text>
                    </div>
                  </div>
                  <div className="am-item-actions">
                    <Button
                      size="small"
                      loading={copyingId === invite.id}
                      onClick={() => void handleCopy(invite)}
                      icon={<CopyOutlined />}
                    >
                      {t("assistantPanel.copyPrompt")}
                    </Button>
                    <Button
                      size="small"
                      type="text"
                      danger
                      loading={removingInviteId === invite.id}
                      onClick={() => void handleRemoveInvite(invite.id)}
                      icon={<DeleteOutlined />}
                    >
                      {t("assistantPanel.revokeInvite")}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* Empty state */}
        {assistants.length === 0 && pendingInvites.length === 0 ? (
          <div className="am-empty">
            <RobotOutlined className="am-empty-icon" />
            <div className="am-empty-title">{t("assistantPanel.emptyTitle")}</div>
            <div className="am-empty-hint">{t("assistantPanel.emptyHint")}</div>
          </div>
        ) : null}

        <div className="am-invite-section">
          <Text type="secondary" className="am-invite-label">
            {t("assistantPanel.serverConfigsTitle")}
          </Text>
          {serverConfigs.length > 0 ? (
            <div className="am-list">
              {serverConfigs.map((config) => (
                <div key={config.id} className="am-list-item">
                  <div className="am-item-left">
                    <div className="am-item-name-row">
                      <span className="am-source-icon" aria-hidden="true">
                        <ApiOutlined />
                      </span>
                      <div className="am-item-name">{config.name}</div>
                    </div>
                    <div className="am-item-meta">
                      <Tag className="am-backend-tag">{backendTypeLabel(config.backendType)}</Tag>
                      <Tag className="am-status-tag">
                        {serverConfigVisibilityLabel(config.visibility)}
                      </Tag>
                      <Text type="secondary" className="am-item-summary">
                        {renderServerConfigSummary(config)}
                      </Text>
                    </div>
                  </div>
                  <div className="am-item-actions">
                    <Button
                      size="small"
                      loading={updatingServerConfigId === config.id}
                      onClick={() => void handleToggleServerConfigVisibility(config)}
                    >
                      {config.visibility === "shared"
                        ? t("assistantPanel.privatizeConfig")
                        : t("assistantPanel.shareConfig")}
                    </Button>
                    <Button
                      size="small"
                      type="text"
                      danger
                      loading={removingServerConfigId === config.id}
                      onClick={() => void handleRemoveServerConfig(config)}
                      icon={<DeleteOutlined />}
                    >
                      {t("assistantPanel.removeConfig")}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Text type="secondary" className="am-item-summary">
              {t("assistantPanel.serverConfigsEmpty")}
            </Text>
          )}
          {sharedServerConfigs.length > 0 ? (
            <>
              <Text type="secondary" className="am-invite-label">
                {t("assistantPanel.sharedServerConfigsTitle")}
              </Text>
              <div className="am-list">
                {sharedServerConfigs.map((config) => (
                  <div key={config.id} className="am-list-item">
                    <div className="am-item-left">
                      <div className="am-item-name-row">
                        <span className="am-source-icon" aria-hidden="true">
                          <ApiOutlined />
                        </span>
                        <div className="am-item-name">{config.name}</div>
                      </div>
                      <div className="am-item-meta">
                        <Tag className="am-backend-tag">{backendTypeLabel(config.backendType)}</Tag>
                        <Tag className="am-status-tag">
                          {serverConfigVisibilityLabel(config.visibility)}
                        </Tag>
                        {config.hasAuth ? (
                          <Tag className="am-status-tag">{t("assistantPanel.authManaged")}</Tag>
                        ) : null}
                        <Text type="secondary" className="am-item-summary">
                          {renderServerConfigSummary(config)}
                        </Text>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </div>

        <div className="am-invite-section">
          <Text type="secondary" className="am-invite-label">
            {t("assistantPanel.createConfigLabel")}
          </Text>
          <div className="am-source-hint">
            <span className="am-source-icon" aria-hidden="true">
              <ApiOutlined />
            </span>
            <Text type="secondary">{t("login.backendOpenAICompatible")}</Text>
          </div>
          <div className="am-form-grid">
            <Input
              value={serverConfigNameInput}
              onChange={(e) => setServerConfigNameInput(e.target.value)}
              placeholder={t("assistantPanel.configNamePlaceholder")}
            />
            <Select
              value={serverConfigVisibility}
              onChange={setServerConfigVisibility}
              options={[
                {
                  value: "private",
                  label: t("assistantPanel.serverConfigVisibility.private"),
                },
                {
                  value: "shared",
                  label: t("assistantPanel.serverConfigVisibility.shared"),
                },
              ]}
            />
            <Input
              value={serverConfigBaseUrl}
              onChange={(e) => setServerConfigBaseUrl(e.target.value)}
              placeholder={t("login.backendBaseUrlPlaceholder")}
            />
            <Input
              value={serverConfigModel}
              onChange={(e) => setServerConfigModel(e.target.value)}
              placeholder={t("login.backendModelPlaceholder")}
            />
            <Input.Password
              value={serverConfigApiKey}
              onChange={(e) => setServerConfigApiKey(e.target.value)}
              placeholder={t("login.backendApiKeyPlaceholder")}
            />
          </div>
          <div className="am-inline-actions">
            <Tag className="am-backend-tag">{t("login.backendOpenAICompatible")}</Tag>
            <Button
              type="primary"
              loading={creatingServerConfig}
              onClick={() => void handleCreateServerConfig()}
              icon={<PlusOutlined />}
              className="am-create-btn"
            >
              {t("assistantPanel.createConfig")}
            </Button>
          </div>
          <Text type="secondary" className="am-invite-tip">
            {t("assistantPanel.createConfigTip")}
          </Text>
        </div>

        <div className="am-invite-section">
          <Text type="secondary" className="am-invite-label">
            {t("assistantPanel.directLabel")}
          </Text>
          <div className="am-source-hint">
            <span className="am-source-icon" aria-hidden="true">
              <ApiOutlined />
            </span>
            <Text type="secondary">{t("login.backendOpenAICompatible")}</Text>
          </div>
          <div className="am-form-grid">
            <Input
              value={managedNameInput}
              onChange={(e) => setManagedNameInput(e.target.value)}
              placeholder={t("assistantPanel.namePlaceholder")}
            />
            <Select
              value={managedServerConfigId || undefined}
              onChange={setManagedServerConfigId}
              placeholder={t("assistantPanel.selectServerConfigPlaceholder")}
              options={availableServerConfigOptions}
            />
          </div>
          <div className="am-inline-actions">
            <Tag className="am-backend-tag">{t("login.backendOpenAICompatible")}</Tag>
            <Button
              type="primary"
              loading={creatingManaged}
              onClick={() => void handleCreateManaged()}
              icon={<PlusOutlined />}
              className="am-create-btn"
              disabled={!managedServerConfigId}
            >
              {t("assistantPanel.directCreate")}
            </Button>
          </div>
          <Text type="secondary" className="am-invite-tip">
            {t("assistantPanel.directTip")}
          </Text>
        </div>

        <div className="am-invite-section">
          <Text type="secondary" className="am-invite-label">
            {t("assistantPanel.agentCitizenLabel")}
          </Text>
          <div className="am-source-hint">
            <span className="am-source-icon" aria-hidden="true">
              <RobotOutlined />
            </span>
            <Text type="secondary">{t("assistantPanel.agentCitizenHint")}</Text>
          </div>
          <div className="am-form-grid">
            <Input
              value={agentCitizenDisplayName}
              onChange={(e) => setAgentCitizenDisplayName(e.target.value)}
              placeholder={t("assistantPanel.agentCitizenDisplayNamePlaceholder")}
            />
            <Input
              value={agentCitizenLoginKey}
              onChange={(e) => setAgentCitizenLoginKey(e.target.value)}
              placeholder={t("assistantPanel.agentCitizenLoginKeyPlaceholder")}
            />
            <Select
              value={agentCitizenServerConfigId || undefined}
              onChange={setAgentCitizenServerConfigId}
              placeholder={t("assistantPanel.selectServerConfigPlaceholder")}
              options={availableServerConfigOptions}
            />
          </div>
          <div className="am-inline-actions">
            <Tag className="am-backend-tag">{t("assistantPanel.agentCitizenTag")}</Tag>
            <Button
              type="primary"
              loading={creatingAgentCitizen}
              onClick={() => void handleCreateAgentCitizen()}
              icon={<PlusOutlined />}
              className="am-create-btn"
              disabled={!agentCitizenServerConfigId}
            >
              {t("assistantPanel.agentCitizenCreate")}
            </Button>
          </div>
          <Text type="secondary" className="am-invite-tip">
            {t("assistantPanel.agentCitizenTip")}
          </Text>
        </div>

        {/* Create invite section */}
        <div className="am-invite-section">
          <Text type="secondary" className="am-invite-label">
            {t("assistantPanel.inviteLabel")}
          </Text>
          <div className="am-source-hint">
            <span className="am-source-icon" aria-hidden="true">
              <RobotOutlined />
            </span>
            <Text type="secondary">{t("assistantPanel.externalAgentLabel")}</Text>
          </div>
          <div className="am-invite-form">
            <Input
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder={t("assistantPanel.namePlaceholder")}
              onPressEnter={handleCreate}
              className="am-name-input"
            />
            <Select
              value={inviteBackendType}
              onChange={setInviteBackendType}
              style={{ width: 156 }}
              options={[
                { value: "claude_code", label: t("assistantPanel.backendClaudeCode") },
                { value: "codex_cli", label: t("assistantPanel.backendCodex") },
                { value: "opencode", label: t("assistantPanel.backendOpenCode") },
              ]}
            />
            <Button
              type="primary"
              loading={creating}
              onClick={handleCreate}
              icon={<PlusOutlined />}
              className="am-create-btn"
            >
              {t("assistantPanel.createInvite")}
            </Button>
          </div>
          <Text type="secondary" className="am-invite-tip">
            {t("assistantPanel.inviteTip")}
          </Text>
        </div>
      </div>
    </Modal>
  );
}
