import { useState, useEffect, useMemo, useCallback } from "react";
import { Modal, Input, Button, Typography, Tag, Select } from "antd";
import { RobotOutlined, CopyOutlined, PlusOutlined, DeleteOutlined, TeamOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";

import { toast } from "../lib/feedback";
import { usePrincipalStore } from "../stores/principal";
import { useRoomStore } from "../stores/room";
import {
  getPrivateAssistants,
  getAssistantInvites,
  createAssistantInvite,
  removeAssistantInvite,
  removePrivateAssistant,
  adoptAssistant,
  createRoomAssistantInvite,
  takeAssistantOffline,
} from "../api/assistants";
import type {
  AssistantInviteResult,
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

function buildInvitePrompt(invite: Pick<PrivateAssistantInviteRecord, "name" | "inviteUrl">): string {
  const path = invite.inviteUrl?.trim();
  const fullUrl = path
    ? new URL(path, resolveInviteOrigin()).toString()
    : "接入链接暂不可用，请重新生成";
  return `请接受这个 AgentTavern 私有助理邀请链接，并把当前 Codex 线程接入为我的私有助理"${invite.name}"：${fullUrl}`;
}

interface AssistantManagementModalProps {
  open: boolean;
  onClose: () => void;
}

export function AssistantManagementModal({ open, onClose }: AssistantManagementModalProps) {
  const { t } = useTranslation();
  const principal = usePrincipalStore((s) => s.principal);
  const room = useRoomStore((s) => s.room);
  const self = useRoomStore((s) => s.self);
  const members = useRoomStore((s) => s.members);
  const hydrateRoom = useRoomStore((s) => s.hydrateRoom);

  const [assistants, setAssistants] = useState<PrivateAssistantRecord[]>([]);
  const [invites, setInvites] = useState<PrivateAssistantInviteRecord[]>([]);
  const [nameInput, setNameInput] = useState("");
  const [creating, setCreating] = useState(false);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [adoptingId, setAdoptingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removingInviteId, setRemovingInviteId] = useState<string | null>(null);
  const [offliningId, setOffliningId] = useState<string | null>(null);
  const [roomInviteName, setRoomInviteName] = useState("架构助理");
  const [inviteBackendType, setInviteBackendType] = useState<AgentBackendType>("claude_code");
  const [roomInviteBackendType, setRoomInviteBackendType] = useState<AgentBackendType>("claude_code");
  const [creatingRoomInvite, setCreatingRoomInvite] = useState(false);
  const [copyingRoomInvite, setCopyingRoomInvite] = useState(false);
  const [roomAssistantInvite, setRoomAssistantInvite] = useState<AssistantInviteResult | null>(null);

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

  const joinedAssistantIds = useMemo(
    () => new Set(members.map((m) => m.sourcePrivateAssistantId).filter(Boolean)),
    [members],
  );
  const pendingInvites = useMemo(
    () => invites.filter((invite) => invite.status === "pending"),
    [invites],
  );
  const archivedInvites = useMemo(
    () => invites.filter((invite) => invite.status !== "pending"),
    [invites],
  );
  const joinedAssistantMembers = useMemo(
    () =>
      new Map(
        members
          .filter((m) => m.sourcePrivateAssistantId)
          .map((m) => [m.sourcePrivateAssistantId as string, m]),
      ),
    [members],
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

  async function handleAdopt(assistantId: string) {
    if (!self || !room) return;
    setAdoptingId(assistantId);
    try {
      await adoptAssistant(room.id, self.memberId, self.wsToken, assistantId);
      toast().success(t("assistantPanel.adoptSuccess"));
      await hydrateRoom(room.id);
    } catch (err) {
      toast().error(err instanceof Error ? err.message : t("assistantPanel.adoptFailed"));
    } finally {
      setAdoptingId(null);
    }
  }

  async function handleRemove(assistantId: string) {
    if (!principal) return;
    setRemovingId(assistantId);
    try {
      await removePrivateAssistant(assistantId, principal.principalId, principal.principalToken);
      setAssistants((prev) => prev.filter((a) => a.id !== assistantId));
      toast().success(t("assistantPanel.removeSuccess"));
      if (room) {
        await hydrateRoom(room.id);
      }
    } catch (err) {
      toast().error(err instanceof Error ? err.message : t("assistantPanel.removeFailed"));
    } finally {
      setRemovingId(null);
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

  async function handleCreateRoomInvite() {
    if (!room || !self) return;

    setCreatingRoomInvite(true);
    try {
      const created = await createRoomAssistantInvite(room.id, {
        actorMemberId: self.memberId,
        wsToken: self.wsToken,
        backendType: roomInviteBackendType,
        presetDisplayName: roomInviteName.trim() || undefined,
      });
      setRoomAssistantInvite(created);
      toast().success(t("assistantPanel.roomInviteCreated"));
    } catch (err) {
      toast().error(err instanceof Error ? err.message : t("assistantPanel.roomInviteCreateFailed"));
    } finally {
      setCreatingRoomInvite(false);
    }
  }

  async function handleCopyRoomInvite() {
    if (!roomAssistantInvite) return;

    setCopyingRoomInvite(true);
    try {
      const inviteUrl = new URL(roomAssistantInvite.inviteUrl, resolveInviteOrigin()).toString();
      await navigator.clipboard.writeText(inviteUrl);
      toast().success(t("assistantPanel.roomInviteCopied"));
    } catch (err) {
      toast().error(err instanceof Error ? err.message : t("assistantPanel.roomInviteCopyFailed"));
    } finally {
      setCopyingRoomInvite(false);
    }
  }

  async function handleTakeOffline(assistantId: string) {
    if (!room || !self) return;

    const assistantMember = joinedAssistantMembers.get(assistantId);
    if (!assistantMember) return;

    setOffliningId(assistantId);
    try {
      await takeAssistantOffline(room.id, {
        actorMemberId: self.memberId,
        wsToken: self.wsToken,
        assistantMemberId: assistantMember.id,
      });
      toast().success(t("assistantPanel.leaveRoomSuccess"));
      await hydrateRoom(room.id);
    } catch (err) {
      toast().error(err instanceof Error ? err.message : t("assistantPanel.leaveRoomFailed"));
    } finally {
      setOffliningId(null);
    }
  }

  function inviteStatusLabel(status: PrivateAssistantInviteRecord["status"]): string {
    return t(`assistantPanel.inviteStatus.${status}`);
  }

  function assistantStatusLabel(status: PrivateAssistantRecord["status"]): string {
    return t(`assistantPanel.assistantStatus.${status}`);
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
            <div className="am-section-header">
              <span className="am-section-title">{t("assistantPanel.connectedTitle")}</span>
              <span className="am-section-count">{assistants.length}</span>
            </div>
            <div className="am-list">
              {assistants.map((assistant) => (
                <div key={assistant.id} className="am-list-item">
                  <div className="am-item-left">
                    <div className="am-item-name">{assistant.name}</div>
                    <div className="am-item-meta">
                      <Tag className="am-backend-tag">{backendTypeLabel(assistant.backendType)}</Tag>
                      {assistantStatusLabel(assistant.status) && (
                        <Text type="secondary" className="am-item-status">
                          {assistantStatusLabel(assistant.status)}
                        </Text>
                      )}
                    </div>
                  </div>
                  <div className="am-item-actions">
                    {room ? (
                      joinedAssistantIds.has(assistant.id) ? (
                        <Button
                          size="small"
                          danger
                          loading={offliningId === assistant.id}
                          onClick={() => void handleTakeOffline(assistant.id)}
                        >
                          {t("assistantPanel.leaveRoom")}
                        </Button>
                      ) : (
                        <Button
                          size="small"
                          disabled={adoptingId === assistant.id}
                          loading={adoptingId === assistant.id}
                          onClick={() => void handleAdopt(assistant.id)}
                          icon={<TeamOutlined />}
                        >
                          {t("assistantPanel.joinRoom")}
                        </Button>
                      )
                    ) : null}
                    <Button
                      size="small"
                      type="text"
                      danger
                      loading={removingId === assistant.id}
                      onClick={() => void handleRemove(assistant.id)}
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
              <span className="am-section-count">{pendingInvites.length}</span>
            </div>
            <div className="am-list">
              {pendingInvites.map((invite) => (
                <div key={invite.id} className="am-list-item">
                  <div className="am-item-left">
                    <div className="am-item-name">{invite.name}</div>
                    <div className="am-item-meta">
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

        {/* Invite history */}
        {archivedInvites.length > 0 ? (
          <div className="am-section">
            <div className="am-section-header">
              <span className="am-section-title">{t("assistantPanel.historyTitle")}</span>
              <span className="am-section-count">{archivedInvites.length}</span>
            </div>
            <div className="am-list">
              {archivedInvites.map((invite) => (
                <div key={invite.id} className="am-list-item">
                  <div className="am-item-left">
                    <div className="am-item-name">{invite.name}</div>
                    <div className="am-item-meta">
                      <Tag className="am-status-tag">{inviteStatusLabel(invite.status)}</Tag>
                    </div>
                  </div>
                  <div className="am-item-actions">
                    <Button
                      size="small"
                      type="text"
                      danger
                      loading={removingInviteId === invite.id}
                      onClick={() => void handleRemoveInvite(invite.id)}
                      icon={<DeleteOutlined />}
                    >
                      {t("assistantPanel.removeInvite")}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* Empty state */}
        {assistants.length === 0 && pendingInvites.length === 0 && archivedInvites.length === 0 ? (
          <div className="am-empty">
            <RobotOutlined className="am-empty-icon" />
            <div className="am-empty-title">{t("assistantPanel.emptyTitle")}</div>
            <div className="am-empty-hint">{t("assistantPanel.emptyHint")}</div>
          </div>
        ) : null}

        {/* Create invite section */}
        <div className="am-invite-section">
          {room && self ? (
            <>
              <Text type="secondary" className="am-invite-label">
                {t("assistantPanel.roomInviteLabel")}
              </Text>
              <div className="am-invite-form">
                <Input
                  value={roomInviteName}
                  onChange={(e) => setRoomInviteName(e.target.value)}
                  placeholder={t("assistantPanel.roomInviteNamePlaceholder")}
                  onPressEnter={handleCreateRoomInvite}
                  className="am-name-input"
                />
                <Select
                  value={roomInviteBackendType}
                  onChange={setRoomInviteBackendType}
                  style={{ width: 130 }}
                  options={[
                    { value: "claude_code", label: t("assistantPanel.backendClaudeCode") },
                    { value: "codex_cli", label: t("assistantPanel.backendCodex") },
                    { value: "opencode", label: t("assistantPanel.backendOpenCode") },
                  ]}
                />
                <Button
                  type="primary"
                  loading={creatingRoomInvite}
                  onClick={() => void handleCreateRoomInvite()}
                  className="am-create-btn"
                >
                  {t("assistantPanel.createRoomInvite")}
                </Button>
                <Button
                  disabled={!roomAssistantInvite}
                  loading={copyingRoomInvite}
                  onClick={() => void handleCopyRoomInvite()}
                  icon={<CopyOutlined />}
                >
                  {t("assistantPanel.copyRoomInvite")}
                </Button>
              </div>
              {roomAssistantInvite ? (
                <Text type="secondary" className="am-invite-tip">
                  {new URL(roomAssistantInvite.inviteUrl, resolveInviteOrigin()).toString()}
                </Text>
              ) : (
                <Text type="secondary" className="am-invite-tip">
                  {t("assistantPanel.roomInviteTip")}
                </Text>
              )}
            </>
          ) : null}
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
              style={{ width: 130 }}
              options={[
                { value: "claude_code", label: t("assistantPanel.backendClaudeCode") },
                { value: "codex_cli", label: t("assistantPanel.backendCodex") },
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
