import { useEffect, useRef, useState } from "react";

import type {
  PublicApproval,
  PublicMessage,
  PublicMember,
  RealtimeEvent,
  Room,
} from "@agent-tavern/shared";

type SessionStream = {
  sessionId: string;
  messageId: string;
  agentMemberId: string;
  content: string;
};

type SessionActor = {
  agentMemberId: string;
};

type JoinResult = {
  memberId: string;
  roomId: string;
  displayName: string;
  wsToken: string;
};

type AssistantInviteResult = {
  id: string;
  roomId: string;
  ownerMemberId: string;
  presetDisplayName: string | null;
  backendType: "codex_cli" | "local_process";
  inviteToken: string;
  inviteUrl: string;
  status: "pending" | "accepted" | "expired" | "revoked";
  expiresAt: string;
  createdAt: string;
};

const demoAgentArgs = [
  "--input-type=module",
  "-e",
  "let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',async()=>{const lines=input.trim().split('\\n').filter(Boolean);const tail=lines.at(-1) ?? 'ready';const reply=`Tavern demo agent: ${tail}`;for (const chunk of [reply.slice(0, 18), reply.slice(18)]) { if (!chunk) continue; process.stdout.write(chunk); await new Promise(r=>setTimeout(r,120)); }});",
].join("\n");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const payload = (await response.json().catch(() => null)) as T | { error?: string } | null;

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload && payload.error
        ? payload.error
        : `request failed with status ${response.status}`;
    throw new Error(message);
  }

  return payload as T;
}

function extractInviteToken(input: string): string {
  const trimmed = input.trim();

  if (!trimmed) {
    return "";
  }

  if (!trimmed.includes("/")) {
    return trimmed;
  }

  const parts = trimmed.split("/");
  return parts.at(-1)?.trim() ?? "";
}

function sortByCreatedAt<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function isRealtimeEvent(payload: unknown): payload is RealtimeEvent {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  return "type" in payload && typeof payload.type === "string" && "payload" in payload;
}

function roleLabel(member: Pick<PublicMember, "type" | "roleKind">): string {
  if (member.type !== "agent") {
    return "human";
  }

  return member.roleKind === "assistant" ? "assistant" : "agent";
}

function App() {
  const [roomName, setRoomName] = useState("Tavern Room");
  const [nickname, setNickname] = useState("Alice");
  const [inviteInput, setInviteInput] = useState("");
  const [messageInput, setMessageInput] = useState("");
  const [agentName, setAgentName] = useState("BackendDev");
  const [agentRoleKind, setAgentRoleKind] = useState<"independent" | "assistant">(
    "independent",
  );
  const [agentCommand, setAgentCommand] = useState("node");
  const [agentArgsText, setAgentArgsText] = useState(demoAgentArgs);
  const [agentInputFormat, setAgentInputFormat] = useState<"text" | "json">("text");
  const [assistantOwnerId, setAssistantOwnerId] = useState("");
  const [assistantInviteName, setAssistantInviteName] = useState("CodexThreadA");
  const [assistantInviteUrl, setAssistantInviteUrl] = useState("");
  const [room, setRoom] = useState<Room | null>(null);
  const [self, setSelf] = useState<JoinResult | null>(null);
  const [members, setMembers] = useState<PublicMember[]>([]);
  const [messages, setMessages] = useState<PublicMessage[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<PublicApproval[]>([]);
  const [streams, setStreams] = useState<Record<string, SessionStream>>({});
  const [sessionActors, setSessionActors] = useState<Record<string, SessionActor>>({});
  const [statusText, setStatusText] = useState("Ready");
  const [errorText, setErrorText] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const selfRef = useRef<JoinResult | null>(null);
  const sessionActorsRef = useRef<Record<string, SessionActor>>({});

  useEffect(() => {
    selfRef.current = self;
  }, [self]);

  useEffect(() => {
    sessionActorsRef.current = sessionActors;
  }, [sessionActors]);

  useEffect(() => {
    return () => {
      socketRef.current?.close();
    };
  }, []);

  async function hydrateRoomState(nextRoomId: string): Promise<void> {
    const [nextRoom, nextMembers, nextMessages] = await Promise.all([
      request<Room>(`/api/rooms/${nextRoomId}`),
      request<PublicMember[]>(`/api/rooms/${nextRoomId}/members`),
      request<PublicMessage[]>(`/api/rooms/${nextRoomId}/messages`),
    ]);

    setRoom(nextRoom);
    setMembers(nextMembers);
    setMessages(sortByCreatedAt(nextMessages));
    setPendingApprovals([]);
    setStreams({});
    setSessionActors({});
  }

  function connectSocket(joinResult: JoinResult): void {
    socketRef.current?.close();

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(
      `${protocol}//${window.location.host}/ws?roomId=${joinResult.roomId}&memberId=${joinResult.memberId}&wsToken=${joinResult.wsToken}`,
    );

    socket.addEventListener("open", () => {
      setStatusText("Realtime connected");
    });

    socket.addEventListener("close", () => {
      setStatusText("Realtime disconnected");
    });

    socket.addEventListener("message", (event) => {
      const rawPayload = JSON.parse(String(event.data)) as unknown;

      if (!isRealtimeEvent(rawPayload)) {
        return;
      }

      const payload = rawPayload;

      if (payload.type === "member.joined") {
        setMembers((current) => {
          const next = current.filter((member) => member.id !== payload.payload.member.id);
          next.push(payload.payload.member);
          return next;
        });
        return;
      }

      if (payload.type === "message.created") {
        setMessages((current) => {
          const next = current.filter((message) => message.id !== payload.payload.message.id);
          next.push(payload.payload.message);
          return sortByCreatedAt(next);
        });
        setStreams((current) => {
          const next = { ...current };
          delete next[payload.payload.message.id];
          return next;
        });
        return;
      }

      if (payload.type === "approval.requested") {
        setPendingApprovals((current) => {
          const next = current.filter((approval) => approval.id !== payload.payload.approval.id);
          next.push(payload.payload.approval);
          return next;
        });
        return;
      }

      if (payload.type === "approval.resolved") {
        setPendingApprovals((current) =>
          current.filter((approval) => approval.id !== payload.payload.approval.id),
        );
        return;
      }

      if (payload.type === "agent.session.started") {
        setSessionActors((current) => ({
          ...current,
          [payload.payload.session.id]: {
            agentMemberId: payload.payload.session.agentMemberId,
          },
        }));
        return;
      }

      if (payload.type === "agent.stream.delta") {
        setStreams((current) => {
          const actor = sessionActorsRef.current[payload.payload.sessionId];
          const existing = current[payload.payload.messageId];

          return {
            ...current,
            [payload.payload.messageId]: {
              sessionId: payload.payload.sessionId,
              messageId: payload.payload.messageId,
              agentMemberId: existing?.agentMemberId ?? actor?.agentMemberId ?? "",
              content: `${existing?.content ?? ""}${payload.payload.delta}`,
            },
          };
        });
        return;
      }

      if (payload.type === "agent.message.committed") {
        setStreams((current) => {
          const next = { ...current };
          delete next[payload.payload.message.id];
          return next;
        });
        return;
      }
    });

    socketRef.current = socket;
  }

  async function finishJoin(joinResult: JoinResult): Promise<void> {
    await hydrateRoomState(joinResult.roomId);
    setSelf(joinResult);
    setAssistantOwnerId(joinResult.memberId);
    connectSocket(joinResult);
  }

  async function handleCreateRoom(): Promise<void> {
    setErrorText("");
    setStatusText("Creating room");

    try {
      const createdRoom = await request<{
        id: string;
        inviteToken: string;
      }>("/api/rooms", {
        method: "POST",
        body: JSON.stringify({ name: roomName }),
      });
      const joinResult = await request<JoinResult>(`/api/rooms/${createdRoom.id}/join`, {
        method: "POST",
        body: JSON.stringify({ nickname }),
      });
      await finishJoin(joinResult);
      setInviteInput(createdRoom.inviteToken);
      setStatusText("Room ready");
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "failed to create room");
      setStatusText("Create room failed");
    }
  }

  async function handleJoinRoom(): Promise<void> {
    setErrorText("");
    setStatusText("Joining room");

    try {
      const token = extractInviteToken(inviteInput);
      const joinResult = await request<JoinResult>(`/api/invites/${token}/join`, {
        method: "POST",
        body: JSON.stringify({ nickname }),
      });
      await finishJoin(joinResult);
      setStatusText("Joined room");
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "failed to join room");
      setStatusText("Join room failed");
    }
  }

  async function handleSendMessage(): Promise<void> {
    if (!self || !messageInput.trim()) {
      return;
    }

    setErrorText("");

    try {
      await request<PublicMessage>(`/api/rooms/${self.roomId}/messages`, {
        method: "POST",
        body: JSON.stringify({
          senderMemberId: self.memberId,
          wsToken: self.wsToken,
          content: messageInput,
        }),
      });
      setMessageInput("");
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "failed to send message");
    }
  }

  async function handleCreateAgent(): Promise<void> {
    if (!self || !agentName.trim()) {
      return;
    }

    setErrorText("");

    try {
      await request<PublicMember>(`/api/rooms/${self.roomId}/members/agents`, {
        method: "POST",
        body: JSON.stringify({
          displayName: agentName.trim(),
          roleKind: agentRoleKind,
          actorMemberId: self.memberId,
          wsToken: self.wsToken,
          ownerMemberId: agentRoleKind === "assistant" ? assistantOwnerId || self.memberId : null,
          adapterType: "local_process",
          adapterConfig: {
            command: agentCommand.trim(),
            args: agentArgsText
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean),
            inputFormat: agentInputFormat,
          },
        }),
      });
      const nextMembers = await request<PublicMember[]>(`/api/rooms/${self.roomId}/members`);
      setMembers(nextMembers);
      setStatusText("Agent added");
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "failed to add agent");
    }
  }

  async function handleCreateAssistantInvite(): Promise<void> {
    if (!self) {
      return;
    }

    setErrorText("");

    try {
      const invite = await request<AssistantInviteResult>(
        `/api/rooms/${self.roomId}/assistant-invites`,
        {
          method: "POST",
          body: JSON.stringify({
            actorMemberId: self.memberId,
            wsToken: self.wsToken,
            backendType: "codex_cli",
            presetDisplayName: assistantInviteName.trim() || undefined,
          }),
        },
      );

      const fullInviteUrl = new URL(invite.inviteUrl, window.location.origin).toString();
      setAssistantInviteUrl(fullInviteUrl);
      setStatusText("Assistant invite ready");
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "failed to create assistant invite");
    }
  }

  async function handleCopyAssistantInvite(): Promise<void> {
    if (!assistantInviteUrl) {
      return;
    }

    setErrorText("");

    try {
      await navigator.clipboard.writeText(assistantInviteUrl);
      setStatusText("Assistant invite copied");
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "failed to copy invite");
    }
  }

  async function handleApproval(approvalId: string, action: "approve" | "reject"): Promise<void> {
    if (!self) {
      return;
    }

    setErrorText("");

    try {
      await request<PublicApproval>(`/api/approvals/${approvalId}/${action}`, {
        method: "POST",
        body: JSON.stringify({
          actorMemberId: self.memberId,
          wsToken: self.wsToken,
        }),
      });
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : `failed to ${action} approval`);
    }
  }

  const visibleMessages = sortByCreatedAt([
    ...messages,
    ...Object.values(streams).map((stream) => ({
      id: stream.messageId,
      roomId: self?.roomId ?? "",
      senderMemberId: stream.agentMemberId,
      messageType: "agent_text" as const,
      content: `${stream.content}▌`,
      replyToMessageId: null,
      createdAt: new Date().toISOString(),
    })),
  ]);

  const roomInviteUrl = room ? new URL(`/join/${room.inviteToken}`, window.location.origin).toString() : "";

  function findMember(memberId: string): PublicMember | undefined {
    return members.find((member) => member.id === memberId);
  }

  function formatTime(value: string): string {
    return new Date(value).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  return (
    <main className="lan-shell">
      <aside className="app-rail">
        <div className="brand-mark">AT</div>
        <div className="rail-stack">
          <button className="rail-item rail-item-active" type="button">
            <span>Rooms</span>
          </button>
          <button className="rail-item" type="button">
            <span>Agents</span>
          </button>
          <button className="rail-item" type="button">
            <span>Links</span>
          </button>
        </div>
        <div className="rail-user">{self?.displayName?.slice(0, 1) ?? "?"}</div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="topbar-title">
            <h1>{room?.name ?? "Agent Tavern"}</h1>
            <div className="live-badge">
              <span className="live-dot" />
              <span>{statusText}</span>
            </div>
          </div>
          <div className="topbar-meta">
            {roomInviteUrl ? (
              <button className="ghost-button" onClick={() => navigator.clipboard.writeText(roomInviteUrl)}>
                Copy room invite
              </button>
            ) : null}
            {errorText ? <p className="error-inline">{errorText}</p> : null}
          </div>
        </header>

        <div className="workspace-grid">
          <aside className="left-tools">
            <section className="tool-card">
              <div className="card-heading">
                <h2>Session</h2>
                <span>{self ? "joined" : "idle"}</span>
              </div>
              <label>
                <span>Room name</span>
                <input value={roomName} onChange={(event) => setRoomName(event.target.value)} />
              </label>
              <label>
                <span>Nickname</span>
                <input value={nickname} onChange={(event) => setNickname(event.target.value)} />
              </label>
              <div className="inline-actions">
                <button onClick={handleCreateRoom}>Create</button>
                <button className="ghost-button" onClick={handleJoinRoom}>
                  Join
                </button>
              </div>
              <label>
                <span>Invite token or URL</span>
                <input
                  value={inviteInput}
                  onChange={(event) => setInviteInput(event.target.value)}
                />
              </label>
              {self ? (
                <div className="session-facts">
                  <p>Room member: {self.displayName}</p>
                  <p>Invite token: {room?.inviteToken ?? "pending"}</p>
                </div>
              ) : null}
            </section>

            <section className="tool-card">
              <div className="card-heading">
                <h2>Invite Codex Thread</h2>
                <span>one-time</span>
              </div>
              <label>
                <span>Preset display name</span>
                <input
                  value={assistantInviteName}
                  onChange={(event) => setAssistantInviteName(event.target.value)}
                  placeholder="CodexThreadA"
                />
              </label>
              <button onClick={handleCreateAssistantInvite} disabled={!self}>
                Create assistant invite
              </button>
              {assistantInviteUrl ? (
                <div className="invite-result">
                  <p className="muted-text">One-time invite URL</p>
                  <textarea readOnly rows={4} value={assistantInviteUrl} />
                  <button className="ghost-button" onClick={handleCopyAssistantInvite}>
                    Copy invite URL
                  </button>
                </div>
              ) : null}
            </section>

            <section className="tool-card">
              <div className="card-heading">
                <h2>Add Local Agent</h2>
                <span>demo</span>
              </div>
              <label>
                <span>Display name</span>
                <input value={agentName} onChange={(event) => setAgentName(event.target.value)} />
              </label>
              <label>
                <span>Role</span>
                <select
                  value={agentRoleKind}
                  onChange={(event) =>
                    setAgentRoleKind(event.target.value as "independent" | "assistant")
                  }
                >
                  <option value="independent">Independent</option>
                  <option value="assistant">Assistant</option>
                </select>
              </label>
              {agentRoleKind === "assistant" ? (
                <label>
                  <span>Owner</span>
                  <select
                    value={assistantOwnerId}
                    onChange={(event) => setAssistantOwnerId(event.target.value)}
                  >
                    {members.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.displayName}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label>
                <span>Command</span>
                <input
                  value={agentCommand}
                  onChange={(event) => setAgentCommand(event.target.value)}
                />
              </label>
              <details className="advanced-config">
                <summary>Advanced config</summary>
                <label>
                  <span>Args</span>
                  <textarea
                    rows={5}
                    value={agentArgsText}
                    onChange={(event) => setAgentArgsText(event.target.value)}
                  />
                </label>
                <label>
                  <span>Input format</span>
                  <select
                    value={agentInputFormat}
                    onChange={(event) =>
                      setAgentInputFormat(event.target.value as "text" | "json")
                    }
                  >
                    <option value="text">text</option>
                    <option value="json">json</option>
                  </select>
                </label>
              </details>
              <button onClick={handleCreateAgent} disabled={!self}>
                Add local agent
              </button>
            </section>
          </aside>

          <section className="chat-stage">
            <div className="day-marker">Today</div>
            <div className="message-stream">
              {visibleMessages.map((message) => {
                const sender = findMember(message.senderMemberId);
                const isAgent = sender?.type === "agent" || message.messageType === "agent_text";
                const isSelf = message.senderMemberId === self?.memberId;

                return (
                  <article
                    key={message.id}
                    className={`chat-row ${isAgent ? "chat-row-agent" : ""} ${isSelf ? "chat-row-self" : ""}`}
                  >
                    <header className="chat-meta">
                      <div className="chat-author">
                        <strong>{sender?.displayName ?? message.senderMemberId}</strong>
                        {sender ? <span className="agent-pill">{roleLabel(sender)}</span> : null}
                      </div>
                      <span>{formatTime(message.createdAt)}</span>
                    </header>
                    <div className={`chat-bubble ${isAgent ? "chat-bubble-agent" : ""}`}>
                      <p>{message.content}</p>
                    </div>
                  </article>
                );
              })}
            </div>

            <div className="composer-dock">
              <textarea
                rows={3}
                value={messageInput}
                onChange={(event) => setMessageInput(event.target.value)}
                placeholder="Type a message, for example: @BackendDev 帮我看一下"
              />
              <button onClick={handleSendMessage} disabled={!self || !messageInput.trim()}>
                Send
              </button>
            </div>
          </section>

          <aside className="right-sidebar">
            <section className="side-card">
              <div className="card-heading">
                <h2>Active in Room</h2>
                <span>{members.length}</span>
              </div>
              <div className="presence-list">
                {members.map((member) => {
                  const owner = member.ownerMemberId ? findMember(member.ownerMemberId) : null;

                  return (
                    <article key={member.id} className="presence-item">
                      <div className={`presence-avatar ${member.type === "agent" ? "presence-avatar-agent" : ""}`}>
                        {member.displayName.slice(0, 1)}
                      </div>
                      <div className="presence-copy">
                        <div className="presence-title">
                          <strong>{member.displayName}</strong>
                          <span className="agent-pill">{roleLabel(member)}</span>
                        </div>
                        <p>
                          {owner ? `Owner ${owner.displayName}` : "Independent member"}
                        </p>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>

            <section className="side-card">
              <div className="card-heading">
                <h2>Pending approvals</h2>
                <span>{pendingApprovals.length}</span>
              </div>
              <div className="approval-list">
                {pendingApprovals.length === 0 ? <p className="muted-text">No pending approvals.</p> : null}
                {pendingApprovals.map((approval) => {
                  const agent = findMember(approval.agentMemberId);
                  const requester = findMember(approval.requesterMemberId);
                  const owner = findMember(approval.ownerMemberId);

                  return (
                    <article key={approval.id} className="approval-card">
                      <div>
                        <strong>{agent?.displayName ?? approval.agentMemberId}</strong>
                        <p>Role: {agent ? roleLabel(agent) : "agent"}</p>
                        <p>Requester: {requester?.displayName ?? approval.requesterMemberId}</p>
                        <p>Owner: {owner?.displayName ?? approval.ownerMemberId}</p>
                      </div>
                      <div className="approval-actions">
                        <button
                          onClick={() => handleApproval(approval.id, "approve")}
                          disabled={approval.ownerMemberId !== self?.memberId}
                        >
                          Approve
                        </button>
                        <button
                          className="ghost-button"
                          onClick={() => handleApproval(approval.id, "reject")}
                          disabled={approval.ownerMemberId !== self?.memberId}
                        >
                          Reject
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          </aside>
        </div>
      </section>
    </main>
  );
}

export default App;
