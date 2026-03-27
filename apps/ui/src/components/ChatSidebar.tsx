import { useMemo, useState } from "react";
import { Button, Typography } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";

import { useRoomStore } from "../stores/room";
import { RoomModal } from "./RoomModal";
import type { RecentRoomRecord } from "../types";

const { Text } = Typography;

function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMs / 3_600_000);
  const diffDay = Math.floor(diffMs / 86_400_000);

  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}m`;
  if (diffHour < 24) return `${diffHour}h`;
  return `${diffDay}d`;
}

function RoomItem({
  record,
  isActive,
  onClick,
}: {
  record: RecentRoomRecord;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`room-item${isActive ? " room-item-active" : ""}`}
      onClick={onClick}
    >
      <span className="room-item-hash">#</span>
      <span className="room-item-name">{record.name}</span>
      <span className="room-item-time">{formatRelativeTime(record.visitedAt)}</span>
    </button>
  );
}

export function ChatSidebar() {
  const { t } = useTranslation();
  const room = useRoomStore((s) => s.room);
  const recentRooms = useRoomStore((s) => s.recentRooms);
  const openRecentRoom = useRoomStore((s) => s.openRecentRoom);
  const [showRoomModal, setShowRoomModal] = useState(false);

  const sortedRooms = useMemo(() => {
    const mergedRooms =
      room && !recentRooms.find((item) => item.roomId === room.id)
        ? [
            {
              roomId: room.id,
              name: room.name,
              inviteToken: room.inviteToken,
              visitedAt: new Date().toISOString(),
            },
            ...recentRooms,
          ]
        : recentRooms;

    if (!room) return mergedRooms;
    const currentId = room.id;
    return [...mergedRooms].sort((a, b) => {
      if (a.roomId === currentId) return -1;
      if (b.roomId === currentId) return 1;
      return b.visitedAt.localeCompare(a.visitedAt);
    });
  }, [recentRooms, room]);

  return (
    <>
      {/* Section heading */}
      <div className="room-list-header">
        <Text type="secondary" className="room-list-title">
          {t("sidebar.myRooms")}
        </Text>
        <button type="button" className="room-list-add-btn" title={t("sidebar.createRoom")} onClick={() => setShowRoomModal(true)}>
          <PlusOutlined />
        </button>
      </div>

      {/* Room list */}
      <div className="room-list">
        {sortedRooms.length === 0 ? (
          <Text type="secondary" className="room-list-empty">
            {t("sidebar.noRooms")}
          </Text>
        ) : (
          sortedRooms.map((item) => (
            <RoomItem
              key={item.roomId}
              record={item}
              isActive={room?.id === item.roomId}
              onClick={() => void openRecentRoom(item.roomId)}
            />
          ))
        )}
      </div>

      {/* Bottom: Create room button */}
      <div className="sidebar-bottom">
        <Button type="primary" block icon={<PlusOutlined />} onClick={() => setShowRoomModal(true)}>
          {t("sidebar.createRoom")}
        </Button>
      </div>

      <RoomModal open={showRoomModal} onClose={() => setShowRoomModal(false)} />
    </>
  );
}
