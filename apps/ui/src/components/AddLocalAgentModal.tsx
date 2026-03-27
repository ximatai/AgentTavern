import { useState, useMemo } from "react";
import { Modal, Input, Button, message, Radio, Select } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";

import { useRoomStore } from "../stores/room";
import { addLocalAgent } from "../api/assistants";
import type { AgentRoleKind } from "@agent-tavern/shared";

import "../styles/add-local-agent.css";

const { TextArea } = Input;

interface AddLocalAgentModalProps {
  open: boolean;
  onClose: () => void;
}

export function AddLocalAgentModal({ open, onClose }: AddLocalAgentModalProps) {
  const { t } = useTranslation();
  const room = useRoomStore((s) => s.room);
  const self = useRoomStore((s) => s.self);
  const members = useRoomStore((s) => s.members);
  const hydrateRoom = useRoomStore((s) => s.hydrateRoom);

  const [displayName, setDisplayName] = useState("");
  const [roleKind, setRoleKind] = useState<AgentRoleKind>("independent");
  const [ownerMemberId, setOwnerMemberId] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [inputFormat, setInputFormat] = useState<string>("text");
  const [submitting, setSubmitting] = useState(false);

  const humanMembers = useMemo(
    () => members.filter((m) => m.type === "human"),
    [members],
  );

  const ownerOptions = humanMembers.map((m) => ({
    label: m.displayName,
    value: m.id,
  }));

  async function handleSubmit() {
    const name = displayName.trim();
    if (!name) return;
    if (roleKind === "assistant" && !ownerMemberId) return;
    if (!command.trim()) return;
    if (!self || !room) return;

    const args = argsText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    setSubmitting(true);
    try {
      await addLocalAgent(room.id, {
        displayName: name,
        roleKind,
        actorMemberId: self.memberId,
        wsToken: self.wsToken,
        ownerMemberId: roleKind === "assistant" ? ownerMemberId : null,
        adapterType: "local_process",
        adapterConfig: {
          command: command.trim(),
          args,
          inputFormat,
        },
      });
      message.success(t("localAgent.createSuccess"));
      await hydrateRoom(room.id);
      handleReset();
      onClose();
    } catch (err) {
      message.error(err instanceof Error ? err.message : t("localAgent.createFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  function handleReset() {
    setDisplayName("");
    setRoleKind("independent");
    setOwnerMemberId(null);
    setCommand("");
    setArgsText("");
    setInputFormat("text");
  }

  function handleClose() {
    handleReset();
    onClose();
  }

  return (
    <Modal
      title={null}
      open={open}
      onCancel={handleClose}
      footer={null}
      destroyOnClose
      width={480}
      className="add-local-agent-modal"
    >
      <div className="ala-panel">
        <div className="ala-header">
          <PlusOutlined style={{ marginRight: 8 }} />
          {t("localAgent.title")}
        </div>

        <div className="ala-form">
          <div className="ala-field">
            <label className="ala-label">{t("localAgent.displayName")}</label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t("localAgent.displayNamePlaceholder")}
              className="ala-input"
            />
          </div>

          <div className="ala-field">
            <label className="ala-label">{t("localAgent.roleKind")}</label>
            <Radio.Group
              value={roleKind}
              onChange={(e) => {
                setRoleKind(e.target.value);
                setOwnerMemberId(null);
              }}
              className="ala-radio-group"
            >
              <Radio value="independent">{t("localAgent.roleIndependent")}</Radio>
              <Radio value="assistant">{t("localAgent.roleAssistant")}</Radio>
            </Radio.Group>
          </div>

          {roleKind === "assistant" && (
            <div className="ala-field">
              <label className="ala-label">{t("localAgent.ownerMember")}</label>
              <Select
                value={ownerMemberId}
                onChange={(val) => setOwnerMemberId(val)}
                placeholder={t("localAgent.ownerMemberPlaceholder")}
                options={ownerOptions}
                className="ala-select"
              />
            </div>
          )}

          <div className="ala-field">
            <label className="ala-label">{t("localAgent.command")}</label>
            <Input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={t("localAgent.commandPlaceholder")}
              className="ala-input"
            />
          </div>

          <div className="ala-field">
            <label className="ala-label">{t("localAgent.args")}</label>
            <TextArea
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              placeholder={t("localAgent.argsPlaceholder")}
              rows={3}
              className="ala-textarea"
            />
          </div>

          <div className="ala-field">
            <label className="ala-label">{t("localAgent.inputFormat")}</label>
            <Radio.Group
              value={inputFormat}
              onChange={(e) => setInputFormat(e.target.value)}
              className="ala-radio-group"
            >
              <Radio value="text">text</Radio>
              <Radio value="json">json</Radio>
            </Radio.Group>
          </div>
        </div>

        <div className="ala-actions">
          <Button onClick={handleClose}>{t("common.cancel")}</Button>
          <Button
            type="primary"
            loading={submitting}
            onClick={handleSubmit}
            disabled={!displayName.trim() || !command.trim() || (roleKind === "assistant" && !ownerMemberId)}
          >
            {t("localAgent.submit")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
