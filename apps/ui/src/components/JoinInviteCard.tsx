import { useEffect, useMemo, useState } from "react";
import { Button, Card, Tag, Typography } from "antd";
import { UserAddOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";

import { toast } from "../lib/feedback";
import { getRoomInvite } from "../api/rooms";
import type { RoomInviteRecord } from "../api/rooms";
import { usePrincipalStore } from "../stores/principal";
import { useRoomStore } from "../stores/room";

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

  const inviteTitle = useMemo(() => invite?.name ?? t("inviteEntry.unknownRoom"), [invite, t]);

  async function handleJoin() {
    if (!principal) return;

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
          {t("inviteEntry.descRegistered", { name: principal?.globalDisplayName ?? "" })}
        </Paragraph>
        <div className="home-hero-actions">
          <Button
            type="primary"
            icon={<UserAddOutlined />}
            loading={joining || loadingInvite}
            disabled={!invite || loadingInvite}
            onClick={() => void handleJoin()}
          >
            {t("inviteEntry.joinNow")}
          </Button>
          {invite ? <Tag color="cyan">{t("inviteEntry.roomTag", { room: invite.name })}</Tag> : null}
        </div>
      </Card>
    </>
  );
}
