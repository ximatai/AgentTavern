import { useMemo, useState } from "react";
import { Button, Popover } from "antd";
import { TeamOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";

import { toast } from "../lib/feedback";
import { useRoomStore } from "../stores/room";
import { useCitizenStore } from "../stores/citizen";

import "../styles/online-members.css";

export function OnlineMembersPanel() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [actioningPrincipalId, setActioningPrincipalId] = useState<string | null>(null);

  const principal = useCitizenStore((s) => s.principal);
  const room = useRoomStore((s) => s.room);
  const self = useRoomStore((s) => s.self);
  const members = useRoomStore((s) => s.members);
  const lobbyCitizens = useRoomStore((s) => s.lobbyCitizens);

  const roomPrincipalIds = useMemo(() => {
    const ids = new Set<string>();
    for (const m of members) {
      if (m.citizenId) ids.add(m.citizenId);
    }
    return ids;
  }, [members]);

  const visiblePrincipals = useMemo(() => {
    return lobbyCitizens;
  }, [lobbyCitizens]);

  const handleStartDirectRoom = async (targetCitizenId: string) => {
    setActioningPrincipalId(targetCitizenId);
    try {
      await useRoomStore.getState().startDirectRoom(targetCitizenId);
      setOpen(false);
    } catch (error) {
      toast().error(
        error instanceof Error ? error.message : t("onlineMembers.startChatFailed"),
      );
    } finally {
      setActioningPrincipalId(null);
    }
  };

  const handlePullPrincipal = async (targetCitizenId: string) => {
    if (!room || !self) return;
    setActioningPrincipalId(targetCitizenId);
    try {
      await useRoomStore
        .getState()
        .pullPrincipal(room.id, self.memberId, self.wsToken, targetCitizenId);
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
    <div className="online-members-panel">
      <div className="online-members-panel-header">
        <span className="online-members-panel-title">{t("onlineMembers.panelTitle")}</span>
        <span className="online-members-panel-count">
          {t("onlineMembers.countOnline", { count: visiblePrincipals.length })}
        </span>
      </div>

      {visiblePrincipals.length > 0 ? (
        <div className="online-members-panel-list">
          {visiblePrincipals.map((item) => {
            const citizenId = item.citizenId ?? item.id;
            const isSelf = citizenId === principal?.citizenId;
            const inRoom = room && roomPrincipalIds.has(citizenId);
            const actioning = actioningPrincipalId === citizenId;
            const runtimeWaiting = item.runtimeStatus === "pending_bridge" || item.runtimeStatus === "waiting_bridge";
            return (
              <div key={item.id} className="online-members-panel-item">
                <div className="online-members-panel-meta">
                  <div className="online-members-panel-name">
                    {item.globalDisplayName}
                    {isSelf ? ` (${t("onlineMembers.self")})` : ""}
                    <span className={`online-members-panel-kind ${item.kind === "agent" ? "is-agent" : "is-human"}`}>
                      {item.kind === "agent" ? t("onlineMembers.kindAgent") : t("onlineMembers.kindHuman")}
                    </span>
                    {item.runtimeStatus ? (
                      <span className={`online-members-panel-runtime ${runtimeWaiting ? "is-waiting" : ""}`}>
                        {t(`runtimeStatus.${item.runtimeStatus}`)}
                      </span>
                    ) : null}
                  </div>
                  <div className="online-members-panel-login-key">
                    {item.loginKey}
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
                      onClick={() => void handlePullPrincipal(citizenId)}
                    >
                      {t("onlineMembers.pullToRoom")}
                    </Button>
                  ) : (
                    <Button
                      size="small"
                      type="primary"
                      loading={actioning}
                      disabled={actioning}
                      onClick={() => void handleStartDirectRoom(citizenId)}
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
        <p className="online-members-panel-empty">{t("onlineMembers.empty")}</p>
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
        overlayClassName="online-members-popover"
        overlayStyle={{ minWidth: 340 }}
      >
        <Button type="primary" icon={<TeamOutlined />} size="large">
          {t("onlineMembers.button")}
          {visiblePrincipals.length > 0 && (
            <span className="online-members-button-count">{visiblePrincipals.length}</span>
          )}
        </Button>
      </Popover>
    </div>
  );
}
