import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { App as AntdApp, ConfigProvider } from "antd";
import { I18nextProvider } from "react-i18next";
import { useTranslation } from "react-i18next";

import i18n from "./i18n";
import "./i18n";
import "./styles/global.css";
import "./styles/shell.css";
import "./styles/sidebar.css";
import "./styles/home.css";
import "./styles/room-sidebar.css";
import "./styles/message-list.css";
import "./styles/input-bar.css";
import "./styles/error-boundary.css";
import { ChatSidebar } from "./components/ChatSidebar";
import { OnlineMembersPanel } from "./components/OnlineMembersPanel";
import { AppLoading } from "./components/AppLoading";
import { ErrorBoundary } from "./components/ErrorBoundary";
import {
  useSettingsStore,
  getAntdThemeConfig,
  applyThemeCssVars,
  useSystemThemeListener,
} from "./stores/settings";
import { setMessageApi } from "./lib/feedback";
import { useCitizenStore } from "./stores/citizen";
import { useRoomStore } from "./stores/room";
import { useRoomWebSocket } from "./hooks/useRoomWebSocket";
import { useCitizenWebSocket } from "./hooks/useCitizenWebSocket";
import { usePollingSync } from "./hooks/usePollingSync";

const HomeEntry = lazy(async () => import("./components/HomeEntry").then((module) => ({ default: module.HomeEntry })));
const RoomEntry = lazy(async () => import("./components/RoomEntry").then((module) => ({ default: module.RoomEntry })));

function FeedbackBridge() {
  const { message } = AntdApp.useApp();

  useEffect(() => {
    setMessageApi(message);
  }, [message]);

  return null;
}

function parseAppPath(pathname: string): { roomId: string | null; joinInviteToken: string | null } {
  const roomMatch = pathname.match(/^\/rooms\/([^/]+)$/);
  if (roomMatch) {
    return { roomId: roomMatch[1] ?? null, joinInviteToken: null };
  }

  const joinMatch = pathname.match(/^\/join\/([^/]+)$/);
  if (joinMatch) {
    return { roomId: null, joinInviteToken: joinMatch[1] ?? null };
  }

  return { roomId: null, joinInviteToken: null };
}

function App() {
  const { t } = useTranslation();
  const principal = useCitizenStore((s) => s.principal);
  const room = useRoomStore((s) => s.room);
  const [pathname, setPathname] = useState(() => window.location.pathname);
  const themeId = useSettingsStore((s) => s.themeId);
  const antdThemeConfig = getAntdThemeConfig(themeId);
  const previousRoomIdRef = useRef<string | null>(null);
  const joiningRoomIdRef = useRef<string | null>(null);
  useSystemThemeListener();
  useRoomWebSocket();
  useCitizenWebSocket();
  usePollingSync();

  const route = useMemo(() => parseAppPath(pathname), [pathname]);

  useEffect(() => {
    applyThemeCssVars(themeId);
  }, [themeId]);

  useEffect(() => {
    useCitizenStore.getState().restoreFromStorage();
  }, []);

  useEffect(() => {
    const roomStore = useRoomStore.getState();

    if (!principal) {
      roomStore.reset();
      return;
    }

    roomStore.restoreRecentRooms();
    void roomStore.refreshLobbyPresence();
    void roomStore.refreshJoinedRooms();
  }, [principal]);

  useEffect(() => {
    const onPopState = () => {
      setPathname(window.location.pathname);
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const currentRoomId = room?.id ?? null;
    const previousRoomId = previousRoomIdRef.current;
    const desiredRoomPath = currentRoomId ? `/rooms/${currentRoomId}` : null;
    const previousRoomPath = previousRoomId ? `/rooms/${previousRoomId}` : null;

    if (desiredRoomPath && pathname !== desiredRoomPath) {
      window.history.pushState(null, "", desiredRoomPath);
      setPathname(desiredRoomPath);
    } else if (!desiredRoomPath && previousRoomPath && pathname === previousRoomPath) {
      window.history.pushState(null, "", "/");
      setPathname("/");
    }

    previousRoomIdRef.current = currentRoomId;
  }, [pathname, room]);

  useEffect(() => {
    const roomStore = useRoomStore.getState();
    const liveRoute = parseAppPath(window.location.pathname);

    if (route.roomId) {
      if (!principal || room || joiningRoomIdRef.current === route.roomId) {
        return;
      }

      joiningRoomIdRef.current = route.roomId;
      void roomStore.joinExistingRoom(route.roomId).catch(() => {
        if (window.location.pathname === `/rooms/${route.roomId}`) {
          window.history.replaceState(null, "", "/");
          setPathname("/");
        }
      }).finally(() => {
        if (joiningRoomIdRef.current === route.roomId) {
          joiningRoomIdRef.current = null;
        }
      });
      return;
    }

    if (room && !liveRoute.roomId) {
      roomStore.clearCurrentRoom(room.id);
    }
  }, [pathname, principal, room, route.roomId]);

  return (
    <ConfigProvider theme={antdThemeConfig}>
      <AntdApp message={{ duration: 2.4 }}>
        <FeedbackBridge />
        <I18nextProvider i18n={i18n}>
          <ErrorBoundary>
            <div className="app-shell">
              <aside className="room-sidebar">
                <div className="sidebar-brand">
                  <span className="brand-icon">AT</span>
                  <div className="brand-text">
                    <span className="brand-name">AgentTavern</span>
                    <span className="brand-subtitle">{t("sidebar.subtitle")}</span>
                  </div>
                </div>
                <ChatSidebar />
              </aside>
              <section className="chat-shell">
                <Suspense fallback={<AppLoading />}>
                  {room
                    ? <RoomEntry />
                    : <HomeEntry inviteToken={route.joinInviteToken} hasPrincipal={Boolean(principal)} />}
                </Suspense>
              </section>
              <OnlineMembersPanel />
            </div>
          </ErrorBoundary>
        </I18nextProvider>
      </AntdApp>
    </ConfigProvider>
  );
}

export default App;
