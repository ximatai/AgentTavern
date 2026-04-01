import { useEffect } from "react";
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
import { Header } from "./components/Header";
import { ChatSidebar } from "./components/ChatSidebar";
import { HomeStage } from "./components/HomeStage";
import { JoinInviteCard } from "./components/JoinInviteCard";
import { HomeSidebar } from "./components/HomeSidebar";
import { RoomSidebar } from "./components/RoomSidebar";
import { OnlineMembersPanel } from "./components/OnlineMembersPanel";
import { MessageList } from "./components/MessageList";
import { InputBar } from "./components/InputBar";
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

function FeedbackBridge() {
  const { message } = AntdApp.useApp();

  useEffect(() => {
    setMessageApi(message);
  }, [message]);

  return null;
}

function App() {
  const { t } = useTranslation();
  const principal = useCitizenStore((s) => s.principal);
  const room = useRoomStore((s) => s.room);
  const themeId = useSettingsStore((s) => s.themeId);
  const antdThemeConfig = getAntdThemeConfig(themeId);
  useSystemThemeListener();
  useRoomWebSocket();
  useCitizenWebSocket();
  usePollingSync();

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

  const joinInviteToken = (() => {
    const match = window.location.pathname.match(/^\/join\/([^/]+)$/);
    return match?.[1] ?? null;
  })();

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
                <Header />
                <div className="chat-layout">
                  <section className="message-column">
                    <section className="message-panel">
                      {room
                        ? <MessageList />
                        : joinInviteToken && principal
                          ? <JoinInviteCard inviteToken={joinInviteToken} />
                          : <HomeStage inviteToken={joinInviteToken} />}
                    </section>
                    {room ? <InputBar /> : null}
                  </section>
                  <aside className="member-sidebar">
                    {room ? <RoomSidebar /> : <HomeSidebar />}
                  </aside>
                </div>
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
