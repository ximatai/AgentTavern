import { Card, Tag, Typography } from "antd";
import { useTranslation } from "react-i18next";

import { useRoomStore } from "../stores/room";
import { usePrincipalStore } from "../stores/principal";

import "../styles/home.css";

const { Title, Paragraph, Text } = Typography;

export function HomeSidebar() {
  const { t } = useTranslation();
  const lobbyPrincipals = useRoomStore((s) => s.lobbyPrincipals);
  const principal = usePrincipalStore((s) => s.principal);

  const visiblePrincipals = lobbyPrincipals.slice(0, 4);

  return (
    <div className="home-sidebar-content">
      {/* 首页提示 */}
      <section className="home-side-section">
        <div className="home-side-header">
          <Title level={5}>{t("home.sidebarTipsTitle")}</Title>
          <Text type="secondary">{t("home.sidebarTipsBefore")}</Text>
        </div>
        <div className="home-side-cards">
          <Card size="small" variant="borderless" className="home-side-card">
            <Tag color="warning" className="home-step-badge">
              {t("home.step1Badge")}
            </Tag>
            <strong>{t("home.step1Title")}</strong>
            <Paragraph type="secondary" className="home-side-card-desc">
              {t("home.step1Description")}
            </Paragraph>
          </Card>
          <Card size="small" variant="borderless" className="home-side-card">
            <Tag color="success" className="home-step-badge">
              {t("home.step2Badge")}
            </Tag>
            <strong>{t("home.step2Title")}</strong>
            <Paragraph type="secondary" className="home-side-card-desc">
              {t("home.step2Description")}
            </Paragraph>
          </Card>
        </div>
      </section>

      {/* 在线快照 */}
      <section className="home-side-section">
        <div className="home-side-header">
          <Title level={5}>{t("home.sidebarSnapshotTitle")}</Title>
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
                {(item.principalId ?? item.id) === principal?.principalId
                  ? ` (${t("onlineMembers.self")})`
                  : ""}
              </strong>
              <Text type="secondary" className="home-side-card-desc">
                {item.loginKey}
              </Text>
            </Card>
          ))}
          {visiblePrincipals.length === 0 && (
            <Text type="secondary" className="home-side-empty">
              {t("home.sidebarSnapshotEmpty")}
            </Text>
          )}
        </div>
      </section>
    </div>
  );
}
