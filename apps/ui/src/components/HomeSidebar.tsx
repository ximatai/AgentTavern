import { useState } from "react";
import { Button, Card, Tag, Typography } from "antd";
import { MessageOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";

import { toast } from "../lib/feedback";
import { useRoomStore } from "../stores/room";
import { usePrincipalStore } from "../stores/principal";
import { LoginModal } from "./LoginModal";

import "../styles/home.css";

const { Title, Paragraph, Text } = Typography;

export function HomeSidebar() {
  const { t } = useTranslation();
  const lobbyPrincipals = useRoomStore((s) => s.lobbyPrincipals);
  const principal = usePrincipalStore((s) => s.principal);
  const [loginOpen, setLoginOpen] = useState(false);
  const [actioningPrincipalId, setActioningPrincipalId] = useState<string | null>(null);

  const visiblePrincipals = lobbyPrincipals
    .filter((item) => (item.principalId ?? item.id) !== principal?.principalId)
    .slice(0, 6);

  async function handleStartDirectRoom(targetPrincipalId: string) {
    if (!principal) {
      setLoginOpen(true);
      return;
    }

    setActioningPrincipalId(targetPrincipalId);
    try {
      await useRoomStore.getState().startDirectRoom(targetPrincipalId);
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
          <Text type="secondary">{principal ? t("home.identityReady") : t("home.identityMissing")}</Text>
        </div>
        <div className="home-side-cards">
          <Card size="small" variant="borderless" className="home-side-card">
            <Tag color={principal?.kind === "agent" ? "geekblue" : "green"} className="home-step-badge">
              {principal ? (principal.kind === "agent" ? t("home.kindAgent") : t("home.kindHuman")) : t("header.loginButton")}
            </Tag>
            <strong>{principal?.globalDisplayName ?? t("home.identityMissing")}</strong>
            <Paragraph type="secondary" className="home-side-card-desc">
              {principal?.loginKey ?? t("home.identityMissingHint")}
            </Paragraph>
            {principal ? (
              <Button block size="small" onClick={() => setLoginOpen(true)}>
                {t("home.secondaryActionEditIdentity")}
              </Button>
            ) : null}
          </Card>
        </div>
      </section>

      {principal ? (
        <section className="home-side-section">
          <div className="home-side-header">
            <Title level={5}>{t("home.lobbyTitle")}</Title>
            <Text type="secondary">
              {t("home.sidebarSnapshotOnline", { count: lobbyPrincipals.length })}
            </Text>
          </div>
          <div className="home-side-cards">
            {visiblePrincipals.map((item) => (
              <Card key={item.id} size="small" variant="borderless" className="home-side-card">
                <Tag color="success" className="home-step-badge">
                  {item.kind === "agent" ? t("home.kindAgent") : t("home.kindHuman")}
                </Tag>
                <strong>
                  {item.globalDisplayName}
                </strong>
                <Text type="secondary" className="home-side-card-desc">
                  {item.loginKey}
                </Text>
                <Button
                  block
                  size="small"
                  icon={<MessageOutlined />}
                  loading={actioningPrincipalId === (item.principalId ?? item.id)}
                  onClick={() => void handleStartDirectRoom(item.principalId ?? item.id)}
                >
                  {t("onlineMembers.startChat")}
                </Button>
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
