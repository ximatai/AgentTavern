import { useCallback, useEffect, useState } from "react";
import { Modal, Input, Button, Typography, Tag, Select } from "antd";
import { ApiOutlined, DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";

import { toast } from "../lib/feedback";
import { useCitizenStore } from "../stores/citizen";
import {
  createServerConfig,
  getMyServerConfigs,
  getSharedServerConfigs,
  removeServerConfig,
  testServerConfig,
  updateServerConfig,
} from "../api/server-configs";
import type { ServerConfigRecord, SharedServerConfigRecord } from "../api/server-configs";

import "../styles/assistant-management.css";

const { Text } = Typography;

function sortByCreatedAt<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function backendTypeLabel(type: string, t: (key: string) => string): string {
  if (type === "openai_compatible") return t("login.backendOpenAICompatible");
  return type;
}

function visibilityLabel(visibility: "private" | "shared", t: (key: string) => string): string {
  return t(`assistantPanel.serverConfigVisibility.${visibility}`);
}

function renderServerConfigSummary(
  config: Pick<ServerConfigRecord, "config"> | Pick<SharedServerConfigRecord, "config">,
): string {
  return `${config.config.model} · ${config.config.baseUrl}`;
}

interface ServerConfigManagementModalProps {
  open: boolean;
  onClose: () => void;
}

export function ServerConfigManagementModal({
  open,
  onClose,
}: ServerConfigManagementModalProps) {
  const { t } = useTranslation();
  const principal = useCitizenStore((s) => s.principal);
  const [serverConfigs, setServerConfigs] = useState<ServerConfigRecord[]>([]);
  const [sharedServerConfigs, setSharedServerConfigs] = useState<SharedServerConfigRecord[]>([]);
  const [serverConfigNameInput, setServerConfigNameInput] = useState("");
  const [serverConfigBaseUrl, setServerConfigBaseUrl] = useState("");
  const [serverConfigModel, setServerConfigModel] = useState("");
  const [serverConfigApiKey, setServerConfigApiKey] = useState("");
  const [serverConfigVisibility, setServerConfigVisibility] = useState<"private" | "shared">("private");
  const [creatingServerConfig, setCreatingServerConfig] = useState(false);
  const [testingServerConfig, setTestingServerConfig] = useState(false);
  const [removingServerConfigId, setRemovingServerConfigId] = useState<string | null>(null);
  const [updatingServerConfigId, setUpdatingServerConfigId] = useState<string | null>(null);

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

  async function handleCreateServerConfig() {
    const name = serverConfigNameInput.trim();
    const baseUrl = serverConfigBaseUrl.trim();
    const model = serverConfigModel.trim();
    if (!principal || !name || !baseUrl || !model) return;

    setCreatingServerConfig(true);
    try {
      const created = await createServerConfig({
        citizenId: principal.citizenId,
        citizenToken: principal.citizenToken,
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
      setServerConfigNameInput("");
      setServerConfigBaseUrl("");
      setServerConfigModel("");
      setServerConfigApiKey("");
      setServerConfigVisibility("private");
      toast().success(t("assistantPanel.createConfigSuccess"));
    } catch (err) {
      toast().error(err instanceof Error ? err.message : t("assistantPanel.createConfigFailed"));
    } finally {
      setCreatingServerConfig(false);
    }
  }

  async function handleTestServerConfig() {
    const baseUrl = serverConfigBaseUrl.trim();
    const model = serverConfigModel.trim();
    if (!principal || !baseUrl || !model) return;

    setTestingServerConfig(true);
    try {
      await testServerConfig({
        citizenId: principal.citizenId,
        citizenToken: principal.citizenToken,
        backendType: "openai_compatible",
        config: {
          baseUrl,
          model,
          ...(serverConfigApiKey.trim() ? { apiKey: serverConfigApiKey.trim() } : {}),
        },
      });
      toast().success(t("assistantPanel.testConfigSuccess"));
    } catch (err) {
      toast().error(err instanceof Error ? err.message : t("assistantPanel.testConfigFailed"));
    } finally {
      setTestingServerConfig(false);
    }
  }

  async function handleToggleServerConfigVisibility(config: ServerConfigRecord) {
    if (!principal) return;

    setUpdatingServerConfigId(config.id);
    try {
      const updated = await updateServerConfig({
        configId: config.id,
        citizenId: principal.citizenId,
        citizenToken: principal.citizenToken,
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
          await removeServerConfig(config.id, principal.citizenId, principal.citizenToken);
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

  return (
    <Modal
      title={t("resourcePanel.title")}
      open={open}
      onCancel={onClose}
      footer={null}
      destroyOnHidden
      width={680}
      className="assistant-management-modal"
    >
      <div className="am-panel">
        <div className="am-panel-summary">
          <Text type="secondary">{t("resourcePanel.summary")}</Text>
        </div>

        <div className="am-invite-section">
          <Text type="secondary" className="am-invite-label">
            {t("resourcePanel.existingTitle")}
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
                      <Tag className="am-backend-tag">{backendTypeLabel(config.backendType, t)}</Tag>
                      <Tag className="am-status-tag">
                        {visibilityLabel(config.visibility, t)}
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
                {t("resourcePanel.sharedTitle")}
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
                        <Tag className="am-backend-tag">{backendTypeLabel(config.backendType, t)}</Tag>
                        <Tag className="am-status-tag">
                          {visibilityLabel(config.visibility, t)}
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
            {t("resourcePanel.createTitle")}
          </Text>
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
                { value: "private", label: t("assistantPanel.serverConfigVisibility.private") },
                { value: "shared", label: t("assistantPanel.serverConfigVisibility.shared") },
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
              loading={testingServerConfig}
              onClick={() => void handleTestServerConfig()}
              disabled={!principal || !serverConfigBaseUrl.trim() || !serverConfigModel.trim()}
            >
              {t("assistantPanel.testConfig")}
            </Button>
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
      </div>
    </Modal>
  );
}
