import { useState, useCallback, useEffect } from "react";
import { Modal, Input, Form, message } from "antd";
import { LogoutOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";

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
  const resetMessage = useMessageStore((s) => s.reset);

  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const isLoggedIn = !!principal;

  useEffect(() => {
    if (open && isLoggedIn && principal) {
      form.setFieldsValue({
        globalDisplayName: principal.globalDisplayName,
        loginKey: principal.loginKey,
      });
    } else if (open) {
      form.resetFields();
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
      });
      message.success(t("login.loginSuccess"));
      onClose();
    } catch (err) {
      if (err instanceof Error) {
        message.error(t("login.loginFailed") + ": " + err.message);
      }
    } finally {
      setLoading(false);
    }
  }, [form, bootstrap, onClose, t]);

  const handleLogout = useCallback(() => {
    logout();
    resetRoom();
    resetMessage();
    message.success(t("login.logoutSuccess"));
    onClose();
  }, [logout, resetRoom, resetMessage, onClose, t]);

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
      destroyOnClose
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
        <Form.Item
          name="loginKey"
          label={t("login.emailLabel")}
          rules={[{ required: true, message: t("login.emailRequired") }]}
        >
          <Input placeholder={t("login.emailPlaceholder")} disabled={isLoggedIn} />
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
      <div style={{ color: "#94A3B8", fontSize: 13, marginTop: 8 }}>
        {statusText}
      </div>
    </Modal>
  );
}
