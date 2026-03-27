import { useMemo, useState } from "react";
import { Button, Popover } from "antd";
import { TeamOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { message } from "antd";

import { useRoomStore } from "../stores/room";
import { usePrincipalStore } from "../stores/principal";
import type { LobbyPrincipal } from "../api/principals";

export function OnlineMembersPanel() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const principal = usePrincipalStore((s) => s.principal);
  const room = useRoomStore((s) => s.room);
  const self = useRoomStore((s) => s.self);
  const members = useRoomStore((s) => s.members);
  const lobbyPrincipals = useRoomStore((s) => s.lobbyPrincipals);

  const roomPrincipalIds = useMemo(() => {
    const ids = new Set<string>();
    for (const m of members) {
      if (m.principalId) ids.add(m.principalId);
    }
    return ids;
  }, [members]);

  const visiblePrincipals = useMemo(() => {
    return lobbyPrincipals.filter((p) => p.principalId !== principal?.principalId);
  }, [lobbyPrincipals, principal]);

  const handleStartDirectRoom = (targetPrincipalId: string) => {
    setOpen(false);
    void useRoomStore.getState().startDirectRoom(targetPrincipalId);
  };

  const handlePullPrincipal = (targetPrincipalId: string) => {
    if (!room || !self) return;
    setOpen(false);
    void useRoomStore
      .getState()
      .pullPrincipal(room.id, self.memberId, self.wsToken, targetPrincipalId)
      .then(() => message.success(t("onlineMembers.pullSuccess")))
      .catch(() => message.error(t("onlineMembers.pullFailed")));
  };

  const panelContent = (
    <div style={{ width: 320, maxHeight: 400, overflowY: "auto" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 14 }}>
          {t("onlineMembers.panelTitle")}
        </span>
        <span style={{ color: "#94A3B8", fontSize: 12 }}>
          {t("onlineMembers.countOnline", { count: visiblePrincipals.length })}
        </span>
      </div>

      {visiblePrincipals.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {visiblePrincipals.map((item) => {
            const inRoom = room && roomPrincipalIds.has(item.principalId);
            return (
              <div
                key={item.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "8px 10px",
                  borderRadius: 8,
                  background: "#1A2332",
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: "#fff" }}>
                    {item.globalDisplayName}
                  </div>
                  <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 2 }}>
                    {item.kind === "agent"
                      ? `${t("onlineMembers.kindAgent")} · ${item.loginKey}${item.runtimeStatus ? ` · ${t(`runtimeStatus.${item.runtimeStatus}`)}` : ""}`
                      : `${t("onlineMembers.kindHuman")} · ${item.loginKey}`}
                  </div>
                </div>
                {inRoom ? (
                  <Button size="small" disabled>
                    {t("onlineMembers.alreadyInRoom")}
                  </Button>
                ) : room ? (
                  <Button
                    size="small"
                    type="primary"
                    onClick={() => handlePullPrincipal(item.principalId)}
                  >
                    {t("onlineMembers.pullToRoom")}
                  </Button>
                ) : (
                  <Button
                    size="small"
                    type="primary"
                    onClick={() => handleStartDirectRoom(item.principalId)}
                  >
                    {t("onlineMembers.startChat")}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p style={{ color: "#64748B", fontSize: 12, margin: 0, textAlign: "center" }}>
          {t("onlineMembers.empty")}
        </p>
      )}
    </div>
  );

  return (
    <div
      style={{
        position: "fixed",
        bottom: 24,
        right: 24,
        zIndex: 1000,
      }}
    >
      <Popover
        content={panelContent}
        trigger="click"
        open={open}
        onOpenChange={setOpen}
        placement="topRight"
        overlayStyle={{ minWidth: 340 }}
      >
        <Button type="primary" icon={<TeamOutlined />} size="large">
          {t("onlineMembers.button")}
          {visiblePrincipals.length > 0 && (
            <span
              style={{
                marginLeft: 6,
                background: "#0E7490",
                borderRadius: 10,
                padding: "0 7px",
                fontSize: 12,
                lineHeight: "20px",
              }}
            >
              {visiblePrincipals.length}
            </span>
          )}
        </Button>
      </Popover>
    </div>
  );
}
