import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingOutlined, RobotOutlined, LoginOutlined, ShareAltOutlined, TeamOutlined, DeleteOutlined, SwapOutlined, LogoutOutlined } from "@ant-design/icons";
import { Modal, Select } from "antd";

import { toast } from "../lib/feedback";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { LoginModal } from "./LoginModal";
import { AssistantManagementModal } from "./AssistantManagementModal";
import { RoomSecretaryModal } from "./RoomSecretaryModal";
import { usePrincipalStore } from "../stores/principal";
import { useConnectionStore } from "../stores/connection";
import { useRoomStore } from "../stores/room";

import "../styles/header.css";

function ConnectionNotifications() {
  const { t } = useTranslation();
  const status = useConnectionStore((s) => s.status);
  const prevStatus = useRef(status);

  useEffect(() => {
    const previousStatus = prevStatus.current;
    if (previousStatus === status) return;
    prevStatus.current = status;

    if (status === "disconnected" && previousStatus === "connected") {
      toast().warning(t("header.connectionLost"));
    } else if (status === "connected" && previousStatus === "disconnected") {
      toast().success(t("header.connectionRestored"));
    }
  }, [status, t]);

  return null;
}

function IdentitySection() {
  const { t } = useTranslation();
  const principal = usePrincipalStore((s) => s.principal);
  const [loginOpen, setLoginOpen] = useState(false);

  if (!principal) {
    return (
      <>
        <button
          type="button"
          className="login-button"
          onClick={() => setLoginOpen(true)}
        >
          <LoginOutlined />
          <span>{t("header.loginButton")}</span>
        </button>
        <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} />
      </>
    );
  }

  const initial = (principal.globalDisplayName || principal.loginKey || "?")
    .charAt(0)
    .toUpperCase();

  return (
    <>
      <div className="identity-button" onClick={() => setLoginOpen(true)}>
        <div className="identity-avatar">
          <span className="identity-avatar-text">{initial}</span>
        </div>
        <div className="identity-info">
          <span className="identity-name">
            {principal.globalDisplayName || principal.loginKey}
          </span>
          <div className="identity-actions">
            <span className="identity-action">
              <SettingOutlined style={{ fontSize: 12 }} />
              <span>{t("header.editProfile")}</span>
            </span>
          </div>
        </div>
      </div>
      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} />
    </>
  );
}

export function Header() {
  const { t } = useTranslation();
  const principal = usePrincipalStore((s) => s.principal);
  const room = useRoomStore((s) => s.room);
  const self = useRoomStore((s) => s.self);
  const members = useRoomStore((s) => s.members);
  const disbandRoom = useRoomStore((s) => s.disbandRoom);
  const leaveRoom = useRoomStore((s) => s.leaveRoom);
  const transferRoomOwnership = useRoomStore((s) => s.transferRoomOwnership);
  const connectionStatus = useConnectionStore((s) => s.status);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [secretaryOpen, setSecretaryOpen] = useState(false);
  const [copyingRoomInvite, setCopyingRoomInvite] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [pendingOwnerMemberId, setPendingOwnerMemberId] = useState<string | null>(null);
  const [transferLoading, setTransferLoading] = useState(false);
  const secretaryMember = room?.secretaryMemberId
    ? members.find((member) => member.id === room.secretaryMemberId) ?? null
    : null;
  const isRoomOwner = !!room && !!self && room.ownerMemberId === self.memberId;
  const transferCandidates = useMemo(
    () =>
      members.filter((member) => member.type === "human" && member.id !== self?.memberId),
    [members, self?.memberId],
  );

  const handleCopyRoomInvite = async () => {
    if (!room) return;

    setCopyingRoomInvite(true);
    try {
      const shareUrl = new URL(`/join/${room.inviteToken}`, window.location.origin).toString();
      await navigator.clipboard.writeText(shareUrl);
      toast().success(t("header.roomInviteCopied"));
    } catch (error) {
      toast().error(
        error instanceof Error ? error.message : t("header.roomInviteCopyFailed"),
      );
    } finally {
      setCopyingRoomInvite(false);
    }
  };

  const handleDisbandRoom = () => {
    if (!room) return;

    Modal.confirm({
      title: t("header.disbandRoomTitle"),
      content: t("header.disbandRoomConfirm", { roomName: room.name }),
      okText: t("header.disbandRoomAction"),
      okButtonProps: { danger: true },
      cancelText: t("common.cancel"),
      onOk: async () => {
        try {
          await disbandRoom();
          toast().success(t("header.disbandRoomSuccess"));
        } catch (error) {
          toast().error(
            error instanceof Error ? error.message : t("header.disbandRoomFailed"),
          );
        }
      },
    });
  };

  const handleTransferOwnership = async () => {
    if (!pendingOwnerMemberId) return;
    setTransferLoading(true);
    try {
      await transferRoomOwnership(pendingOwnerMemberId);
      toast().success(t("header.transferOwnerSuccess"));
      setTransferOpen(false);
      setPendingOwnerMemberId(null);
    } catch (error) {
      toast().error(
        error instanceof Error ? error.message : t("header.transferOwnerFailed"),
      );
    } finally {
      setTransferLoading(false);
    }
  };

  const handleLeaveRoom = () => {
    if (!room) return;

    if (isRoomOwner) {
      if (transferCandidates.length === 0) {
        Modal.confirm({
          title: t("header.ownerMustDisbandTitle"),
          content: t("header.ownerMustDisbandBody"),
          okText: t("header.disbandRoomAction"),
          okButtonProps: { danger: true },
          cancelText: t("common.cancel"),
          onOk: async () => {
            try {
              await disbandRoom();
              toast().success(t("header.disbandRoomSuccess"));
            } catch (error) {
              toast().error(
                error instanceof Error ? error.message : t("header.disbandRoomFailed"),
              );
            }
          },
        });
        return;
      }

      setPendingOwnerMemberId(transferCandidates[0]?.id ?? null);
      setTransferOpen(true);
      return;
    }

    Modal.confirm({
      title: t("header.leaveRoomTitle"),
      content: t("header.leaveRoomConfirm", { roomName: room.name }),
      okText: t("header.leaveRoomAction"),
      cancelText: t("common.cancel"),
      onOk: async () => {
        try {
          await leaveRoom();
          toast().success(t("header.leaveRoomSuccess"));
        } catch (error) {
          toast().error(
            error instanceof Error ? error.message : t("header.leaveRoomFailed"),
          );
        }
      },
    });
  };

  return (
    <header className="chat-header">
      <ConnectionNotifications />
      <div className="header-left">
        <div className="header-brand">
          {room ? (
            <div className="header-room-line">
              <span className="header-room-name">{room.name}</span>
              {room.secretaryMode !== "off" ? (
                <span className="header-room-status">
                  {t("header.secretaryStatus", {
                    mode:
                      room.secretaryMode === "coordinate_and_summarize"
                        ? t("header.secretaryModeCoordinateAndSummarize")
                        : t("header.secretaryModeCoordinate"),
                    name: secretaryMember?.displayName ?? t("header.secretaryUnknown"),
                  })}
                </span>
              ) : null}
              {connectionStatus === "disconnected" ? (
                <span className="header-room-status is-disconnected">
                  {t("header.connectionDisconnected")}
                </span>
              ) : null}
            </div>
          ) : (
            <>
              <span className="header-brand-name">AgentTavern</span>
              <span className="header-brand-subtitle">
                {t("header.subtitle")}
              </span>
            </>
          )}
        </div>
      </div>
      <div className="header-right">
        {principal && (
          <>
            <button type="button" className="assistant-badge" onClick={() => setAssistantOpen(true)}>
              <RobotOutlined />
              <span>{t("header.assistants")}</span>
            </button>
            <AssistantManagementModal
              open={assistantOpen}
              onClose={() => setAssistantOpen(false)}
            />
          </>
        )}
        {self && (
          <>
            {isRoomOwner ? (
              <button type="button" className="assistant-badge" onClick={() => setSecretaryOpen(true)}>
                <TeamOutlined />
                <span>{t("header.secretary")}</span>
              </button>
            ) : null}
            <button
              type="button"
              className="assistant-badge"
              onClick={() => void handleCopyRoomInvite()}
              disabled={copyingRoomInvite}
            >
              <ShareAltOutlined />
              <span>{copyingRoomInvite ? t("header.copying") : t("header.shareRoom")}</span>
            </button>
            {isRoomOwner && transferCandidates.length > 0 ? (
              <button
                type="button"
                className="assistant-badge"
                onClick={() => {
                  setPendingOwnerMemberId(transferCandidates[0]?.id ?? null);
                  setTransferOpen(true);
                }}
              >
                <SwapOutlined />
                <span>{t("header.transferOwner")}</span>
              </button>
            ) : null}
            {isRoomOwner ? (
              <button
                type="button"
                className="assistant-badge"
                onClick={handleDisbandRoom}
              >
                <DeleteOutlined />
                <span>{t("header.disbandRoom")}</span>
              </button>
            ) : null}
            <button
              type="button"
              className="assistant-badge"
              onClick={handleLeaveRoom}
            >
              <LogoutOutlined />
              <span>{t("header.leaveRoom")}</span>
            </button>
          </>
        )}
        <ThemeSwitcher />
        <LanguageSwitcher />
        <IdentitySection />
      </div>
      <RoomSecretaryModal open={secretaryOpen} onClose={() => setSecretaryOpen(false)} />
      <Modal
        title={t("header.transferOwnerTitle")}
        open={transferOpen}
        onCancel={() => {
          setTransferOpen(false);
          setPendingOwnerMemberId(null);
        }}
        onOk={() => void handleTransferOwnership()}
        okText={t("header.transferOwnerAction")}
        confirmLoading={transferLoading}
      >
        <p>{t("header.transferOwnerConfirm", { roomName: room?.name ?? "" })}</p>
        <Select
          style={{ width: "100%" }}
          value={pendingOwnerMemberId ?? undefined}
          onChange={(value) => setPendingOwnerMemberId(value)}
          options={transferCandidates.map((member) => ({
            value: member.id,
            label: member.displayName,
          }))}
        />
        <p style={{ marginTop: 12 }}>
          {t("header.transferOwnerLeaveHint")}
        </p>
        <button
          type="button"
          className="assistant-badge"
          onClick={() => void (async () => {
            if (!pendingOwnerMemberId) return;
            await handleTransferOwnership();
            try {
              await leaveRoom();
              toast().success(t("header.leaveRoomSuccess"));
            } catch (error) {
              toast().error(
                error instanceof Error ? error.message : t("header.leaveRoomFailed"),
              );
            }
          })()}
          disabled={transferLoading || !pendingOwnerMemberId}
        >
          <LogoutOutlined />
          <span>{t("header.transferAndLeave")}</span>
        </button>
      </Modal>
    </header>
  );
}
