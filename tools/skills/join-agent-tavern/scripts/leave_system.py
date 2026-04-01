#!/usr/bin/env python3
import argparse
import json
import os
import sys

from join_room_invite import (
    DEFAULT_BASE_URL,
    normalize_base_url,
    post_json,
    resolve_cwd,
    resolve_display_name,
    resolve_login_key,
    resolve_thread_id,
)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Leave AgentTavern entirely as the current agent principal."
    )
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

    base_url = normalize_base_url(args.base_url or os.environ.get("AGENT_TAVERN_BASE_URL") or DEFAULT_BASE_URL)
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

    citizen_id = bootstrap_data.get("citizenId", "")
    leave_status, leave_data = post_json(
        f"{base_url}/api/citizens/{citizen_id}/leave-system",
        {
            "citizenToken": bootstrap_data.get("citizenToken", ""),
        },
    )
    ok = 200 <= leave_status < 300
    print(json.dumps({
        "ok": ok,
        "bootstrapped": True,
        "leftSystem": ok and bool(leave_data.get("leftSystem")),
        "status": leave_status,
        "baseUrl": base_url,
        "citizenId": citizen_id,
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
