import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingOutlined, RobotOutlined, LoginOutlined, PlusOutlined, ShareAltOutlined } from "@ant-design/icons";

import { toast } from "../lib/feedback";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { LoginModal } from "./LoginModal";
import { AssistantManagementModal } from "./AssistantManagementModal";
import { AddLocalAgentModal } from "./AddLocalAgentModal";
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
  const connectionStatus = useConnectionStore((s) => s.status);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [localAgentOpen, setLocalAgentOpen] = useState(false);
  const [copyingRoomInvite, setCopyingRoomInvite] = useState(false);

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

  return (
    <header className="chat-header">
      <ConnectionNotifications />
      <div className="header-left">
        <div className="header-brand">
          {room ? (
            <div className="header-room-line">
              <span className="header-room-name">{room.name}</span>
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
            <button
              type="button"
              className="assistant-badge"
              onClick={() => void handleCopyRoomInvite()}
              disabled={copyingRoomInvite}
            >
              <ShareAltOutlined />
              <span>{copyingRoomInvite ? t("header.copying") : t("header.shareRoom")}</span>
            </button>
            <button type="button" className="assistant-badge" onClick={() => setLocalAgentOpen(true)}>
              <PlusOutlined />
              <span>{t("header.addLocalAgent")}</span>
            </button>
            <AddLocalAgentModal
              open={localAgentOpen}
              onClose={() => setLocalAgentOpen(false)}
            />
          </>
        )}
        <ThemeSwitcher />
        <LanguageSwitcher />
        <IdentitySection />
      </div>
    </header>
  );
}
