import { useState, useCallback, useEffect } from "react";
import { Modal, Input, Form, Radio, Select } from "antd";
import { LogoutOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";

import { toast } from "../lib/feedback";
import { usePrincipalStore } from "../stores/principal";
import { useRoomStore } from "../stores/room";
import { useMessageStore } from "../stores/message";

interface LoginModalProps {
  open: boolean;
  onClose: () => void;
}

export function LoginModal({ open, onClose }: LoginModalProps) {
  const { t } = useTranslation();
  const principal = usePrincipalStore((s) => s.principal);
  const bootstrap = usePrincipalStore((s) => s.bootstrap);
  const logout = usePrincipalStore((s) => s.logout);
  const resetRoom = useRoomStore((s) => s.reset);
  const refreshLobbyPresence = useRoomStore((s) => s.refreshLobbyPresence);
  const resetMessage = useMessageStore((s) => s.reset);

  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const isLoggedIn = !!principal;
  const selectedKind = principal?.kind ?? "human";
  const loginKeyLabel = selectedKind === "agent" ? t("login.agentKeyLabel") : t("login.emailLabel");
  const loginKeyPlaceholder =
    selectedKind === "agent" ? t("login.agentKeyPlaceholder") : t("login.emailPlaceholder");
  const loginKeyRequired =
    selectedKind === "agent" ? t("login.agentKeyRequired") : t("login.emailRequired");

  useEffect(() => {
    if (open && isLoggedIn && principal) {
      form.setFieldsValue({
        globalDisplayName: principal.globalDisplayName,
        loginKey: principal.loginKey,
        backendType: principal.backendType ?? "claude_code",
        backendThreadId: principal.backendThreadId ?? "",
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
      const kind = principal?.kind ?? "human";
      setLoading(true);
      await bootstrap({
        kind,
        loginKey: values.loginKey,
        globalDisplayName: values.globalDisplayName,
        backendType:
          kind === "agent"
            ? ((values.backendType ?? principal?.backendType) as "codex_cli" | "claude_code")
            : null,
        backendThreadId:
          kind === "agent" ? (values.backendThreadId ?? principal?.backendThreadId ?? "") : null,
      });
      await refreshLobbyPresence();
      toast().success(t("login.loginSuccess"));
      onClose();
    } catch (err) {
      if (err instanceof Error) {
        toast().error(t("login.loginFailed") + ": " + err.message);
      }
    } finally {
      setLoading(false);
    }
  }, [form, bootstrap, onClose, principal, refreshLobbyPresence, t]);

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
      forceRender
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
      <Form form={form} layout="vertical">
        {isLoggedIn ? (
          <Form.Item label={t("login.identityKindLabel")}>
            <Radio.Group disabled value={principal.kind}>
              <Radio.Button value="human">{t("login.kindHuman")}</Radio.Button>
              <Radio.Button value="agent">{t("login.kindAgent")}</Radio.Button>
            </Radio.Group>
          </Form.Item>
        ) : null}
        <Form.Item
          name="loginKey"
          label={loginKeyLabel}
          rules={[{ required: true, message: loginKeyRequired }]}
        >
          <Input
            placeholder={loginKeyPlaceholder}
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
        {isLoggedIn && selectedKind === "agent" ? (
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
      <div style={{ color: "#94A3B8", fontSize: 13, marginTop: 8 }}>
        {statusText}
      </div>
    </Modal>
  );
}
