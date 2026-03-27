#!/usr/bin/env python3
import argparse
import json
import os
import re
from pathlib import Path
import sys
from typing import Dict, Optional, Tuple
import urllib.error
import urllib.parse
import urllib.request


DEFAULT_BASE_URL = "http://127.0.0.1:8787"
DEFAULT_BRIDGE_STATE_PATH = os.path.join(Path.home(), ".agent-tavern", "bridge-state.json")
INVITE_PATH_RE = re.compile(r"/assistant-invites/([^/?#]+)")


def resolve_cwd(explicit_cwd: Optional[str]) -> Tuple[str, str]:
    if explicit_cwd and explicit_cwd.strip():
        return os.path.abspath(explicit_cwd.strip()), "arg"

    env_cwd = os.environ.get("AGENT_TAVERN_AGENT_CWD", "").strip()
    if env_cwd:
        return os.path.abspath(env_cwd), "env"

    return os.getcwd(), "process"


def normalize_base_url(value: str) -> str:
    return value.rstrip("/")


def parse_invite(invite: str, explicit_base_url: Optional[str]) -> Tuple[str, str]:
    invite = invite.strip()
    if not invite:
        raise ValueError("invite is required")

    parsed = urllib.parse.urlparse(invite)
    if parsed.scheme and parsed.netloc:
        match = INVITE_PATH_RE.search(parsed.path)
        if not match:
            raise ValueError("invite URL must contain /assistant-invites/<token>")
        base_url = f"{parsed.scheme}://{parsed.netloc}"
        return match.group(1), normalize_base_url(base_url)

    match = INVITE_PATH_RE.search(invite)
    if match:
        base_url = explicit_base_url or os.environ.get("AGENT_TAVERN_BASE_URL") or DEFAULT_BASE_URL
        return match.group(1), normalize_base_url(base_url)

    if "/" not in invite and "?" not in invite and "#" not in invite:
        base_url = explicit_base_url or os.environ.get("AGENT_TAVERN_BASE_URL") or DEFAULT_BASE_URL
        return invite, normalize_base_url(base_url)

    raise ValueError("invite must be a full URL, a relative /assistant-invites/<token> path, or a raw token")


def decode_json_body(body: str) -> dict:
    if not body:
        return {}

    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return {"error": "non-json response", "rawBody": body[:500]}


def post_json(url: str, payload: Dict[str, str]) -> Tuple[int, dict]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            body = response.read().decode("utf-8")
            return response.status, decode_json_body(body)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8")
        return exc.code, decode_json_body(body)
    except urllib.error.URLError as exc:
        return 599, {"error": "network error", "reason": str(exc.reason)}
    except TimeoutError:
        return 598, {"error": "request timeout"}
    except Exception as exc:
        return 597, {"error": "unexpected request error", "reason": str(exc)}


def read_bridge_identity() -> Optional[Dict[str, str]]:
    bridge_id = os.environ.get("AGENT_TAVERN_BRIDGE_ID", "").strip()
    bridge_token = os.environ.get("AGENT_TAVERN_BRIDGE_TOKEN", "").strip()

    if bridge_id and bridge_token:
        return {"bridgeId": bridge_id, "bridgeToken": bridge_token}

    state_path = os.environ.get("AGENT_TAVERN_BRIDGE_STATE_PATH", DEFAULT_BRIDGE_STATE_PATH)

    if not os.path.exists(state_path):
        return None

    try:
        with open(state_path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception:
        return None

    bridge_id = str(data.get("bridgeId", "")).strip()
    bridge_token = str(data.get("bridgeToken", "")).strip()

    if bridge_id and bridge_token:
        return {"bridgeId": bridge_id, "bridgeToken": bridge_token}

    return None


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Accept an AgentTavern assistant invite for the current Codex thread."
    )
    parser.add_argument("--invite", required=True, help="Invite URL, relative invite path, or raw token")
    parser.add_argument("--base-url", help="AgentTavern server base URL")
    parser.add_argument("--display-name", help="Display name to use when the invite has no preset name")
    parser.add_argument("--cwd", help="Workspace directory to bind for later local execution")
    args = parser.parse_args()

    thread_id = os.environ.get("CODEX_THREAD_ID", "").strip()
    if not thread_id:
        print(json.dumps({"ok": False, "error": "CODEX_THREAD_ID is not available"}))
        return 1

    try:
        invite_token, base_url = parse_invite(args.invite, args.base_url)
    except ValueError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1

    selected_cwd, cwd_source = resolve_cwd(args.cwd)

    payload = {
        "backendThreadId": thread_id,
        "cwd": selected_cwd,
    }
    if args.display_name:
        payload["displayName"] = args.display_name.strip()

    status, data = post_json(f"{base_url}/api/assistant-invites/{invite_token}/accept", payload)
    accepted = 200 <= status < 300
    result = {
        "ok": accepted,
        "accepted": accepted,
        "status": status,
        "baseUrl": base_url,
        "inviteToken": invite_token,
        "backendThreadId": thread_id,
        "cwd": selected_cwd,
        "cwdSource": cwd_source,
        "response": data,
    }

    if not accepted:
        print(json.dumps(result, ensure_ascii=True))
        return 1

    bridge_identity = read_bridge_identity()
    if not bridge_identity:
        result["attached"] = False
        result["attachPending"] = True
        result["attachError"] = "local bridge identity not found"
        print(json.dumps(result, ensure_ascii=True))
        return 0

    attach_payload = {
        "bridgeToken": bridge_identity["bridgeToken"],
        "privateAssistantId": data.get("privateAssistantId", ""),
        "cwd": selected_cwd,
    }
    if not attach_payload["privateAssistantId"]:
        attach_payload["memberId"] = data.get("memberId", "")
    attach_status, attach_data = post_json(
        f"{base_url}/api/bridges/{bridge_identity['bridgeId']}/agents/attach",
        attach_payload,
    )
    result["attach"] = {
        "status": attach_status,
        "bridgeId": bridge_identity["bridgeId"],
        "response": attach_data,
    }
    result["attached"] = 200 <= attach_status < 300
    if not result["attached"]:
        result["attachPending"] = True
        result["attachError"] = attach_data.get("error", "attach failed")

    print(json.dumps(result, ensure_ascii=True))
    return 0 if result["accepted"] else 1


if __name__ == "__main__":
    sys.exit(main())
