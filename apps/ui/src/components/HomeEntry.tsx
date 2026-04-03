import { HomeStage } from "./HomeStage";
import { HomeSidebar } from "./HomeSidebar";
import { JoinInviteCard } from "./JoinInviteCard";

type HomeEntryProps = {
  inviteToken: string | null;
  hasPrincipal: boolean;
};

export function HomeEntry({ inviteToken, hasPrincipal }: HomeEntryProps) {
  return (
    <>
      <section className="message-panel">
        {inviteToken && hasPrincipal
          ? <JoinInviteCard inviteToken={inviteToken} />
          : <HomeStage inviteToken={inviteToken} />}
      </section>
      <aside className="member-sidebar">
        <HomeSidebar />
      </aside>
    </>
  );
}
