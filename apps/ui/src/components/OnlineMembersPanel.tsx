import { useMemo, useState } from "react";
import { Button, Popover } from "antd";
import { TeamOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";

import { toast } from "../lib/feedback";
import { useRoomStore } from "../stores/room";
import { usePrincipalStore } from "../stores/principal";
import type { LobbyPrincipal } from "../api/principals";

export function OnlineMembersPanel() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [actioningPrincipalId, setActioningPrincipalId] = useState<string | null>(null);

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
    return lobbyPrincipals;
  }, [lobbyPrincipals]);

  const handleStartDirectRoom = async (targetPrincipalId: string) => {
    setActioningPrincipalId(targetPrincipalId);
    try {
      await useRoomStore.getState().startDirectRoom(targetPrincipalId);
      setOpen(false);
    } catch (error) {
      toast().error(
        error instanceof Error ? error.message : t("onlineMembers.startChatFailed"),
      );
    } finally {
      setActioningPrincipalId(null);
    }
  };

  const handlePullPrincipal = async (targetPrincipalId: string) => {
    if (!room || !self) return;
    setActioningPrincipalId(targetPrincipalId);
    try {
      await useRoomStore
        .getState()
        .pullPrincipal(room.id, self.memberId, self.wsToken, targetPrincipalId);
      setOpen(false);
      toast().success(t("onlineMembers.pullSuccess"));
    } catch (error) {
      toast().error(
        error instanceof Error ? error.message : t("onlineMembers.pullFailed"),
      );
    } finally {
      setActioningPrincipalId(null);
    }
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
            const principalId = item.principalId ?? item.id;
            const isSelf = principalId === principal?.principalId;
            const inRoom = room && roomPrincipalIds.has(principalId);
            const actioning = actioningPrincipalId === principalId;
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
                    {isSelf ? ` (${t("onlineMembers.self")})` : ""}
                  </div>
                  <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 2 }}>
                    {item.kind === "agent"
                      ? `${t("onlineMembers.kindAgent")} · ${item.loginKey}${item.runtimeStatus ? ` · ${t(`runtimeStatus.${item.runtimeStatus}`)}` : ""}`
                      : `${t("onlineMembers.kindHuman")} · ${item.loginKey}`}
                  </div>
                </div>
                {isSelf ? (
                  <Button size="small" disabled>
                    {t("onlineMembers.selfAction")}
                  </Button>
                ) : principal ? (
                  inRoom ? (
                    <Button size="small" disabled>
                      {t("onlineMembers.alreadyInRoom")}
                    </Button>
                  ) : room ? (
                    <Button
                      size="small"
                      type="primary"
                      loading={actioning}
                      disabled={actioning}
                      onClick={() => void handlePullPrincipal(principalId)}
                    >
                      {t("onlineMembers.pullToRoom")}
                    </Button>
                  ) : (
                    <Button
                      size="small"
                      type="primary"
                      loading={actioning}
                      disabled={actioning}
                      onClick={() => void handleStartDirectRoom(principalId)}
                    >
                      {t("onlineMembers.startChat")}
                    </Button>
                  )
                ) : null}
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
