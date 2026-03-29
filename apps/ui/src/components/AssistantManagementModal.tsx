import { useState, useEffect, useMemo, useCallback } from "react";
import { Modal, Input, Button, Typography, Tag, Select } from "antd";
import { RobotOutlined, CopyOutlined, PlusOutlined, DeleteOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";

import { toast } from "../lib/feedback";
import { usePrincipalStore } from "../stores/principal";
import {
  getPrivateAssistants,
  getAssistantInvites,
  createAssistantInvite,
  removeAssistantInvite,
  removePrivateAssistant,
} from "../api/assistants";
import type {
  PrivateAssistantRecord,
  PrivateAssistantInviteRecord,
} from "../api/assistants";
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
  return type;
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

  const [assistants, setAssistants] = useState<PrivateAssistantRecord[]>([]);
  const [invites, setInvites] = useState<PrivateAssistantInviteRecord[]>([]);
  const [nameInput, setNameInput] = useState("");
  const [creating, setCreating] = useState(false);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removingInviteId, setRemovingInviteId] = useState<string | null>(null);
  const [inviteBackendType, setInviteBackendType] = useState<AgentBackendType>("claude_code");

  const refreshData = useCallback(async () => {
    if (!principal) {
      setAssistants([]);
      setInvites([]);
      return;
    }
    try {
      const [items, inviteItems] = await Promise.all([
        getPrivateAssistants(principal.principalId, principal.principalToken),
        getAssistantInvites(principal.principalId, principal.principalToken),
      ]);
      setAssistants(sortByCreatedAt(items));
      setInvites(sortByCreatedAt(inviteItems));
    } catch {
      setAssistants([]);
      setInvites([]);
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

  async function handleCopy(invite: PrivateAssistantInviteRecord) {
    setCopyingId(invite.id);
    try {
      await navigator.clipboard.writeText(buildInvitePrompt(invite));
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

  function inviteStatusLabel(status: PrivateAssistantInviteRecord["status"]): string {
    return t(`assistantPanel.inviteStatus.${status}`);
  }

  function backendTypeLabel(type: string): string {
    if (type === "codex_cli") return t("assistantPanel.backendCodex");
    if (type === "claude_code") return t("assistantPanel.backendClaudeCode");
    if (type === "opencode") return t("assistantPanel.backendOpenCode");
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
                    <div className="am-item-name">{assistant.name}</div>
                    <div className="am-item-meta">
                      <Tag className="am-backend-tag">{backendTypeLabel(assistant.backendType)}</Tag>
                    </div>
                  </div>
                  <div className="am-item-actions">
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
                    <div className="am-item-name">{invite.name}</div>
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

        {/* Create invite section */}
        <div className="am-invite-section">
          <Text type="secondary" className="am-invite-label">
            {t("assistantPanel.inviteLabel")}
          </Text>
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
