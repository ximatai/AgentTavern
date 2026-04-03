import { Header } from "./Header";
import { InputBar } from "./InputBar";
import { MessageList } from "./MessageList";
import { RoomSidebar } from "./RoomSidebar";

export function RoomEntry() {
  return (
    <>
      <Header />
      <div className="chat-layout">
        <section className="message-column">
          <section className="message-panel">
            <MessageList />
          </section>
          <InputBar />
        </section>
        <aside className="member-sidebar">
          <RoomSidebar />
        </aside>
      </div>
    </>
  );
}
