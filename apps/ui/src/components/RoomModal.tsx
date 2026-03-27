import { useState } from "react";
import { Modal, Input, Button, message, Typography } from "antd";
import { useTranslation } from "react-i18next";

import { useRoomStore } from "../stores/room";

const { Text } = Typography;

function extractInviteToken(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (!trimmed.includes("/")) return trimmed;
  return trimmed.split("/").at(-1)?.trim() ?? "";
}

interface RoomModalProps {
  open: boolean;
  onClose: () => void;
}

export function RoomModal({ open, onClose }: RoomModalProps) {
  const { t } = useTranslation();
  const [roomName, setRoomName] = useState("");
  const [inviteInput, setInviteInput] = useState("");
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);

  const createRoom = useRoomStore((s) => s.createRoom);
  const joinRoom = useRoomStore((s) => s.joinRoom);

  function handleClose() {
    setRoomName("");
    setInviteInput("");
    onClose();
  }

  async function handleCreate() {
    const name = roomName.trim();
    if (!name) return;
    setCreating(true);
    try {
      await createRoom(name);
      message.success(t("roomModal.createSuccess"));
      handleClose();
    } catch (err) {
      message.error(err instanceof Error ? err.message : t("roomModal.createFailed"));
    } finally {
      setCreating(false);
    }
  }

  async function handleJoin() {
    const token = extractInviteToken(inviteInput);
    if (!token) return;
    setJoining(true);
    try {
      await joinRoom(token);
      message.success(t("roomModal.joinSuccess"));
      handleClose();
    } catch (err) {
      message.error(err instanceof Error ? err.message : t("roomModal.joinFailed"));
    } finally {
      setJoining(false);
    }
  }

  return (
    <Modal
      title={t("roomModal.title")}
      open={open}
      onCancel={handleClose}
      footer={null}
      destroyOnClose
    >
      {/* Section 1: Create room */}
      <div className="room-modal-section">
        <Text type="secondary" className="room-modal-label">
          {t("roomModal.newRoomName")}
        </Text>
        <Input
          value={roomName}
          onChange={(e) => setRoomName(e.target.value)}
          placeholder={t("roomModal.roomNamePlaceholder")}
          onPressEnter={handleCreate}
        />
        <Button
          type="primary"
          block
          loading={creating}
          onClick={handleCreate}
          className="room-modal-action"
        >
          {t("roomModal.createAndEnter")}
        </Button>
      </div>

      {/* Section 2: Join via invite */}
      <div className="room-modal-section">
        <Text type="secondary" className="room-modal-label">
          {t("roomModal.inviteLabel")}
        </Text>
        <Input
          value={inviteInput}
          onChange={(e) => setInviteInput(e.target.value)}
          placeholder={t("roomModal.invitePlaceholder")}
          onPressEnter={handleJoin}
        />
        <Button
          block
          loading={joining}
          onClick={handleJoin}
          className="room-modal-action"
        >
          {t("roomModal.joinViaInvite")}
        </Button>
      </div>
    </Modal>
  );
}
