import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, Input, Button, Typography, Tag, Select } from "antd";
import { DeleteOutlined, EditOutlined, PauseOutlined, PlusOutlined, RobotOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";

import { toast } from "../lib/feedback";
import { useCitizenStore } from "../stores/citizen";
import { useRoomStore } from "../stores/room";
import {
  createAgentCitizen,
  getManagedAgentCitizens,
  pauseAgentCitizen,
  removeAgentCitizen,
  resumeAgentCitizen,
  updateAgentCitizen,
  type ManagedAgentCitizen,
} from "../api/citizens";
import { getMyServerConfigs, getSharedServerConfigs } from "../api/server-configs";
import type { ServerConfigRecord, SharedServerConfigRecord } from "../api/server-configs";

import "../styles/assistant-management.css";

const { Text, Paragraph } = Typography;
const { TextArea } = Input;

function sortByCreatedAt<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

type FormState = {
  displayName: string;
  loginKey: string;
  serverConfigId: string;
  roleSummary: string;
  instructions: string;
};

const EMPTY_FORM: FormState = {
  displayName: "",
  loginKey: "",
  serverConfigId: "",
  roleSummary: "",
  instructions: "",
};

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
  const [agentCitizens, setAgentCitizens] = useState<ManagedAgentCitizen[]>([]);
  const [editingCitizenId, setEditingCitizenId] = useState<string | null>(null);
  const [formState, setFormState] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [togglingCitizenId, setTogglingCitizenId] = useState<string | null>(null);
  const [removingCitizenId, setRemovingCitizenId] = useState<string | null>(null);

  const refreshData = useCallback(async () => {
    if (!principal) {
      setServerConfigs([]);
      setSharedServerConfigs([]);
      setAgentCitizens([]);
      return;
    }

    try {
      const [ownServerConfigs, sharedConfigs, managedCitizens] = await Promise.all([
        getMyServerConfigs(principal.citizenId, principal.citizenToken),
        getSharedServerConfigs(principal.citizenId, principal.citizenToken),
        getManagedAgentCitizens(principal.citizenId, principal.citizenToken),
      ]);
      setServerConfigs(sortByCreatedAt(ownServerConfigs));
      setSharedServerConfigs(sortByCreatedAt(sharedConfigs));
      setAgentCitizens(managedCitizens);
    } catch {
      setServerConfigs([]);
      setSharedServerConfigs([]);
      setAgentCitizens([]);
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

  const serverConfigNameMap = useMemo(
    () => new Map(
      [...serverConfigs, ...sharedServerConfigs].map((config) => [config.id, config.name]),
    ),
    [serverConfigs, sharedServerConfigs],
  );

  useEffect(() => {
    if (!formState.serverConfigId || availableServerConfigOptions.some((item) => item.value === formState.serverConfigId)) {
      return;
    }

    setFormState((current) => ({
      ...current,
      serverConfigId: availableServerConfigOptions[0]?.value ?? "",
    }));
  }, [availableServerConfigOptions, formState.serverConfigId]);

  function resetForm() {
    setEditingCitizenId(null);
    setFormState({
      ...EMPTY_FORM,
      serverConfigId: availableServerConfigOptions[0]?.value ?? "",
    });
  }

  useEffect(() => {
    if (open && !editingCitizenId) {
      resetForm();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, availableServerConfigOptions.length]);

  function fillFormFromCitizen(citizen: ManagedAgentCitizen) {
    setEditingCitizenId(citizen.id);
    setFormState({
      displayName: citizen.globalDisplayName,
      loginKey: citizen.loginKey,
      serverConfigId: citizen.sourceServerConfigId ?? availableServerConfigOptions[0]?.value ?? "",
      roleSummary: citizen.roleSummary ?? "",
      instructions: citizen.instructions ?? "",
    });
  }

  async function handleSubmit() {
    if (!principal) return;
    const payload = {
      displayName: formState.displayName.trim(),
      loginKey: formState.loginKey.trim(),
      serverConfigId: formState.serverConfigId.trim(),
      roleSummary: formState.roleSummary.trim(),
      instructions: formState.instructions.trim(),
    };
    if (!payload.displayName || !payload.loginKey || !payload.serverConfigId) {
      return;
    }

    setSubmitting(true);
    try {
      if (editingCitizenId) {
        await updateAgentCitizen({
          citizenId: editingCitizenId,
          actorCitizenId: principal.citizenId,
          actorCitizenToken: principal.citizenToken,
          globalDisplayName: payload.displayName,
          loginKey: payload.loginKey,
          serverConfigId: payload.serverConfigId,
          roleSummary: payload.roleSummary,
          instructions: payload.instructions,
        });
        toast().success(t("agentCitizenPanel.updateSuccess"));
      } else {
        await createAgentCitizen({
          actorCitizenId: principal.citizenId,
          actorCitizenToken: principal.citizenToken,
          loginKey: payload.loginKey,
          globalDisplayName: payload.displayName,
          serverConfigId: payload.serverConfigId,
          roleSummary: payload.roleSummary,
          instructions: payload.instructions,
        });
        toast().success(t("assistantPanel.agentCitizenCreateSuccess"));
      }
      resetForm();
      await Promise.all([refreshData(), refreshLobbyPresence()]);
    } catch (err) {
      toast().error(
        err instanceof Error
          ? err.message
          : t(editingCitizenId ? "agentCitizenPanel.updateFailed" : "assistantPanel.agentCitizenCreateFailed"),
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggle(citizen: ManagedAgentCitizen) {
    if (!principal) return;
    setTogglingCitizenId(citizen.id);
    try {
      if (citizen.status === "online") {
        await pauseAgentCitizen(citizen.id, principal.citizenId, principal.citizenToken);
        toast().success(t("agentCitizenPanel.pauseSuccess"));
      } else {
        await resumeAgentCitizen(citizen.id, principal.citizenId, principal.citizenToken);
        toast().success(t("agentCitizenPanel.resumeSuccess"));
      }
      await Promise.all([refreshData(), refreshLobbyPresence()]);
    } catch (err) {
      toast().error(
        err instanceof Error
          ? err.message
          : t(citizen.status === "online" ? "agentCitizenPanel.pauseFailed" : "agentCitizenPanel.resumeFailed"),
      );
    } finally {
      setTogglingCitizenId(null);
    }
  }

  function handleRemove(citizen: ManagedAgentCitizen) {
    if (!principal) return;
    Modal.confirm({
      title: t("agentCitizenPanel.removeConfirmTitle"),
      content: t("agentCitizenPanel.removeConfirmMessage", { name: citizen.globalDisplayName }),
      okText: t("agentCitizenPanel.remove"),
      okButtonProps: { danger: true },
      centered: true,
      onOk: async () => {
        setRemovingCitizenId(citizen.id);
        try {
          await removeAgentCitizen(citizen.id, principal.citizenId, principal.citizenToken);
          toast().success(t("agentCitizenPanel.removeSuccess"));
          if (editingCitizenId === citizen.id) {
            resetForm();
          }
          await Promise.all([refreshData(), refreshLobbyPresence()]);
        } catch (err) {
          toast().error(err instanceof Error ? err.message : t("agentCitizenPanel.removeFailed"));
        } finally {
          setRemovingCitizenId(null);
        }
      },
    });
  }

  return (
    <Modal
      title={t("agentCitizenPanel.title")}
      open={open}
      onCancel={onClose}
      footer={null}
      destroyOnHidden
      width={640}
      className="assistant-management-modal"
    >
      <div className="am-panel">
        <div className="am-panel-summary">
          <Text type="secondary">{t("agentCitizenPanel.summary")}</Text>
        </div>

        <div className="am-section">
          <div className="am-section-header">
            <span className="am-section-title">{t("agentCitizenPanel.existingTitle")}</span>
            <span className="am-section-count">{agentCitizens.length}</span>
          </div>

          {agentCitizens.length > 0 ? (
            <div className="am-list">
              {agentCitizens.map((citizen) => (
                <div key={citizen.id} className="am-list-item am-list-item-agent">
                  <div className="am-item-left">
                    <div className="am-item-name-row">
                      <span className="am-source-icon" aria-hidden="true">
                        <RobotOutlined />
                      </span>
                      <div className="am-item-name">{citizen.globalDisplayName}</div>
                    </div>
                    <div className="am-item-meta">
                      <Tag className="am-backend-tag">{t("assistantPanel.agentCitizenTag")}</Tag>
                      <Tag className="am-status-tag">
                        {citizen.status === "online" ? t("agentCitizenPanel.statusOnline") : t("agentCitizenPanel.statusPaused")}
                      </Tag>
                      {citizen.sourceServerConfigId ? (
                        <Text type="secondary" className="am-item-summary">
                          {serverConfigNameMap.get(citizen.sourceServerConfigId) ?? citizen.sourceServerConfigId}
                        </Text>
                      ) : null}
                    </div>
                    {citizen.roleSummary ? (
                      <Paragraph className="am-agent-summary" ellipsis={{ rows: 2, expandable: false }}>
                        {citizen.roleSummary}
                      </Paragraph>
                    ) : (
                      <Text type="secondary" className="am-item-summary">
                        {t("agentCitizenPanel.noRoleSummary")}
                      </Text>
                    )}
                  </div>
                  <div className="am-item-actions">
                    <Button
                      size="small"
                      icon={<EditOutlined />}
                      onClick={() => fillFormFromCitizen(citizen)}
                    >
                      {t("common.edit")}
                    </Button>
                    <Button
                      size="small"
                      icon={<PauseOutlined />}
                      loading={togglingCitizenId === citizen.id}
                      onClick={() => void handleToggle(citizen)}
                    >
                      {citizen.status === "online" ? t("agentCitizenPanel.pause") : t("agentCitizenPanel.resume")}
                    </Button>
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      loading={removingCitizenId === citizen.id}
                      onClick={() => handleRemove(citizen)}
                    >
                      {t("agentCitizenPanel.remove")}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="am-empty">
              <RobotOutlined className="am-empty-icon" />
              <div className="am-empty-title">{t("agentCitizenPanel.emptyTitle")}</div>
              <div className="am-empty-hint">{t("agentCitizenPanel.emptyHint")}</div>
            </div>
          )}
        </div>

        <div className="am-invite-section">
          <div className="am-section-header am-section-header-tight">
            <span className="am-section-title">
              {editingCitizenId ? t("agentCitizenPanel.editTitle") : t("agentCitizenPanel.createTitle")}
            </span>
            {editingCitizenId ? (
              <Button size="small" onClick={() => resetForm()}>
                {t("agentCitizenPanel.cancelEdit")}
              </Button>
            ) : null}
          </div>

          <div className="am-create-card">
            <div className="am-source-hint">
              <span className="am-source-icon" aria-hidden="true">
                <RobotOutlined />
              </span>
              <Text type="secondary">{t("assistantPanel.agentCitizenHint")}</Text>
            </div>
            <div className="am-form-grid">
              <Input
                value={formState.displayName}
                onChange={(e) => setFormState((current) => ({ ...current, displayName: e.target.value }))}
                placeholder={t("assistantPanel.agentCitizenDisplayNamePlaceholder")}
              />
              <Input
                value={formState.loginKey}
                onChange={(e) => setFormState((current) => ({ ...current, loginKey: e.target.value }))}
                placeholder={t("assistantPanel.agentCitizenLoginKeyPlaceholder")}
              />
              <Select
                value={formState.serverConfigId || undefined}
                onChange={(value) => setFormState((current) => ({ ...current, serverConfigId: value }))}
                placeholder={t("assistantPanel.selectServerConfigPlaceholder")}
                options={availableServerConfigOptions}
              />
            </div>
            <div className="am-agent-fields">
              <div className="am-field-block">
                <Text type="secondary" className="am-invite-label">
                  {t("agentCitizenPanel.roleSummaryLabel")}
                </Text>
                <Input
                  value={formState.roleSummary}
                  onChange={(e) => setFormState((current) => ({ ...current, roleSummary: e.target.value }))}
                  placeholder={t("agentCitizenPanel.roleSummaryPlaceholder")}
                  maxLength={160}
                />
              </div>
              <div className="am-field-block">
                <Text type="secondary" className="am-invite-label">
                  {t("agentCitizenPanel.instructionsLabel")}
                </Text>
                <TextArea
                  value={formState.instructions}
                  onChange={(e) => setFormState((current) => ({ ...current, instructions: e.target.value }))}
                  placeholder={t("agentCitizenPanel.instructionsPlaceholder")}
                  autoSize={{ minRows: 5, maxRows: 10 }}
                />
              </div>
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
                loading={submitting}
                onClick={() => void handleSubmit()}
                icon={<PlusOutlined />}
                className="am-create-btn"
                disabled={!formState.serverConfigId || !formState.displayName.trim() || !formState.loginKey.trim()}
              >
                {editingCitizenId ? t("agentCitizenPanel.save") : t("assistantPanel.agentCitizenCreate")}
              </Button>
            </div>
            <Text type="secondary" className="am-invite-tip">
              {t("assistantPanel.agentCitizenTip")}
            </Text>
          </div>
        </div>
      </div>
    </Modal>
  );
}
