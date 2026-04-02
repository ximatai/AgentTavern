#!/usr/bin/env python3
import argparse
import glob
import json
import os
import re
import socket
import sys
import uuid
from pathlib import Path
from typing import Dict, Optional, Tuple
import urllib.error
import urllib.parse
import urllib.request


DEFAULT_BASE_URL = "http://127.0.0.1:8787"
DEFAULT_BRIDGE_STATE_PATH = os.path.join(Path.home(), ".agent-tavern", "bridge-state.json")
JOIN_PATH_RE = re.compile(r"/join/([^/?#]+)")


def normalize_base_url(value: str) -> str:
    return value.rstrip("/")


def resolve_api_base_url(parsed: urllib.parse.ParseResult, explicit_base_url: Optional[str]) -> str:
    if explicit_base_url and explicit_base_url.strip():
        return normalize_base_url(explicit_base_url.strip())

    hostname = parsed.hostname or "127.0.0.1"
    if parsed.port in (5173, 5174):
        return f"{parsed.scheme}://{hostname}:8787"

    return normalize_base_url(f"{parsed.scheme}://{parsed.netloc}")


def parse_invite(invite: str, explicit_base_url: Optional[str]) -> Tuple[str, str]:
    invite = invite.strip()
    if not invite:
        raise ValueError("invite is required")

    parsed = urllib.parse.urlparse(invite)
    if parsed.scheme and parsed.netloc:
        match = JOIN_PATH_RE.search(parsed.path)
        if not match:
            raise ValueError("invite URL must contain /join/<token>")
        base_url = resolve_api_base_url(parsed, explicit_base_url)
        return match.group(1), normalize_base_url(base_url)

    match = JOIN_PATH_RE.search(invite)
    if match:
        base_url = explicit_base_url or os.environ.get("AGENT_TAVERN_BASE_URL") or DEFAULT_BASE_URL
        return match.group(1), normalize_base_url(base_url)

    if "/" not in invite and "?" not in invite and "#" not in invite:
        base_url = explicit_base_url or os.environ.get("AGENT_TAVERN_BASE_URL") or DEFAULT_BASE_URL
        return invite, normalize_base_url(base_url)

    raise ValueError("invite must be a full URL, a relative /join/<token> path, or a raw token")


def decode_json_body(body: str) -> dict:
    if not body:
        return {}

    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return {"error": "non-json response", "rawBody": body[:500]}


def post_json(url: str, payload: Dict[str, object]) -> Tuple[int, dict]:
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


def get_json(url: str) -> Tuple[int, dict]:
    request = urllib.request.Request(url, method="GET")
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


def get_bridge_state_path(explicit_state_path: Optional[str]) -> str:
    if explicit_state_path and explicit_state_path.strip():
        return os.path.abspath(os.path.expanduser(explicit_state_path.strip()))
    configured = os.environ.get("AGENT_TAVERN_BRIDGE_STATE_PATH", DEFAULT_BRIDGE_STATE_PATH)
    return os.path.abspath(os.path.expanduser(configured))


def resolve_thread_id(explicit_thread_id: Optional[str], backend_type: str) -> Tuple[str, str]:
    if explicit_thread_id and explicit_thread_id.strip():
        return explicit_thread_id.strip(), "arg"

    codex_id = os.environ.get("CODEX_THREAD_ID", "").strip()
    if codex_id:
        return codex_id, "CODEX_THREAD_ID"

    prefix = backend_type.replace("_", "-")
    generated = f"{prefix}-{uuid.uuid4().hex[:16]}"
    return generated, "generated"


def resolve_cwd(explicit_cwd: Optional[str]) -> Tuple[str, str]:
    if explicit_cwd and explicit_cwd.strip():
        return os.path.abspath(explicit_cwd.strip()), "arg"

    env_cwd = os.environ.get("AGENT_TAVERN_AGENT_CWD", "").strip()
    if env_cwd:
        return os.path.abspath(env_cwd), "env"

    return os.getcwd(), "process"


def resolve_login_key(explicit_login_key: Optional[str], backend_type: str, thread_id: str) -> Tuple[str, str]:
    if explicit_login_key and explicit_login_key.strip():
        return explicit_login_key.strip(), "arg"

    env_login_key = os.environ.get("AGENT_TAVERN_AGENT_LOGIN_KEY", "").strip()
    if env_login_key:
        return env_login_key, "env"

    generated = f"agent:{backend_type}:{thread_id}"
    return generated, "generated"


def humanize_slug(value: str) -> str:
    cleaned = re.sub(r"[_\-]+", " ", value).strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    if not cleaned:
        return ""
    return " ".join(part[:1].upper() + part[1:] for part in cleaned.split(" "))


def infer_display_name_from_cwd(cwd: str) -> Optional[str]:
    base = os.path.basename(os.path.abspath(cwd)).strip()
    if not base:
        return None
    humanized = humanize_slug(base)
    return humanized or None


def infer_display_name_from_login_key(login_key: str) -> Optional[str]:
    normalized = login_key.strip()
    if not normalized:
        return None
    tail = normalized.split(":")[-1].strip()
    if not tail:
        return None
    humanized = humanize_slug(tail)
    return humanized or None


def resolve_display_name(explicit_display_name: Optional[str], cwd: str, login_key: str, backend_type: str) -> Tuple[str, str]:
    if explicit_display_name and explicit_display_name.strip():
        return explicit_display_name.strip(), "arg"

    env_display_name = os.environ.get("AGENT_TAVERN_AGENT_DISPLAY_NAME", "").strip()
    if env_display_name:
        return env_display_name, "env"

    inferred_from_cwd = infer_display_name_from_cwd(cwd)
    if inferred_from_cwd:
        return inferred_from_cwd, "cwd"

    inferred_from_login_key = infer_display_name_from_login_key(login_key)
    if inferred_from_login_key:
        return inferred_from_login_key, "loginKey"

    generated = humanize_slug(backend_type.replace("_", " ")) or "Agent"
    return generated, "backendType"


def read_bridge_identity_from_path(state_path: str) -> Optional[Dict[str, str]]:
    resolved_state_path = os.path.abspath(os.path.expanduser(state_path))
    bridge_id = os.environ.get("AGENT_TAVERN_BRIDGE_ID", "").strip()
    bridge_token = os.environ.get("AGENT_TAVERN_BRIDGE_TOKEN", "").strip()

    if bridge_id and bridge_token:
        return {
            "bridgeId": bridge_id,
            "bridgeToken": bridge_token,
            "source": "env",
            "statePath": resolved_state_path,
        }

    if not os.path.exists(resolved_state_path):
        return None

    try:
        with open(resolved_state_path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception:
        return None

    bridge_id = str(data.get("bridgeId", "")).strip()
    bridge_token = str(data.get("bridgeToken", "")).strip()
    if bridge_id and bridge_token:
        return {
            "bridgeId": bridge_id,
            "bridgeToken": bridge_token,
            "source": "file",
            "statePath": resolved_state_path,
            "serverBaseUrl": normalize_base_url(str(data.get("serverBaseUrl", "")).strip()) if data.get("serverBaseUrl") else "",
            "bridgeName": str(data.get("bridgeName", "")).strip(),
        }
    return None


def describe_bridge_identity(identity: Dict[str, str]) -> str:
    bridge_name = identity.get("bridgeName") or "(unnamed bridge)"
    bridge_id = identity.get("bridgeId") or "(missing bridgeId)"
    state_path = identity.get("statePath") or "(unknown state path)"
    candidate_base_url = identity.get("serverBaseUrl") or "(unknown server)"
    return f"{bridge_name} [{bridge_id}] {state_path} -> {candidate_base_url}"


def public_bridge_identity(identity: Dict[str, str]) -> Dict[str, str]:
    return {
        "bridgeId": identity.get("bridgeId", ""),
        "statePath": identity.get("statePath", ""),
        "serverBaseUrl": identity.get("serverBaseUrl", ""),
        "bridgeName": identity.get("bridgeName", ""),
    }


class BridgeSelectionError(RuntimeError):
    def __init__(self, message: str, *, code: str, candidates: Optional[list[Dict[str, str]]] = None):
        super().__init__(message)
        self.code = code
        self.candidates = candidates or []


def find_bridge_candidates(base_url: str) -> Tuple[list[Dict[str, str]], list[Dict[str, str]]]:
    state_dir = os.path.join(Path.home(), ".agent-tavern")
    all_candidates: list[Dict[str, str]] = []
    matching_candidates: list[Dict[str, str]] = []
    for state_path in sorted(glob.glob(os.path.join(state_dir, "*.json"))):
        identity = read_bridge_identity_from_path(state_path)
        if not identity:
            continue
        all_candidates.append(identity)
        candidate_base_url = normalize_base_url(identity.get("serverBaseUrl", "").strip())
        if candidate_base_url == base_url:
            matching_candidates.append(identity)
    return matching_candidates, all_candidates


def resolve_bridge_identity(explicit_state_path: Optional[str], base_url: str) -> Dict[str, str]:
    env_bridge_id = os.environ.get("AGENT_TAVERN_BRIDGE_ID", "").strip()
    env_bridge_token = os.environ.get("AGENT_TAVERN_BRIDGE_TOKEN", "").strip()
    if env_bridge_id and env_bridge_token:
        identity = read_bridge_identity_from_path(get_bridge_state_path(explicit_state_path))
        return identity or {
            "bridgeId": env_bridge_id,
            "bridgeToken": env_bridge_token,
            "source": "env",
            "statePath": get_bridge_state_path(explicit_state_path),
            "serverBaseUrl": base_url,
        }

    if explicit_state_path and explicit_state_path.strip():
        identity = read_bridge_identity_from_path(get_bridge_state_path(explicit_state_path))
        if not identity:
            raise RuntimeError(f"bridge state file not found or invalid: {get_bridge_state_path(explicit_state_path)}")
        return identity

    configured_state_path = os.environ.get("AGENT_TAVERN_BRIDGE_STATE_PATH", "").strip()
    if configured_state_path:
        identity = read_bridge_identity_from_path(get_bridge_state_path(configured_state_path))
        if not identity:
            raise RuntimeError(f"bridge state file not found or invalid: {get_bridge_state_path(configured_state_path)}")
        return identity

    matching_candidates, all_candidates = find_bridge_candidates(base_url)
    if not all_candidates:
        raise BridgeSelectionError(
            f"no local bridge found for {base_url}; start a bridge first, for example: "
            f"AGENT_TAVERN_SERVER_URL={base_url} pnpm dev:bridge",
            code="NO_LOCAL_BRIDGE",
        )
    if not matching_candidates:
        raise BridgeSelectionError(
            f"no local bridge is configured for {base_url}. Available local bridges: "
            + "; ".join(describe_bridge_identity(candidate) for candidate in all_candidates),
            code="NO_MATCHING_BRIDGE",
            candidates=[public_bridge_identity(candidate) for candidate in all_candidates],
        )
    if len(matching_candidates) > 1:
        raise BridgeSelectionError(
            f"multiple local bridges match {base_url}; choose one and re-run with --bridge-state-path",
            code="MULTIPLE_MATCHING_BRIDGES",
            candidates=[public_bridge_identity(candidate) for candidate in matching_candidates],
        )
    return matching_candidates[0]


def persist_bridge_identity(
    state_path: str,
    bridge_id: str,
    bridge_token: str,
    *,
    server_base_url: Optional[str] = None,
    bridge_name: Optional[str] = None,
) -> None:
    os.makedirs(os.path.dirname(state_path), exist_ok=True)
    with open(state_path, "w", encoding="utf-8") as handle:
        payload = {"bridgeId": bridge_id, "bridgeToken": bridge_token}
        if server_base_url:
            payload["serverBaseUrl"] = normalize_base_url(server_base_url)
        if bridge_name:
            payload["bridgeName"] = bridge_name
        json.dump(payload, handle, indent=2)


def resolve_bridge_name() -> str:
    configured_name = os.environ.get("AGENT_TAVERN_BRIDGE_NAME", "").strip()
    if configured_name:
        return configured_name
    hostname = socket.gethostname().strip()
    return hostname or "Local Bridge"


def register_bridge(base_url: str, bridge_identity: Optional[Dict[str, str]]) -> Tuple[int, dict]:
    payload = {
        "bridgeName": resolve_bridge_name(),
        "bridgeInstanceId": f"binst_{uuid.uuid4()}",
        "platform": sys.platform,
        "version": "join-agent-tavern-skill",
        "metadata": {
            "source": "join-agent-tavern-skill",
            "taskLoopEnabled": False,
        },
    }

    if bridge_identity:
        payload["bridgeId"] = bridge_identity.get("bridgeId", "")
        payload["bridgeToken"] = bridge_identity.get("bridgeToken", "")

    status, data = post_json(f"{base_url}/api/bridges/register", payload)
    if (status in (403, 404)) and bridge_identity:
        payload.pop("bridgeId", None)
        payload.pop("bridgeToken", None)
        status, data = post_json(f"{base_url}/api/bridges/register", payload)
    return status, data


def should_recover_stale_bridge(status: int, data: dict) -> bool:
    code = str(data.get("code", "")).strip().upper()
    if code in {"BRIDGE_NOT_FOUND", "INVALID_BRIDGE_CREDENTIALS"}:
        return True
    error = str(data.get("error", "")).strip().lower()
    return (status == 404 and error == "bridge not found") or (
        status == 403 and error == "invalid bridge credentials"
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Bootstrap the current backend thread as an agent principal and join an AgentTavern room invite."
    )
    parser.add_argument("--invite", required=True, help="Invite URL, relative /join path, or raw token")
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
    parser.add_argument("--cwd", help="Workspace directory to bind on bridge attach")
    parser.add_argument(
        "--bridge-state-path",
        help="Explicit bridge state file path (defaults to AGENT_TAVERN_BRIDGE_STATE_PATH or ~/.agent-tavern/bridge-state.json)",
    )
    args = parser.parse_args()

    try:
      invite_token, base_url = parse_invite(args.invite, args.base_url)
    except ValueError as exc:
      print(json.dumps({"ok": False, "error": str(exc)}))
      return 1

    room_status, room_data = get_json(f"{base_url}/api/invites/{invite_token}")
    if not (200 <= room_status < 300):
        print(json.dumps({
            "ok": False,
            "inviteResolved": False,
            "status": room_status,
            "baseUrl": base_url,
            "inviteToken": invite_token,
            "response": room_data,
        }, ensure_ascii=True))
        return 1

    backend_type = str(args.backend_type).strip()
    thread_id, thread_id_source = resolve_thread_id(args.thread_id, backend_type)
    login_key, login_key_source = resolve_login_key(args.login_key, backend_type, thread_id)
    cwd, cwd_source = resolve_cwd(args.cwd)
    display_name, display_name_source = resolve_display_name(args.display_name, cwd, login_key, backend_type)
    try:
        bridge_identity = resolve_bridge_identity(args.bridge_state_path, base_url)
    except BridgeSelectionError as exc:
        error_result = {
            "ok": False,
            "inviteResolved": True,
            "room": room_data,
            "bootstrapped": False,
            "joined": False,
            "status": 412,
            "baseUrl": base_url,
            "inviteToken": invite_token,
            "backendType": backend_type,
            "backendThreadId": thread_id,
            "threadIdSource": thread_id_source,
            "loginKey": login_key,
            "loginKeySource": login_key_source,
            "globalDisplayName": display_name,
            "displayNameSource": display_name_source,
            "cwd": cwd,
            "cwdSource": cwd_source,
            "errorCode": exc.code,
            "bridgeCandidates": exc.candidates,
            "error": str(exc),
        }
        if args.bridge_state_path and args.bridge_state_path.strip():
            error_result["bridgeStatePath"] = get_bridge_state_path(args.bridge_state_path)
        print(json.dumps(error_result, ensure_ascii=True))
        return 1
    except RuntimeError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=True))
        return 1

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
            "inviteResolved": True,
            "room": room_data,
            "bootstrapped": False,
            "status": bootstrap_status,
            "baseUrl": base_url,
            "inviteToken": invite_token,
            "backendType": backend_type,
            "backendThreadId": thread_id,
            "threadIdSource": thread_id_source,
            "loginKey": login_key,
            "loginKeySource": login_key_source,
            "globalDisplayName": display_name,
            "displayNameSource": display_name_source,
            "response": bootstrap_data,
        }, ensure_ascii=True))
        return 1

    join_status, join_data = post_json(
        f"{base_url}/api/invites/{invite_token}/join",
        {
            "citizenId": bootstrap_data.get("citizenId", ""),
            "citizenToken": bootstrap_data.get("citizenToken", ""),
        },
    )
    joined = 200 <= join_status < 300
    result = {
        "ok": joined,
        "inviteResolved": True,
        "room": room_data,
        "bootstrapped": True,
        "joined": joined,
        "status": join_status,
        "baseUrl": base_url,
        "bridgeStatePath": bridge_identity.get("statePath", ""),
        "inviteToken": invite_token,
        "backendType": backend_type,
        "backendThreadId": thread_id,
        "threadIdSource": thread_id_source,
        "loginKey": login_key,
        "loginKeySource": login_key_source,
        "globalDisplayName": display_name,
        "displayNameSource": display_name_source,
        "cwd": cwd,
        "cwdSource": cwd_source,
        "principal": bootstrap_data,
        "join": join_data,
    }

    if not joined:
        print(json.dumps(result, ensure_ascii=True))
        return 1

    attach_status, attach_data = post_json(
        f"{base_url}/api/bridges/{bridge_identity['bridgeId']}/agents/attach",
        {
            "bridgeToken": bridge_identity["bridgeToken"],
            "backendThreadId": thread_id,
            "cwd": cwd,
        },
    )
    if should_recover_stale_bridge(attach_status, attach_data) and bridge_identity.get("source") == "file":
        recover_status, recover_data = register_bridge(base_url, bridge_identity)
        result["bridgeRecovery"] = {
            "status": recover_status,
            "response": recover_data,
        }
        if 200 <= recover_status < 300:
            bridge_identity = {
                "bridgeId": str(recover_data.get("bridgeId", "")).strip(),
                "bridgeToken": str(recover_data.get("bridgeToken", "")).strip(),
                "source": "file",
                "statePath": bridge_identity.get("statePath", get_bridge_state_path(args.bridge_state_path)),
            }
            if bridge_identity["bridgeId"] and bridge_identity["bridgeToken"]:
                persist_bridge_identity(
                    bridge_identity["statePath"],
                    bridge_identity["bridgeId"],
                    bridge_identity["bridgeToken"],
                    server_base_url=base_url,
                    bridge_name=resolve_bridge_name(),
                )
                attach_status, attach_data = post_json(
                    f"{base_url}/api/bridges/{bridge_identity['bridgeId']}/agents/attach",
                    {
                        "bridgeToken": bridge_identity["bridgeToken"],
                        "backendThreadId": thread_id,
                        "cwd": cwd,
                    },
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
    return 0 if joined else 1


if __name__ == "__main__":
    sys.exit(main())
