import { useEffect, useMemo, useState } from "react";
import { Button, Tag, Tooltip, Typography } from "antd";
import {
  ControlOutlined,
  EditOutlined,
  IdcardOutlined,
  MessageOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";

import { toast } from "../lib/feedback";
import { maskLoginKey } from "../lib/identity";
import { getPrivateAssistants, type PrivateAssistantRecord } from "../api/assistants";
import { useRoomStore } from "../stores/room";
import { useCitizenStore } from "../stores/citizen";
import { LoginModal } from "./LoginModal";
import { AssistantManagementModal } from "./AssistantManagementModal";
import { ServerConfigManagementModal } from "./ServerConfigManagementModal";

import "../styles/home.css";

const { Title, Paragraph, Text } = Typography;

function sortByCreatedAt<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function assistantStatusTone(status: PrivateAssistantRecord["status"]): "cyan" | "gold" | "red" | "default" {
  if (status === "active") return "cyan";
  if (status === "pending_bridge") return "gold";
  if (status === "failed") return "red";
  return "default";
}

function runtimeStatusTone(status: string): "cyan" | "gold" | "default" {
  if (status === "ready") return "cyan";
  if (status === "waiting") return "gold";
  return "default";
}

export function HomeSidebar() {
  const { t } = useTranslation();
  const lobbyCitizens = useRoomStore((s) => s.lobbyCitizens);
  const principal = useCitizenStore((s) => s.principal);
  const privateAssetsVersion = useCitizenStore((s) => s.privateAssetsVersion);

  const [assistants, setAssistants] = useState<PrivateAssistantRecord[]>([]);
  const [loginOpen, setLoginOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [serverConfigOpen, setServerConfigOpen] = useState(false);
  const [actioningPrincipalId, setActioningPrincipalId] = useState<string | null>(null);

  useEffect(() => {
    if (!principal) {
      setAssistants([]);
      return;
    }

    getPrivateAssistants(principal.citizenId, principal.citizenToken)
      .then((items) => setAssistants(sortByCreatedAt(items)))
      .catch(() => setAssistants([]));
  }, [principal, privateAssetsVersion]);

  const visiblePrincipals = useMemo(
    () => lobbyCitizens.filter((item) => (item.citizenId ?? item.id) !== principal?.citizenId),
    [lobbyCitizens, principal?.citizenId],
  );

  const assistantPreview = useMemo(() => assistants.slice(0, 3), [assistants]);
  async function handleStartDirectRoom(targetCitizenId: string) {
    setActioningPrincipalId(targetCitizenId);
    try {
      await useRoomStore.getState().startDirectRoom(targetCitizenId);
    } catch (error) {
      toast().error(
        error instanceof Error ? error.message : t("onlineMembers.startChatFailed"),
      );
    } finally {
      setActioningPrincipalId(null);
    }
  }

  return (
    <div className="home-sidebar-content">
      <section className="home-side-section home-side-workbench">
        <div className="home-side-header">
          <div>
            <Text className="home-side-section-eyebrow">{t("home.sidebarWorkbenchEyebrow")}</Text>
            <Title level={5}>{t("home.sidebarWorkbenchTitle")}</Title>
          </div>
        </div>

        <div className="home-side-identity-card">
          {principal ? (
            <>
              <div className="home-side-identity-head">
                <div className="home-side-identity-main">
                  <div className="home-side-identity-avatar">
                    <UserOutlined />
                  </div>
                  <div className="home-side-identity-copy">
                    <div className="home-side-identity-title-row">
                      <strong className="home-side-card-title">
                        {principal.globalDisplayName}
                      </strong>
                      <Tag color={principal.kind === "agent" ? "geekblue" : "green"}>
                        {principal.kind === "agent" ? t("home.kindAgent") : t("home.kindHuman")}
                      </Tag>
                    </div>
                    <Paragraph type="secondary" className="home-side-card-desc">
                      {maskLoginKey(principal.loginKey)}
                    </Paragraph>
                  </div>
                </div>
                <Tooltip title={t("home.secondaryActionEditIdentity")}>
                  <Button
                    type="text"
                    size="small"
                    shape="circle"
                    className="home-side-icon-action"
                    icon={<EditOutlined />}
                    onClick={() => setLoginOpen(true)}
                    aria-label={t("home.secondaryActionEditIdentity")}
                  />
                </Tooltip>
              </div>

              <div className="home-side-assistant-panel">
                <div className="home-side-assistant-header">
                  <div>
                    <div className="home-side-assistant-title-row">
                      <Text className="home-side-assistant-title">{t("home.sidebarAssistantsTitle")}</Text>
                      <Text type="secondary">{assistants.length}</Text>
                    </div>
                  </div>
                  <Button
                    type="text"
                    size="small"
                    icon={<ControlOutlined />}
                    onClick={() => setAssistantOpen(true)}
                  >
                    {t("home.sidebarManageAssistants")}
                  </Button>
                </div>

                {assistantPreview.length > 0 ? (
                  <div className="home-side-assistant-list">
                    {assistantPreview.map((assistant) => (
                      <div key={assistant.id} className="home-side-assistant-item">
                        <div className="home-side-assistant-meta">
                          <span className="home-side-assistant-name">{assistant.name}</span>
                          <Text type="secondary" className="home-side-assistant-backend">
                            {assistant.backendType}
                          </Text>
                        </div>
                        {assistant.status === "active" ? null : (
                          <Tag color={assistantStatusTone(assistant.status)} className="home-side-runtime-tag">
                            {t(`assistantPanel.assistantStatus.${assistant.status}`)}
                          </Tag>
                        )}
                      </div>
                    ))}
                    {assistants.length > assistantPreview.length ? (
                      <Text type="secondary" className="home-side-assistant-more">
                        {t("home.sidebarAssistantsMore", {
                          count: assistants.length - assistantPreview.length,
                        })}
                      </Text>
                    ) : null}
                  </div>
                ) : (
                  <Text type="secondary" className="home-side-empty">
                    {t("assistantPanel.emptyHint")}
                  </Text>
                )}
              </div>
            </>
          ) : (
            <div className="home-side-workbench-placeholder">
              <div className="home-side-identity-avatar">
                <IdcardOutlined />
              </div>
              <div className="home-side-workbench-placeholder-copy">
                <strong className="home-side-card-title">{t("home.sidebarWorkbenchGuestTitle")}</strong>
                <Paragraph type="secondary" className="home-side-card-desc">
                  {t("home.sidebarWorkbenchGuestHint")}
                </Paragraph>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="home-side-section home-side-members-section">
        <div className="home-side-header">
          <div>
            <Text className="home-side-section-eyebrow">{t("home.sidebarMembersEyebrow")}</Text>
            <Title level={5}>{t("home.lobbyTitle")}</Title>
          </div>
          <Text type="secondary">{t("home.sidebarSnapshotOnline", { count: lobbyCitizens.length })}</Text>
        </div>

        <div className="home-side-lobby-list">
          {visiblePrincipals.length > 0 ? (
            visiblePrincipals.map((item) => {
              const citizenId = item.citizenId ?? item.id;
              const actioning = actioningPrincipalId === citizenId;

              return (
                <div key={item.id} className="home-side-lobby-row">
                  <div className="home-side-lobby-copy">
                    <div className="home-side-lobby-title-row">
                      <strong className="home-side-lobby-name">{item.globalDisplayName}</strong>
                      <span className="home-side-lobby-kind">
                        {item.kind === "agent" ? t("home.kindAgent") : t("home.kindHuman")}
                      </span>
                    </div>
                    <Text type="secondary" className="home-side-lobby-login-key">
                      {maskLoginKey(item.loginKey)}
                    </Text>
                  </div>

                  <div className="home-side-lobby-actions">
                    {item.runtimeStatus ? (
                      <Tag color={runtimeStatusTone(item.runtimeStatus)} className="home-side-runtime-tag">
                        {t(`runtimeStatus.${item.runtimeStatus}`)}
                      </Tag>
                    ) : null}
                    <Tooltip title={principal ? t("onlineMembers.startChat") : t("home.sidebarLobbyActionLocked")}>
                      <Button
                        type="text"
                        size="small"
                        shape="circle"
                        className="home-side-icon-action home-side-row-action"
                        icon={<MessageOutlined />}
                        loading={actioning}
                        disabled={!principal}
                        onClick={() => void handleStartDirectRoom(citizenId)}
                        aria-label={principal ? t("onlineMembers.startChat") : t("home.primaryActionRegister")}
                      />
                    </Tooltip>
                  </div>
                </div>
              );
            })
          ) : (
            <Text type="secondary" className="home-side-empty">
              {principal ? t("home.lobbyEmpty") : t("home.sidebarSnapshotEmpty")}
            </Text>
          )}
        </div>
      </section>

      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} />
      <AssistantManagementModal
        open={assistantOpen}
        onClose={() => setAssistantOpen(false)}
        onOpenModelConnections={() => {
          setAssistantOpen(false);
          setServerConfigOpen(true);
        }}
      />
      <ServerConfigManagementModal
        open={serverConfigOpen}
        onClose={() => setServerConfigOpen(false)}
      />
    </div>
  );
}
