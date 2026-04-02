import { useEffect, useState } from "react";
import { Button, Card, Tag, Typography } from "antd";
import {
  LoginOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";

import { toast } from "../lib/feedback";
import { useRoomStore } from "../stores/room";
import { useCitizenStore } from "../stores/citizen";
import { LoginModal } from "./LoginModal";
import { RoomModal } from "./RoomModal";

import "../styles/home.css";

const { Title, Paragraph, Text } = Typography;

interface HomeStageProps {
  inviteToken?: string | null;
}

export function HomeStage({ inviteToken = null }: HomeStageProps) {
  const { t } = useTranslation();
  const principal = useCitizenStore((s) => s.principal);
  const restoreReady = useCitizenStore((s) => s.restoreReady);
  const joinRoom = useRoomStore((s) => s.joinRoom);
  const [loginOpen, setLoginOpen] = useState(false);
  const [roomModalOpen, setRoomModalOpen] = useState(false);
  const [invitePromptShown, setInvitePromptShown] = useState(false);
  const [loginPromptShown, setLoginPromptShown] = useState(false);

  useEffect(() => {
    useRoomStore.getState().refreshLobbyPresence();
  }, []);

  useEffect(() => {
    if (!restoreReady || !inviteToken || principal || invitePromptShown) return;
    setLoginOpen(true);
    setInvitePromptShown(true);
  }, [inviteToken, principal, invitePromptShown, restoreReady]);

  useEffect(() => {
    if (!restoreReady || inviteToken || principal || loginPromptShown) return;
    setLoginOpen(true);
    setLoginPromptShown(true);
  }, [inviteToken, principal, loginPromptShown, restoreReady]);

  async function handleInviteBootstrap() {
    if (!inviteToken) return;
    await joinRoom(inviteToken);
    window.history.replaceState({}, "", "/");
    toast().success(t("roomModal.joinSuccess"));
  }

  return (
    <div className="home-stage">
      <Card className="home-hero-card" variant="borderless">
        <Text type="secondary" className="home-eyebrow">
          {t("home.eyebrow")}
        </Text>
        <Title level={2} className="home-hero-title">
          {t("home.heroTitle")}
        </Title>
        <Paragraph type="secondary" className="home-hero-desc">
          {t("home.heroDescription")}
        </Paragraph>
        <div className="home-hero-actions">
          {principal ? (
            <>
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setRoomModalOpen(true)}>
                {t("home.primaryActionCreateRoom")}
              </Button>
              <Button onClick={() => setLoginOpen(true)}>{t("home.secondaryActionEditIdentity")}</Button>
            </>
          ) : (
            <>
              <Button type="primary" icon={<LoginOutlined />} onClick={() => setLoginOpen(true)}>
                {t("home.primaryActionRegister")}
              </Button>
              <Button onClick={() => setRoomModalOpen(true)}>{t("home.secondaryActionJoinRoom")}</Button>
            </>
          )}
        </div>
      </Card>

      <div className="home-steps-grid">
        <Card className="home-step-card" variant="borderless">
          <Tag color="warning" className="home-step-badge">
            {t("home.step1Badge")}
          </Tag>
          <Title level={4}>{t("home.step1Title")}</Title>
          <Paragraph type="secondary">{t("home.step1Description")}</Paragraph>
        </Card>
        <Card className="home-step-card" variant="borderless">
          <Tag color="success" className="home-step-badge">
            {t("home.step2Badge")}
          </Tag>
          <Title level={4}>{t("home.step2Title")}</Title>
          <Paragraph type="secondary">{t("home.step2Description")}</Paragraph>
        </Card>
        <Card className="home-step-card" variant="borderless">
          <Tag color="cyan" className="home-step-badge">
            {t("home.step3Badge")}
          </Tag>
          <Title level={4}>{t("home.step3Title")}</Title>
          <Paragraph type="secondary">{t("home.step3Description")}</Paragraph>
        </Card>
      </div>

      <LoginModal
        open={loginOpen}
        onClose={() => setLoginOpen(false)}
        inviteToken={inviteToken}
        afterBootstrap={inviteToken ? handleInviteBootstrap : undefined}
      />
      <RoomModal open={roomModalOpen} onClose={() => setRoomModalOpen(false)} />
    </div>
  );
}
