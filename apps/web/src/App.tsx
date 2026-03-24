import { useEffect, useRef, useState } from "react";

import type {
  Approval,
  Member,
  Message,
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
  const [room, setRoom] = useState<Room | null>(null);
  const [self, setSelf] = useState<JoinResult | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<Approval[]>([]);
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
      request<Member[]>(`/api/rooms/${nextRoomId}/members`),
      request<Message[]>(`/api/rooms/${nextRoomId}/messages`),
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
      await request<Message>(`/api/rooms/${self.roomId}/messages`, {
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
      await request<Member>(`/api/rooms/${self.roomId}/members/agents`, {
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
      const nextMembers = await request<Member[]>(`/api/rooms/${self.roomId}/members`);
      setMembers(nextMembers);
      setStatusText("Agent added");
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "failed to add agent");
    }
  }

  async function handleApproval(approvalId: string, action: "approve" | "reject"): Promise<void> {
    if (!self) {
      return;
    }

    setErrorText("");

    try {
      await request<Approval>(`/api/approvals/${approvalId}/${action}`, {
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

  return (
    <main className="shell">
      <section className="hero-card">
        <div>
          <p className="eyebrow">AGENT TAVERN</p>
          <h1>Room-first chat for humans and local agents.</h1>
          <p className="hero-copy">
            当前页面已接上房间、成员、消息、审批和本地 Agent 流式事件。后面替换成酒馆式像素 UI 时，复用同一套事件协议。
          </p>
        </div>
        <div className="status-panel">
          <span>Status</span>
          <strong>{statusText}</strong>
          {room ? <p>Room: {room.name}</p> : null}
          {self ? <p>Member: {self.displayName}</p> : null}
          {errorText ? <p className="error-text">{errorText}</p> : null}
        </div>
      </section>

      <section className="grid-layout">
        <aside className="sidebar-card">
          <div className="panel">
            <h2>Create Room</h2>
            <label>
              <span>Room name</span>
              <input value={roomName} onChange={(event) => setRoomName(event.target.value)} />
            </label>
            <label>
              <span>Nickname</span>
              <input value={nickname} onChange={(event) => setNickname(event.target.value)} />
            </label>
            <button onClick={handleCreateRoom}>Create and join</button>
          </div>

          <div className="panel">
            <h2>Join Room</h2>
            <label>
              <span>Invite token or URL</span>
              <input
                value={inviteInput}
                onChange={(event) => setInviteInput(event.target.value)}
              />
            </label>
            <button onClick={handleJoinRoom}>Join by invite</button>
          </div>

          <div className="panel">
            <h2>Add Agent</h2>
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
            <label>
              <span>Args (one per line)</span>
              <textarea
                rows={6}
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
            <button onClick={handleCreateAgent} disabled={!self}>
              Add local agent
            </button>
          </div>
        </aside>

        <section className="content-column">
          <div className="panel">
            <div className="panel-header">
              <h2>Members</h2>
              <span>{members.length}</span>
            </div>
            <ul className="member-list">
              {members.map((member) => (
                <li key={member.id}>
                  <strong>{member.displayName}</strong>
                  <span>
                    {member.type} / {member.roleKind}
                    {member.ownerMemberId ? ` / owner ${member.ownerMemberId}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="panel approvals-panel">
            <div className="panel-header">
              <h2>Pending approvals</h2>
              <span>{pendingApprovals.length}</span>
            </div>
            <div className="approval-list">
              {pendingApprovals.length === 0 ? (
                <p className="muted-text">No pending approvals.</p>
              ) : null}
              {pendingApprovals.map((approval) => (
                <article key={approval.id} className="approval-card">
                  <div>
                    <strong>{approval.agentMemberId}</strong>
                    <p>Requester: {approval.requesterMemberId}</p>
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
              ))}
            </div>
          </div>

          <div className="panel messages-panel">
            <div className="panel-header">
              <h2>Room feed</h2>
              <span>{visibleMessages.length}</span>
            </div>
            <div className="message-list">
              {visibleMessages.map((message) => {
                const sender = members.find((member) => member.id === message.senderMemberId);

                return (
                  <article key={message.id} className="message-card">
                    <header>
                      <strong>{sender?.displayName ?? message.senderMemberId}</strong>
                      <span>{message.messageType}</span>
                    </header>
                    <p>{message.content}</p>
                  </article>
                );
              })}
            </div>
            <div className="composer">
              <textarea
                rows={3}
                value={messageInput}
                onChange={(event) => setMessageInput(event.target.value)}
                placeholder="Type a message, for example: @BackendDev 帮我看一下"
              />
              <button onClick={handleSendMessage} disabled={!self || !messageInput.trim()}>
                Send message
              </button>
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}

export default App;
