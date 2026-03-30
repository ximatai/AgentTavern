import { useState, useCallback, useEffect } from "react";
import { Modal, Input, Form, Typography } from "antd";
import { LogoutOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";

import { toast } from "../lib/feedback";
import { getRoomInvite } from "../api/rooms";
import type { RoomInviteRecord } from "../api/rooms";
import { usePrincipalStore } from "../stores/principal";
import { useRoomStore } from "../stores/room";
import { useMessageStore } from "../stores/message";

const { Paragraph, Text } = Typography;

interface LoginModalProps {
  open: boolean;
  onClose: () => void;
  inviteToken?: string | null;
  afterBootstrap?: () => Promise<void>;
}

export function LoginModal({ open, onClose, inviteToken = null, afterBootstrap }: LoginModalProps) {
  const { t } = useTranslation();
  const principal = usePrincipalStore((s) => s.principal);
  const bootstrap = usePrincipalStore((s) => s.bootstrap);
  const logout = usePrincipalStore((s) => s.logout);
  const resetRoom = useRoomStore((s) => s.reset);
  const refreshLobbyPresence = useRoomStore((s) => s.refreshLobbyPresence);
  const resetMessage = useMessageStore((s) => s.reset);

  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [invite, setInvite] = useState<RoomInviteRecord | null>(null);

  const isLoggedIn = !!principal;
  const isHumanFirstRun = !isLoggedIn;

  useEffect(() => {
    let cancelled = false;

    if (!open || !inviteToken) {
      setInvite(null);
      return;
    }

    getRoomInvite(inviteToken)
      .then((payload) => {
        if (!cancelled) {
          setInvite(payload);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setInvite(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, inviteToken]);

  useEffect(() => {
    if (open && isLoggedIn && principal) {
      form.setFieldsValue({
        globalDisplayName: principal.globalDisplayName,
        loginKey: principal.loginKey,
      });
    } else if (open) {
      form.setFieldsValue({
        loginKey: "",
        globalDisplayName: "",
      });
    }
  }, [open, isLoggedIn, principal, form]);

  const handleSubmit = useCallback(async () => {
    try {
      const values = await form.validateFields();
      setLoading(true);
      await bootstrap({
        kind: "human",
        loginKey: values.loginKey,
        globalDisplayName: values.globalDisplayName,
        backendType: null,
        backendThreadId: null,
        backendConfig: null,
      });
      await refreshLobbyPresence();
      toast().success(t("login.loginSuccess"));
      if (afterBootstrap) {
        try {
          await afterBootstrap();
        } catch (err) {
          const message = err instanceof Error ? `: ${err.message}` : "";
          toast().error(t("inviteEntry.joinAfterLoginFailed") + message);
          onClose();
          return;
        }
      }
      onClose();
    } catch (err) {
      if (err instanceof Error) {
        toast().error(t("login.loginFailed") + ": " + err.message);
      }
    } finally {
      setLoading(false);
    }
  }, [form, bootstrap, afterBootstrap, isHumanFirstRun, onClose, refreshLobbyPresence, t]);

  const handleLogout = useCallback(() => {
    logout();
    resetRoom();
    resetMessage();
    void refreshLobbyPresence();
    toast().success(t("login.logoutSuccess"));
    onClose();
  }, [logout, resetRoom, resetMessage, refreshLobbyPresence, onClose, t]);

  const statusText = isLoggedIn
    ? t("login.statusRegistered", {
        name: principal!.globalDisplayName || principal!.loginKey,
      })
    : t("login.statusNotRegistered");

  return (
    <Modal
      title={t("header.identityTitle")}
      open={open}
      onCancel={onClose}
      onOk={handleSubmit}
      confirmLoading={loading}
      okText={isLoggedIn ? t("login.saveIdentity") : t("login.loginButton")}
      cancelText={t("common.cancel")}
      destroyOnHidden
      footer={(_, { OkBtn, CancelBtn }) => (
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span>
            {isLoggedIn && (
              <a
                role="button"
                onClick={handleLogout}
                style={{ color: "#F87171" }}
              >
                <LogoutOutlined style={{ marginRight: 4 }} />
                {t("login.logoutButton")}
              </a>
            )}
          </span>
          <span>
            <CancelBtn />
            <OkBtn />
          </span>
        </div>
      )}
    >
      {inviteToken ? (
        <div style={{ marginBottom: 16 }}>
          <Text type="secondary">{t("inviteEntry.eyebrow")}</Text>
          <Paragraph style={{ marginTop: 8, marginBottom: 4, fontSize: 16, fontWeight: 600 }}>
            {t("inviteEntry.title", { room: invite?.name ?? t("inviteEntry.unknownRoom") })}
          </Paragraph>
          <Text type="secondary">{t("inviteEntry.loginHint")}</Text>
        </div>
      ) : null}
      <Form form={form} layout="vertical">
        <Form.Item
          name="loginKey"
          label={t("login.emailLabel")}
          rules={[
            {
              required: true,
              message: t("login.emailRequired"),
            },
          ]}
        >
          <Input
            placeholder={t("login.emailPlaceholder")}
            disabled={isLoggedIn}
          />
        </Form.Item>
        <Form.Item
          name="globalDisplayName"
          label={t("login.displayNameLabel")}
          rules={[
            { required: true, message: t("login.displayNameRequired") },
          ]}
        >
          <Input placeholder={t("login.displayNamePlaceholder")} />
        </Form.Item>
      </Form>
      {!isHumanFirstRun ? (
        <div style={{ color: "#94A3B8", fontSize: 13, marginTop: 8 }}>
          {statusText}
        </div>
      ) : null}
    </Modal>
  );
}
