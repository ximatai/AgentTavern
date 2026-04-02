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
import { useCitizenStore } from "../stores/citizen";
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
import { getMyServerConfigs, getSharedServerConfigs } from "../api/server-configs";
import type { ServerConfigRecord, SharedServerConfigRecord } from "../api/server-configs";
import type { AgentBackendType } from "@agent-tavern/shared";

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
  return [
    `请把当前 ${backendPromptName(invite.backendType)} 会话接入 AgentTavern 私有助理“${invite.name}”。`,
    "",
    "邀请链接：",
    fullUrl,
  ].join("\n");
}

interface AssistantManagementModalProps {
  open: boolean;
  onClose: () => void;
  onOpenModelConnections: () => void;
}

export function AssistantManagementModal({
  open,
  onClose,
  onOpenModelConnections,
}: AssistantManagementModalProps) {
  const { t } = useTranslation();
  const principal = useCitizenStore((s) => s.principal);

  const [assistants, setAssistants] = useState<PrivateAssistantRecord[]>([]);
  const [invites, setInvites] = useState<PrivateAssistantInviteRecord[]>([]);
  const [serverConfigs, setServerConfigs] = useState<ServerConfigRecord[]>([]);
  const [sharedServerConfigs, setSharedServerConfigs] = useState<SharedServerConfigRecord[]>([]);
  const [nameInput, setNameInput] = useState("");
  const [managedNameInput, setManagedNameInput] = useState("");
  const [managedServerConfigId, setManagedServerConfigId] = useState<string>("");
  const [creatingManaged, setCreatingManaged] = useState(false);
  const [creating, setCreating] = useState(false);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removingInviteId, setRemovingInviteId] = useState<string | null>(null);
  const [togglingAssistantId, setTogglingAssistantId] = useState<string | null>(null);
  const [inviteBackendType, setInviteBackendType] = useState<AgentBackendType>("claude_code");
  const [createMode, setCreateMode] = useState<"managed" | "invite">("managed");

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
        getPrivateAssistants(principal.citizenId, principal.citizenToken),
        getAssistantInvites(principal.citizenId, principal.citizenToken),
        getMyServerConfigs(principal.citizenId, principal.citizenToken),
        getSharedServerConfigs(principal.citizenId, principal.citizenToken),
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

  const privateAssetsVersion = useCitizenStore((s) => s.privateAssetsVersion);

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

  async function handleCreate() {
    const name = nameInput.trim();
    if (!name || !principal) return;
    setCreating(true);
    try {
      const created = await createAssistantInvite(
        principal.citizenId,
        principal.citizenToken,
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
        principal.citizenId,
        principal.citizenToken,
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
          await removePrivateAssistant(assistant.id, principal.citizenId, principal.citizenToken);
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
        ? await resumePrivateAssistant(assistant.id, principal.citizenId, principal.citizenToken)
        : await pausePrivateAssistant(assistant.id, principal.citizenId, principal.citizenToken);
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
      await removeAssistantInvite(inviteId, principal.citizenId, principal.citizenToken);
      setInvites((prev) => prev.filter((invite) => invite.id !== inviteId));
      toast().success(t("assistantPanel.removeInviteSuccess"));
    } catch (err) {
      toast().error(err instanceof Error ? err.message : t("assistantPanel.removeInviteFailed"));
    } finally {
      setRemovingInviteId(null);
    }
  }

  function inviteStatusLabel(status: PrivateAssistantInviteRecord["status"]): string {
    return t(`assistantPanel.inviteStatus.${status}`);
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
            <div className="am-section-header">
              <span className="am-section-title">{t("assistantPanel.connectedTitle")}</span>
            </div>
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
                <div key={invite.id} className="am-list-item am-list-item-pending">
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
                      <Text type="secondary" className="am-item-summary">
                        {t("assistantPanel.pendingHint")}
                      </Text>
                    </div>
                    <div className="am-invite-prompt-block">
                      <Text className="am-invite-prompt">
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
          <div className="am-section-header am-section-header-tight">
            <span className="am-section-title">{t("assistantPanel.createTitle")}</span>
            <div className="am-mode-switch" role="tablist" aria-label={t("assistantPanel.createModeLabel")}>
              <button
                type="button"
                className={`am-mode-switch-button ${createMode === "managed" ? "is-active" : ""}`}
                onClick={() => setCreateMode("managed")}
              >
                {t("assistantPanel.createModeManaged")}
              </button>
              <button
                type="button"
                className={`am-mode-switch-button ${createMode === "invite" ? "is-active" : ""}`}
                onClick={() => setCreateMode("invite")}
              >
                {t("assistantPanel.createModeInvite")}
              </button>
            </div>
          </div>
          {createMode === "managed" ? (
            <div className="am-create-card">
              <Text type="secondary" className="am-invite-label">
                {t("assistantPanel.directLabel")}
              </Text>
              <div className="am-source-hint">
                <span className="am-source-icon" aria-hidden="true">
                  <ApiOutlined />
                </span>
                <Text type="secondary">{t("assistantPanel.directHint")}</Text>
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
              {availableServerConfigOptions.length === 0 ? (
                <div className="am-empty-inline">
                  <Text type="secondary">{t("assistantPanel.noModelConnectionHint")}</Text>
                  <Button
                    size="small"
                    onClick={() => {
                      onClose();
                      onOpenModelConnections();
                    }}
                  >
                    {t("assistantPanel.openModelConnections")}
                  </Button>
                </div>
              ) : null}
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
          ) : (
            <div className="am-create-card">
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
          )}
        </div>

      </div>
    </Modal>
  );
}
