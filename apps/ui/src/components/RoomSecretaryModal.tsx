import { useEffect, useMemo, useState } from "react";
import { Alert, Modal, Radio, Select, Space, Tag, Typography } from "antd";
import { useTranslation } from "react-i18next";

import type { RoomSecretaryMode } from "@agent-tavern/shared";

import { toast } from "../lib/feedback";
import { useRoomStore } from "../stores/room";

const { Text } = Typography;

interface RoomSecretaryModalProps {
  open: boolean;
  onClose: () => void;
}

export function RoomSecretaryModal({ open, onClose }: RoomSecretaryModalProps) {
  const { t } = useTranslation();
  const room = useRoomStore((s) => s.room);
  const members = useRoomStore((s) => s.members);
  const updateRoomSecretary = useRoomStore((s) => s.updateRoomSecretary);

  const candidateAgents = useMemo(
    () =>
      members.filter(
        (member) =>
          member.type === "agent" &&
          member.roleKind === "independent" &&
          member.membershipStatus !== "left",
      ),
    [members],
  );

  const [secretaryMode, setSecretaryMode] = useState<RoomSecretaryMode>("off");
  const [secretaryMemberId, setSecretaryMemberId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !room) return;
    setSecretaryMode(room.secretaryMode);
    setSecretaryMemberId(room.secretaryMemberId);
  }, [open, room]);

  const selectedSecretary = candidateAgents.find((member) => member.id === secretaryMemberId) ?? null;
  const canSave =
    secretaryMode === "off" ||
    Boolean(secretaryMemberId && candidateAgents.some((member) => member.id === secretaryMemberId));

  async function handleSave() {
    if (!canSave) {
      toast().warning(t("secretaryPanel.selectRequired"));
      return;
    }

    setSaving(true);
    try {
      await updateRoomSecretary({
        secretaryMode,
        secretaryMemberId: secretaryMode === "off" ? null : secretaryMemberId,
      });
      toast().success(t("secretaryPanel.saveSuccess"));
      onClose();
    } catch (error) {
      toast().error(error instanceof Error ? error.message : t("secretaryPanel.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={t("secretaryPanel.title")}
      open={open}
      onCancel={onClose}
      onOk={() => void handleSave()}
      okText={t("common.save")}
      cancelText={t("common.cancel")}
      okButtonProps={{ loading: saving, disabled: !canSave }}
      destroyOnHidden
    >
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Alert
          type="info"
          showIcon
          message={t("secretaryPanel.helpTitle")}
          description={t("secretaryPanel.helpBody")}
        />

        <div>
          <Text strong>{t("secretaryPanel.modeLabel")}</Text>
          <Radio.Group
            style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}
            value={secretaryMode}
            onChange={(event) => setSecretaryMode(event.target.value as RoomSecretaryMode)}
          >
            <Radio value="off">{t("secretaryPanel.modeOff")}</Radio>
            <Radio value="coordinate">{t("secretaryPanel.modeCoordinate")}</Radio>
            <Radio value="coordinate_and_summarize">{t("secretaryPanel.modeCoordinateAndSummarize")}</Radio>
          </Radio.Group>
        </div>

        <div>
          <Text strong>{t("secretaryPanel.agentLabel")}</Text>
          <Select
            style={{ width: "100%", marginTop: 12 }}
            placeholder={t("secretaryPanel.agentPlaceholder")}
            value={secretaryMode === "off" ? undefined : (secretaryMemberId ?? undefined)}
            onChange={(value) => setSecretaryMemberId(value)}
            disabled={secretaryMode === "off"}
            options={candidateAgents.map((member) => ({
              value: member.id,
              label: member.displayName,
            }))}
          />
          {selectedSecretary ? (
            <div style={{ marginTop: 12 }}>
              <Tag color="cyan">{selectedSecretary.displayName}</Tag>
              <Text type="secondary">{t("secretaryPanel.currentSelection")}</Text>
            </div>
          ) : null}
        </div>

        {candidateAgents.length === 0 ? (
          <Alert
            type="warning"
            showIcon
            message={t("secretaryPanel.noCandidatesTitle")}
            description={t("secretaryPanel.noCandidatesBody")}
          />
        ) : null}
      </Space>
    </Modal>
  );
}
