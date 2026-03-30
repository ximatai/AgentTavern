import { useState, useCallback, useEffect } from "react";
import { Modal, Input, Form, Radio, Select, Typography } from "antd";
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
  const selectedKind = Form.useWatch("kind", form) ?? principal?.kind ?? "human";

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
        kind: principal.kind,
        globalDisplayName: principal.globalDisplayName,
        loginKey: principal.loginKey,
        backendType: principal.backendType ?? "claude_code",
        backendThreadId: principal.backendThreadId ?? "",
      });
    } else if (open) {
      form.setFieldsValue({
        kind: "human",
        loginKey: "",
        globalDisplayName: "",
        backendType: "claude_code",
        backendThreadId: "",
      });
    }
  }, [open, isLoggedIn, principal, form]);

  const handleSubmit = useCallback(async () => {
    try {
      const values = await form.validateFields();
      setLoading(true);
      const kind = isHumanFirstRun ? "human" : (values.kind as "human" | "agent");
      await bootstrap({
        kind,
        loginKey: values.loginKey,
        globalDisplayName: values.globalDisplayName,
        backendType: kind === "agent" ? (values.backendType as "codex_cli" | "claude_code" | "opencode") : null,
        backendThreadId: kind === "agent" ? values.backendThreadId : null,
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
        {!isHumanFirstRun ? (
          <Form.Item
            name="kind"
            label={t("login.identityKindLabel")}
            rules={[{ required: true, message: t("login.identityKindRequired") }]}
          >
            <Radio.Group disabled={isLoggedIn}>
              <Radio.Button value="human">{t("login.kindHuman")}</Radio.Button>
              <Radio.Button value="agent">{t("login.kindAgent")}</Radio.Button>
            </Radio.Group>
          </Form.Item>
        ) : null}
        <Form.Item
          name="loginKey"
          label={selectedKind === "agent" ? t("login.agentKeyLabel") : t("login.emailLabel")}
          rules={[
            {
              required: true,
              message:
                selectedKind === "agent"
                  ? t("login.agentKeyRequired")
                  : t("login.emailRequired"),
            },
          ]}
        >
          <Input
            placeholder={
              selectedKind === "agent"
                ? t("login.agentKeyPlaceholder")
                : t("login.emailPlaceholder")
            }
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
        {!isHumanFirstRun && selectedKind === "agent" ? (
          <>
            <Form.Item
              name="backendType"
              label={t("login.backendTypeLabel")}
              rules={[{ required: true, message: t("login.backendTypeRequired") }]}
              initialValue="claude_code"
            >
              <Select
                disabled={isLoggedIn}
                options={[
                  { value: "claude_code", label: t("login.backendClaudeCode") },
                  { value: "codex_cli", label: t("login.backendCodexCli") },
                  { value: "opencode", label: t("login.backendOpenCode") },
                ]}
              />
            </Form.Item>
            <Form.Item
              name="backendThreadId"
              label={t("login.threadIdLabel")}
              rules={[{ required: true, message: t("login.threadIdRequired") }]}
            >
              <Input
                placeholder={t("login.threadIdPlaceholder")}
                disabled={isLoggedIn}
              />
            </Form.Item>
          </>
        ) : null}
      </Form>
      {!isHumanFirstRun ? (
        <div style={{ color: "#94A3B8", fontSize: 13, marginTop: 8 }}>
          {statusText}
        </div>
      ) : null}
    </Modal>
  );
}
