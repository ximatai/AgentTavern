import { useState } from "react";
import { Button, Card, Tag, Tooltip, Typography } from "antd";
import { MessageOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";

import { toast } from "../lib/feedback";
import { maskLoginKey } from "../lib/identity";
import { useRoomStore } from "../stores/room";
import { useCitizenStore } from "../stores/citizen";
import { LoginModal } from "./LoginModal";

import "../styles/home.css";

const { Title, Paragraph, Text } = Typography;

export function HomeSidebar() {
  const { t } = useTranslation();
  const lobbyCitizens = useRoomStore((s) => s.lobbyCitizens);
  const principal = useCitizenStore((s) => s.principal);
  const [loginOpen, setLoginOpen] = useState(false);
  const [actioningPrincipalId, setActioningPrincipalId] = useState<string | null>(null);

  const visiblePrincipals = lobbyCitizens
    .filter((item) => (item.citizenId ?? item.id) !== principal?.citizenId)
    .slice(0, 6);

  async function handleStartDirectRoom(targetCitizenId: string) {
    if (!principal) {
      setLoginOpen(true);
      return;
    }

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
      <section className="home-side-section">
        <div className="home-side-header">
          <Title level={5}>{t("home.identityTitle")}</Title>
        </div>
        <div className="home-side-cards">
          <Card size="small" variant="borderless" className="home-side-card">
            {principal ? (
              <>
                <div className="home-side-card-topline">
                  <Tag color={principal.kind === "agent" ? "geekblue" : "green"} className="home-step-badge">
                    {principal.kind === "agent" ? t("home.kindAgent") : t("home.kindHuman")}
                  </Tag>
                </div>
                <strong className="home-side-card-title">{principal.globalDisplayName}</strong>
                <Paragraph type="secondary" className="home-side-card-desc">
                  {principal.loginKey}
                </Paragraph>
              </>
            ) : (
              <>
                <div className="home-side-card-topline">
                  <Tag color="default" className="home-step-badge">
                    {t("header.loginButton")}
                  </Tag>
                </div>
                <strong className="home-side-card-title">{t("home.identityMissing")}</strong>
                <Paragraph type="secondary" className="home-side-card-desc">
                  {t("home.identityMissingHint")}
                </Paragraph>
              </>
            )}
            {principal ? (
              <Tooltip title={t("home.secondaryActionEditIdentity")}>
                <Button
                  block
                  size="small"
                  className="home-side-card-action"
                  onClick={() => setLoginOpen(true)}
                >
                  {t("home.secondaryActionEditIdentity")}
                </Button>
              </Tooltip>
            ) : null}
          </Card>
        </div>
      </section>

      {principal ? (
        <section className="home-side-section">
          <div className="home-side-header">
            <Title level={5}>{t("home.lobbyTitle")}</Title>
            <Text type="secondary">{t("home.sidebarSnapshotOnline", { count: lobbyCitizens.length })}</Text>
          </div>
          <div className="home-side-cards">
            {visiblePrincipals.map((item) => (
              <Card key={item.id} size="small" variant="borderless" className="home-side-card">
                <div className="home-side-card-topline">
                  <Tag color={item.kind === "agent" ? "cyan" : "green"} className="home-step-badge">
                    {item.kind === "agent" ? t("home.kindAgent") : t("home.kindHuman")}
                  </Tag>
                  {item.runtimeStatus ? (
                    <Tag className="home-side-runtime-tag">{t(`runtimeStatus.${item.runtimeStatus}`)}</Tag>
                  ) : null}
                </div>
                <strong className="home-side-card-title">{item.globalDisplayName}</strong>
                <Text type="secondary" className="home-side-card-desc">
                  {maskLoginKey(item.loginKey)}
                </Text>
                <Tooltip title={t("onlineMembers.startChat")}>
                  <Button
                    size="small"
                    shape="circle"
                    className="home-side-icon-action"
                    icon={<MessageOutlined />}
                    loading={actioningPrincipalId === (item.citizenId ?? item.id)}
                    onClick={() => void handleStartDirectRoom(item.citizenId ?? item.id)}
                    aria-label={t("onlineMembers.startChat")}
                  />
                </Tooltip>
              </Card>
            ))}
            {visiblePrincipals.length === 0 && (
              <Text type="secondary" className="home-side-empty">
                {t("home.sidebarSnapshotEmpty")}
              </Text>
            )}
          </div>
        </section>
      ) : null}
      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} />
    </div>
  );
}
