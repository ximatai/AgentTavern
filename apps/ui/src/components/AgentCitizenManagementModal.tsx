import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, Input, Button, Typography, Tag, Select } from "antd";
import { PlusOutlined, RobotOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";

import { toast } from "../lib/feedback";
import { useCitizenStore } from "../stores/citizen";
import { useRoomStore } from "../stores/room";
import { createAgentCitizen } from "../api/citizens";
import { getMyServerConfigs, getSharedServerConfigs } from "../api/server-configs";
import type { ServerConfigRecord, SharedServerConfigRecord } from "../api/server-configs";

import "../styles/assistant-management.css";

const { Text } = Typography;

function sortByCreatedAt<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

interface AgentCitizenManagementModalProps {
  open: boolean;
  onClose: () => void;
  onOpenModelConnections: () => void;
}

export function AgentCitizenManagementModal({
  open,
  onClose,
  onOpenModelConnections,
}: AgentCitizenManagementModalProps) {
  const { t } = useTranslation();
  const principal = useCitizenStore((s) => s.principal);
  const refreshLobbyPresence = useRoomStore((s) => s.refreshLobbyPresence);
  const [serverConfigs, setServerConfigs] = useState<ServerConfigRecord[]>([]);
  const [sharedServerConfigs, setSharedServerConfigs] = useState<SharedServerConfigRecord[]>([]);
  const [agentCitizenLoginKey, setAgentCitizenLoginKey] = useState("");
  const [agentCitizenDisplayName, setAgentCitizenDisplayName] = useState("");
  const [agentCitizenServerConfigId, setAgentCitizenServerConfigId] = useState<string>("");
  const [creatingAgentCitizen, setCreatingAgentCitizen] = useState(false);

  const refreshData = useCallback(async () => {
    if (!principal) {
      setServerConfigs([]);
      setSharedServerConfigs([]);
      return;
    }

    try {
      const [ownServerConfigs, sharedConfigs] = await Promise.all([
        getMyServerConfigs(principal.citizenId, principal.citizenToken),
        getSharedServerConfigs(principal.citizenId, principal.citizenToken),
      ]);
      setServerConfigs(sortByCreatedAt(ownServerConfigs));
      setSharedServerConfigs(sortByCreatedAt(sharedConfigs));
    } catch {
      setServerConfigs([]);
      setSharedServerConfigs([]);
    }
  }, [principal]);

  useEffect(() => {
    if (open) {
      void refreshData();
    }
  }, [open, refreshData]);

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
    if (!availableServerConfigOptions.some((item) => item.value === agentCitizenServerConfigId)) {
      setAgentCitizenServerConfigId(availableServerConfigOptions[0]?.value ?? "");
    }
  }, [availableServerConfigOptions, agentCitizenServerConfigId]);

  async function handleCreateAgentCitizen() {
    const loginKey = agentCitizenLoginKey.trim();
    const globalDisplayName = agentCitizenDisplayName.trim();
    if (!principal || !loginKey || !globalDisplayName || !agentCitizenServerConfigId) return;

    setCreatingAgentCitizen(true);
    try {
      await createAgentCitizen({
        actorCitizenId: principal.citizenId,
        actorCitizenToken: principal.citizenToken,
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

  return (
    <Modal
      title={t("agentCitizenPanel.title")}
      open={open}
      onCancel={onClose}
      footer={null}
      destroyOnHidden
      width={560}
      className="assistant-management-modal"
    >
      <div className="am-panel">
        <div className="am-panel-summary">
          <Text type="secondary">{t("agentCitizenPanel.summary")}</Text>
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
          {availableServerConfigOptions.length === 0 ? (
            <div className="am-empty-inline">
              <Text type="secondary">{t("agentCitizenPanel.noModelConnectionHint")}</Text>
              <Button
                size="small"
                onClick={() => {
                  onClose();
                  onOpenModelConnections();
                }}
              >
                {t("agentCitizenPanel.openModelConnections")}
              </Button>
            </div>
          ) : null}
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
      </div>
    </Modal>
  );
}
