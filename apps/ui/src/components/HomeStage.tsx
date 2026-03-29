import { useEffect, useMemo, useState } from "react";
import { Button, Card, Tag, Typography } from "antd";
import {
  UserOutlined,
  RobotOutlined,
  HistoryOutlined,
  LoginOutlined,
  MessageOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";

import { toast } from "../lib/feedback";
import { useRoomStore } from "../stores/room";
import { usePrincipalStore } from "../stores/principal";
import { getPrivateAssistants } from "../api/assistants";
import { LoginModal } from "./LoginModal";
import { RoomModal } from "./RoomModal";

import "../styles/home.css";

const { Title, Paragraph, Text } = Typography;

interface HomeStageProps {
  inviteToken?: string | null;
}

export function HomeStage({ inviteToken = null }: HomeStageProps) {
  const { t } = useTranslation();
  const lobbyPrincipals = useRoomStore((s) => s.lobbyPrincipals);
  const recentRooms = useRoomStore((s) => s.recentRooms);
  const principal = usePrincipalStore((s) => s.principal);
  const joinRoom = useRoomStore((s) => s.joinRoom);
  const [assistantCount, setAssistantCount] = useState(0);
  const [loginOpen, setLoginOpen] = useState(false);
  const [roomModalOpen, setRoomModalOpen] = useState(false);
  const [actioningPrincipalId, setActioningPrincipalId] = useState<string | null>(null);
  const [invitePromptShown, setInvitePromptShown] = useState(false);
  const [loginPromptShown, setLoginPromptShown] = useState(false);

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

  useEffect(() => {
    if (!inviteToken || principal || invitePromptShown) return;
    setLoginOpen(true);
    setInvitePromptShown(true);
  }, [inviteToken, principal, invitePromptShown]);

  useEffect(() => {
    if (inviteToken || principal || loginPromptShown) return;
    setLoginOpen(true);
    setLoginPromptShown(true);
  }, [inviteToken, principal, loginPromptShown]);

  const visibleLobbyPrincipals = useMemo(
    () => lobbyPrincipals.filter((item) => (item.principalId ?? item.id) !== principal?.principalId),
    [lobbyPrincipals, principal?.principalId],
  );

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

      <div className="home-stats-row">
        <Card className="home-stat-card" variant="borderless">
          <UserOutlined className="home-stat-icon" />
          <div className="home-stat-value">{lobbyPrincipals.length}</div>
          <Text type="secondary">{t("home.statsOnline")}</Text>
        </Card>
        <Card className="home-stat-card" variant="borderless">
          <RobotOutlined className="home-stat-icon" />
          <div className="home-stat-value">{assistantCount}</div>
          <Text type="secondary">{t("home.statsAssistants")}</Text>
        </Card>
        <Card className="home-stat-card" variant="borderless">
          <HistoryOutlined className="home-stat-icon" />
          <div className="home-stat-value">{recentRooms.length}</div>
          <Text type="secondary">{t("home.statsRecentRooms")}</Text>
        </Card>
      </div>

      <div className="home-lobby-grid">
        <Card className="home-lobby-card" variant="borderless">
          <div className="home-section-header">
            <div>
              <Title level={4}>{t("home.lobbyTitle")}</Title>
              <Text type="secondary">
                {principal ? t("home.lobbyHintRegistered") : t("home.lobbyHintAnonymous")}
              </Text>
            </div>
            <Tag color="cyan">{t("home.sidebarSnapshotOnline", { count: lobbyPrincipals.length })}</Tag>
          </div>

          <div className="home-lobby-list">
            {visibleLobbyPrincipals.length === 0 ? (
              <div className="home-lobby-empty">
                <Text type="secondary">{t("home.lobbyEmpty")}</Text>
              </div>
            ) : (
              visibleLobbyPrincipals.map((item) => {
                const principalId = item.principalId ?? item.id;
                const actioning = actioningPrincipalId === principalId;
                return (
                  <div key={item.id} className="home-lobby-item">
                    <div className="home-lobby-meta">
                      <div className="home-lobby-name-row">
                        <strong>{item.globalDisplayName}</strong>
                        <Tag className="home-lobby-kind-tag">
                          {item.kind === "agent" ? t("home.kindAgent") : t("home.kindHuman")}
                        </Tag>
                        {item.runtimeStatus ? (
                          <Tag color="processing">{t(`runtimeStatus.${item.runtimeStatus}`)}</Tag>
                        ) : null}
                      </div>
                      <Text type="secondary">
                        {item.loginKey}
                      </Text>
                    </div>
                    <Button
                      type="primary"
                      icon={<MessageOutlined />}
                      loading={actioning}
                      onClick={() => void handleStartDirectRoom(principalId)}
                    >
                      {principal ? t("onlineMembers.startChat") : t("home.primaryActionRegister")}
                    </Button>
                  </div>
                );
              })
            )}
          </div>
        </Card>

        <Card className="home-identity-card" variant="borderless">
          <div className="home-section-header">
            <div>
              <Title level={4}>{t("home.identityTitle")}</Title>
              <Text type="secondary">
                {principal ? t("home.identityReady") : t("home.identityMissing")}
              </Text>
            </div>
          </div>

          {principal ? (
            <div className="home-identity-body">
              <Tag color={principal.kind === "agent" ? "geekblue" : "green"}>
                {principal.kind === "agent" ? t("home.kindAgent") : t("home.kindHuman")}
              </Tag>
              <Title level={5}>{principal.globalDisplayName}</Title>
              <Text type="secondary">{principal.loginKey}</Text>
              <Button block onClick={() => setLoginOpen(true)}>
                {t("home.secondaryActionEditIdentity")}
              </Button>
            </div>
          ) : (
            <div className="home-identity-body">
              <Paragraph type="secondary">
                {t("home.identityMissingHint")}
              </Paragraph>
              <Button type="primary" block icon={<LoginOutlined />} onClick={() => setLoginOpen(true)}>
                {t("home.primaryActionRegister")}
              </Button>
            </div>
          )}
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
