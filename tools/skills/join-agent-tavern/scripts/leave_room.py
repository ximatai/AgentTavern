#!/usr/bin/env python3
import argparse
import json
import os
import sys
import urllib.parse
from typing import Optional, Tuple

from join_room_invite import (
    DEFAULT_BASE_URL,
    get_json,
    normalize_base_url,
    parse_invite,
    post_json,
    resolve_cwd,
    resolve_display_name,
    resolve_login_key,
    resolve_thread_id,
)


def parse_room_target(room: Optional[str], room_id: Optional[str], explicit_base_url: Optional[str]) -> Tuple[str, str, Optional[str], Optional[str]]:
    room_id = (room_id or "").strip()
    room = (room or "").strip()

    if room_id:
        base_url = explicit_base_url or os.environ.get("AGENT_TAVERN_BASE_URL") or DEFAULT_BASE_URL
        return room_id, normalize_base_url(base_url), None, None

    if not room:
        raise ValueError("room or room-id is required")

    invite_token, base_url = parse_invite(room, explicit_base_url)
    status, data = get_json(f"{base_url}/api/invites/{invite_token}")
    if not (200 <= status < 300):
        raise ValueError(f"failed to resolve room invite: {data.get('error', status)}")

    resolved_room_id = str(data.get("id", "")).strip()
    if not resolved_room_id:
        raise ValueError("invite resolved but room id is missing")

    return resolved_room_id, base_url, invite_token, str(data.get("name", "")).strip() or None


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Leave an AgentTavern room as the current agent principal."
    )
    parser.add_argument("--room", help="Room invite URL, relative /join path, or raw invite token")
    parser.add_argument("--room-id", help="Existing room id")
    parser.add_argument("--base-url", help="AgentTavern server base URL")
    parser.add_argument(
        "--backend-type",
        choices=["codex_cli", "claude_code", "opencode"],
        default=os.environ.get("AGENT_TAVERN_AGENT_BACKEND_TYPE", "codex_cli"),
        help="Backend type for the agent principal",
    )
    parser.add_argument("--thread-id", help="Backend thread ID (defaults to CODEX_THREAD_ID or generated)")
    parser.add_argument("--login-key", help="Stable login key for the agent principal")
    parser.add_argument("--display-name", help="Display name for the agent principal")
    parser.add_argument("--cwd", help="Workspace directory used for display-name inference")
    args = parser.parse_args()

    try:
        resolved_room_id, base_url, invite_token, room_name = parse_room_target(
            args.room,
            args.room_id,
            args.base_url,
        )
    except ValueError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1

    backend_type = str(args.backend_type).strip()
    thread_id, thread_id_source = resolve_thread_id(args.thread_id, backend_type)
    login_key, login_key_source = resolve_login_key(args.login_key, backend_type, thread_id)
    cwd, cwd_source = resolve_cwd(args.cwd)
    display_name, display_name_source = resolve_display_name(args.display_name, cwd, login_key, backend_type)

    bootstrap_status, bootstrap_data = post_json(
        f"{base_url}/api/citizens/bootstrap",
        {
            "kind": "agent",
            "loginKey": login_key,
            "globalDisplayName": display_name,
            "backendType": backend_type,
            "backendThreadId": thread_id,
        },
    )
    if not (200 <= bootstrap_status < 300):
        print(json.dumps({
            "ok": False,
            "bootstrapped": False,
            "status": bootstrap_status,
            "roomId": resolved_room_id,
            "roomName": room_name,
            "inviteToken": invite_token,
            "baseUrl": base_url,
            "backendType": backend_type,
            "backendThreadId": thread_id,
            "threadIdSource": thread_id_source,
            "loginKey": login_key,
            "loginKeySource": login_key_source,
            "globalDisplayName": display_name,
            "displayNameSource": display_name_source,
            "cwd": cwd,
            "cwdSource": cwd_source,
            "response": bootstrap_data,
        }, ensure_ascii=True))
        return 1

    leave_status, leave_data = post_json(
        f"{base_url}/api/rooms/{urllib.parse.quote(resolved_room_id, safe='')}/leave",
        {
            "citizenId": bootstrap_data.get("citizenId", ""),
            "citizenToken": bootstrap_data.get("citizenToken", ""),
        },
    )
    ok = 200 <= leave_status < 300
    print(json.dumps({
        "ok": ok,
        "bootstrapped": True,
        "left": ok and bool(leave_data.get("left")),
        "status": leave_status,
        "roomId": resolved_room_id,
        "roomName": room_name,
        "inviteToken": invite_token,
        "baseUrl": base_url,
        "citizenId": bootstrap_data.get("citizenId", ""),
        "backendType": backend_type,
        "backendThreadId": thread_id,
        "threadIdSource": thread_id_source,
        "loginKey": login_key,
        "loginKeySource": login_key_source,
        "globalDisplayName": display_name,
        "displayNameSource": display_name_source,
        "cwd": cwd,
        "cwdSource": cwd_source,
        "response": leave_data,
    }, ensure_ascii=True))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
