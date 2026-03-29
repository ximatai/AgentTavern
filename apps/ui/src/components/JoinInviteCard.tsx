import { useEffect, useMemo, useState } from "react";
import { Button, Card, Tag, Typography } from "antd";
import { LoginOutlined, UserAddOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";

import { toast } from "../lib/feedback";
import { getRoomInvite } from "../api/rooms";
import type { RoomInviteRecord } from "../api/rooms";
import { usePrincipalStore } from "../stores/principal";
import { useRoomStore } from "../stores/room";
import { LoginModal } from "./LoginModal";

const { Title, Paragraph, Text } = Typography;

interface JoinInviteCardProps {
  inviteToken: string;
}

export function JoinInviteCard({ inviteToken }: JoinInviteCardProps) {
  const { t } = useTranslation();
  const principal = usePrincipalStore((s) => s.principal);
  const joinRoom = useRoomStore((s) => s.joinRoom);

  const [invite, setInvite] = useState<RoomInviteRecord | null>(null);
  const [loadingInvite, setLoadingInvite] = useState(false);
  const [joining, setJoining] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [pendingJoinAfterLogin, setPendingJoinAfterLogin] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadingInvite(true);
    getRoomInvite(inviteToken)
      .then((payload) => {
        if (!cancelled) {
          setInvite(payload);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          toast().error(error instanceof Error ? error.message : t("inviteEntry.loadFailed"));
          setInvite(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingInvite(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [inviteToken, t]);

  useEffect(() => {
    if (!principal || !pendingJoinAfterLogin) return;
    void handleJoin();
    setPendingJoinAfterLogin(false);
  }, [principal, pendingJoinAfterLogin]);

  const inviteTitle = useMemo(() => invite?.name ?? t("inviteEntry.unknownRoom"), [invite, t]);

  function handleCloseLogin() {
    setLoginOpen(false);
    if (!principal) {
      setPendingJoinAfterLogin(false);
    }
  }

  async function handleJoin() {
    if (!principal) {
      setPendingJoinAfterLogin(true);
      setLoginOpen(true);
      return;
    }

    setJoining(true);
    try {
      await joinRoom(inviteToken);
      window.history.replaceState({}, "", "/");
      toast().success(t("inviteEntry.joinSuccess", { room: inviteTitle }));
    } catch (error) {
      toast().error(error instanceof Error ? error.message : t("inviteEntry.joinFailed"));
    } finally {
      setJoining(false);
    }
  }

  return (
    <>
      <Card className="home-hero-card" variant="borderless">
        <Text type="secondary" className="home-eyebrow">
          {t("inviteEntry.eyebrow")}
        </Text>
        <Title level={2} className="home-hero-title">
          {loadingInvite
            ? t("inviteEntry.loadingTitle")
            : t("inviteEntry.title", { room: inviteTitle })}
        </Title>
        <Paragraph type="secondary" className="home-hero-desc">
          {principal
            ? t("inviteEntry.descRegistered", { name: principal.globalDisplayName })
            : t("inviteEntry.descAnonymous")}
        </Paragraph>
        <div className="home-hero-actions">
          <Button
            type="primary"
            icon={principal ? <UserAddOutlined /> : <LoginOutlined />}
            loading={joining || loadingInvite}
            disabled={!invite || loadingInvite}
            onClick={() => void handleJoin()}
          >
            {principal ? t("inviteEntry.joinNow") : t("inviteEntry.registerAndJoin")}
          </Button>
          {invite ? <Tag color="cyan">{t("inviteEntry.roomTag", { room: invite.name })}</Tag> : null}
        </div>
      </Card>
      <LoginModal open={loginOpen} onClose={handleCloseLogin} />
    </>
  );
}
