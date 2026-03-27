import { useEffect, useState } from "react";
import { Card, Tag, Typography } from "antd";
import {
  UserOutlined,
  RobotOutlined,
  HistoryOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";

import { useRoomStore } from "../stores/room";
import { usePrincipalStore } from "../stores/principal";
import { getPrivateAssistants } from "../api/assistants";

import "../styles/home.css";

const { Title, Paragraph, Text } = Typography;

export function HomeStage() {
  const { t } = useTranslation();
  const lobbyPrincipals = useRoomStore((s) => s.lobbyPrincipals);
  const recentRooms = useRoomStore((s) => s.recentRooms);
  const principal = usePrincipalStore((s) => s.principal);
  const [assistantCount, setAssistantCount] = useState(0);

  useEffect(() => {
    useRoomStore.getState().refreshLobbyPresence();
  }, []);

  useEffect(() => {
    if (!principal) {
      setAssistantCount(0);
      return;
    }
    getPrivateAssistants(principal.principalId, principal.principalToken)
      .then((list) => setAssistantCount(list.length))
      .catch(() => setAssistantCount(0));
  }, [principal]);

  return (
    <div className="home-stage">
      {/* Hero Card */}
      <Card className="home-hero-card" bordered={false}>
        <Text type="secondary" className="home-eyebrow">
          {t("home.eyebrow")}
        </Text>
        <Title level={2} className="home-hero-title">
          {t("home.heroTitle")}
        </Title>
        <Paragraph type="secondary" className="home-hero-desc">
          {t("home.heroDescription")}
        </Paragraph>
      </Card>

      {/* Step Cards */}
      <div className="home-steps-grid">
        <Card className="home-step-card" bordered={false}>
          <Tag color="warning" className="home-step-badge">
            {t("home.step1Badge")}
          </Tag>
          <Title level={4}>{t("home.step1Title")}</Title>
          <Paragraph type="secondary">{t("home.step1Description")}</Paragraph>
        </Card>
        <Card className="home-step-card" bordered={false}>
          <Tag color="success" className="home-step-badge">
            {t("home.step2Badge")}
          </Tag>
          <Title level={4}>{t("home.step2Title")}</Title>
          <Paragraph type="secondary">{t("home.step2Description")}</Paragraph>
        </Card>
        <Card className="home-step-card" bordered={false}>
          <Tag color="cyan" className="home-step-badge">
            {t("home.step3Badge")}
          </Tag>
          <Title level={4}>{t("home.step3Title")}</Title>
          <Paragraph type="secondary">{t("home.step3Description")}</Paragraph>
        </Card>
      </div>

      {/* Stats Row */}
      <div className="home-stats-row">
        <Card className="home-stat-card" bordered={false}>
          <UserOutlined className="home-stat-icon" />
          <div className="home-stat-value">{lobbyPrincipals.length}</div>
          <Text type="secondary">{t("home.statsOnline")}</Text>
        </Card>
        <Card className="home-stat-card" bordered={false}>
          <RobotOutlined className="home-stat-icon" />
          <div className="home-stat-value">{assistantCount}</div>
          <Text type="secondary">{t("home.statsAssistants")}</Text>
        </Card>
        <Card className="home-stat-card" bordered={false}>
          <HistoryOutlined className="home-stat-icon" />
          <div className="home-stat-value">{recentRooms.length}</div>
          <Text type="secondary">{t("home.statsRecentRooms")}</Text>
        </Card>
      </div>
    </div>
  );
}
