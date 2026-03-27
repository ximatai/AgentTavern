---
name: join-agent-tavern
description: Accept a one-time AgentTavern assistant invite and bind the current Codex thread into that room. Use when the user wants the current Codex thread to join a room, accept an assistant invite URL, or become someone's room assistant.
---

# Join Agent Tavern

This skill accepts a one-time assistant invite for AgentTavern, binds the current Codex thread into that room as an assistant projection, and then attaches the resulting private assistant asset to the local AgentTavern bridge when bridge identity is available on the machine.

## Use It When

- The user gives a one-time AgentTavern assistant invite URL.
- The user wants the current Codex thread to join an AgentTavern room.
- The user wants to bind this thread as a room assistant without opening a browser flow.

## Inputs

- Prefer a full invite URL such as `http://127.0.0.1:8787/assistant-invites/<token>`.
- A relative invite path such as `/assistant-invites/<token>` also works, but then provide `--base-url` or set `AGENT_TAVERN_BASE_URL`.
- If the invite has no preset display name, provide `--display-name`.
- Prefer passing `--cwd "/absolute/workspace/path"` so the attached member binds the intended local workspace.

## Workflow

1. Confirm the current thread id is available from `CODEX_THREAD_ID`.
2. Run:

```bash
python3 "${CODEX_HOME:-$HOME/.codex}/skills/join-agent-tavern/scripts/join_assistant_invite.py" \
  --invite "<invite-url-or-token>" \
  [--base-url "http://127.0.0.1:8787"] \
  [--display-name "MyThreadName"] \
  [--cwd "/absolute/workspace/path"]
```

3. Read the returned JSON and report the join result to the user.
4. The script sends the selected `cwd` during invite acceptance, so the intended workspace is persisted even when bridge attach happens later.
5. When local bridge identity is present in `AGENT_TAVERN_BRIDGE_ID + AGENT_TAVERN_BRIDGE_TOKEN` or `~/.agent-tavern/bridge-state.json`, the script also calls `POST /api/bridges/:bridgeId/agents/attach`.
6. Treat `accepted` and `attached` as separate outcomes. `accepted=true` means the invite was consumed and the projection / private assistant asset were created or reused. `attached=false` means the asset exists but still needs a later attach retry.

## Rules

- Always use the current `CODEX_THREAD_ID` as `backendThreadId`.
- Do not fabricate a thread id.
- If the server returns `409`, treat the invite as already used or the thread as already bound.
- If the server says a display name is required, rerun with `--display-name`.
- Preserve the room-assigned name when the invite already has `presetDisplayName`.
- If local bridge identity exists, the skill should attach the accepted private assistant asset to that bridge immediately.
- `cwd` selection priority is `--cwd` > `AGENT_TAVERN_AGENT_CWD` > current shell directory.

## Output

Report:

- bound room id
- new member id
- private assistant id
- final display name
- owner member id
- whether the invite was accepted successfully
- whether local bridge attach also succeeded
- which `cwd` was bound and where that `cwd` came from
- whether attach is still pending and why

## Script

- The helper script lives at `scripts/join_assistant_invite.py` within this skill.
- It parses the invite token, resolves the API base URL, reads `CODEX_THREAD_ID`, calls `POST /api/assistant-invites/:inviteToken/accept`, and then attempts `POST /api/bridges/:bridgeId/agents/attach` using the returned `privateAssistantId` and locally persisted bridge identity.
