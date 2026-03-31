import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, Button, Typography, Tag } from "antd";
import { ApiOutlined, RobotOutlined, TeamOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";

import { toast } from "../lib/feedback";
import { usePrincipalStore } from "../stores/principal";
import { useRoomStore } from "../stores/room";
import {
  adoptAssistant,
  getPrivateAssistants,
  takeAssistantOffline,
} from "../api/assistants";
import type { PrivateAssistantRecord } from "../api/assistants";

import "../styles/assistant-management.css";

const { Text } = Typography;

function backendTypeLabel(type: string, t: (key: string) => string): string {
  if (type === "codex_cli") return t("assistantPanel.backendCodex");
  if (type === "claude_code") return t("assistantPanel.backendClaudeCode");
  if (type === "opencode") return t("assistantPanel.backendOpenCode");
  if (type === "openai_compatible") return t("login.backendOpenAICompatible");
  return type;
}

function sourceIcon(type: string) {
  return type === "openai_compatible" ? <ApiOutlined /> : <RobotOutlined />;
}

interface RoomAssistantModalProps {
  open: boolean;
  onClose: () => void;
}

export function RoomAssistantModal({ open, onClose }: RoomAssistantModalProps) {
  const { t } = useTranslation();
  const principal = usePrincipalStore((s) => s.principal);
  const room = useRoomStore((s) => s.room);
  const self = useRoomStore((s) => s.self);
  const members = useRoomStore((s) => s.members);
  const hydrateRoom = useRoomStore((s) => s.hydrateRoom);

  const [assistants, setAssistants] = useState<PrivateAssistantRecord[]>([]);
  const [adoptingId, setAdoptingId] = useState<string | null>(null);
  const [offliningId, setOffliningId] = useState<string | null>(null);

  const refreshData = useCallback(async () => {
    if (!principal) {
      setAssistants([]);
      return;
    }
    try {
      const items = await getPrivateAssistants(principal.principalId, principal.principalToken);
      setAssistants([...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    } catch {
      setAssistants([]);
    }
  }, [principal]);

  useEffect(() => {
    if (open) {
      void refreshData();
    }
  }, [open, refreshData]);

  const joinedAssistantIds = useMemo(
    () => new Set(members.map((m) => m.sourcePrivateAssistantId).filter(Boolean)),
    [members],
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
        <div className="am-panel-header">
          <div className="am-panel-header-left">
            <span className="am-panel-title">
              <TeamOutlined style={{ marginRight: 8 }} />
              {t("roomAssistantPanel.title")}
            </span>
            {room ? <span className="am-count-badge">{room.name}</span> : null}
          </div>
        </div>

        {assistants.length > 0 ? (
          <div className="am-section">
            <div className="am-section-header">
              <span className="am-section-title">{t("roomAssistantPanel.availableTitle")}</span>
            </div>
            <div className="am-list">
              {assistants.map((assistant) => {
                const joined = joinedAssistantIds.has(assistant.id);
                const paused = assistant.status === "paused";
                return (
                  <div key={assistant.id} className="am-list-item">
                    <div className="am-item-left">
                      <div className="am-item-name-row">
                        <span className="am-source-icon" aria-hidden="true">
                          {sourceIcon(assistant.backendType)}
                        </span>
                        <div className="am-item-name">{assistant.name}</div>
                      </div>
                      <div className="am-item-meta">
                        <Tag className="am-backend-tag">{backendTypeLabel(assistant.backendType, t)}</Tag>
                        <Tag className="am-status-tag">
                          {t(`assistantPanel.assistantStatus.${assistant.status}`)}
                        </Tag>
                        <Text type="secondary" className="am-item-status">
                          {joined
                            ? t("roomAssistantPanel.statusInRoom")
                            : t("roomAssistantPanel.statusNotInRoom")}
                        </Text>
                      </div>
                    </div>
                    <div className="am-item-actions">
                      {joined ? (
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
                          disabled={paused}
                          loading={adoptingId === assistant.id}
                          onClick={() => void handleAdopt(assistant.id)}
                          icon={<RobotOutlined />}
                        >
                          {paused ? t("assistantPanel.pausedAssistant") : t("assistantPanel.joinRoom")}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="am-empty">
            <RobotOutlined className="am-empty-icon" />
            <div className="am-empty-title">{t("roomAssistantPanel.emptyTitle")}</div>
            <div className="am-empty-hint">{t("roomAssistantPanel.emptyHint")}</div>
          </div>
        )}
      </div>
    </Modal>
  );
}
