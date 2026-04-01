#!/usr/bin/env python3
import argparse
import json
import os
import sys
from typing import Iterable, List, Tuple
import urllib.error
import urllib.request


DEFAULT_BASE_URL = os.environ.get("AGENT_TAVERN_BASE_URL", "http://127.0.0.1:8787").rstrip("/")
DEFAULT_PREFIXES = [
    "agent:test-",
    "agent:exit-",
]


def decode_json_body(body: str) -> dict:
    if not body:
        return {}
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return {"error": "non-json response", "rawBody": body[:500]}


def request_json(url: str, method: str = "GET", payload: dict | None = None) -> Tuple[int, dict]:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method=method,
    )

    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, decode_json_body(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return exc.code, decode_json_body(exc.read().decode("utf-8"))
    except urllib.error.URLError as exc:
        return 599, {"error": "network error", "reason": str(exc.reason)}
    except TimeoutError:
        return 598, {"error": "request timeout"}
    except Exception as exc:
        return 597, {"error": "unexpected request error", "reason": str(exc)}


def should_cleanup(login_key: str, explicit_login_keys: set[str], prefixes: Iterable[str]) -> bool:
    if login_key in explicit_login_keys:
        return True
    return any(login_key.startswith(prefix) for prefix in prefixes)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Cleanup test agent principals that were created during local smoke tests."
    )
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="AgentTavern server base URL")
    parser.add_argument(
        "--prefix",
        action="append",
        default=[],
        help="Login-key prefix to match. Can be passed multiple times.",
    )
    parser.add_argument(
        "--login-key",
        action="append",
        default=[],
        help="Explicit loginKey to remove. Can be passed multiple times.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Only print matched principals without removing them.",
    )
    args = parser.parse_args()

    base_url = str(args.base_url).rstrip("/")
    prefixes: List[str] = args.prefix or DEFAULT_PREFIXES
    explicit_login_keys = {value.strip() for value in args.login_key if value.strip()}

    status, payload = request_json(f"{base_url}/api/presence/lobby")
    if not (200 <= status < 300):
      print(json.dumps({"ok": False, "status": status, "response": payload}, ensure_ascii=True))
      return 1

    principals = payload.get("principals", [])
    targets = [
        item for item in principals
        if item.get("kind") == "agent"
        and should_cleanup(str(item.get("loginKey", "")).strip(), explicit_login_keys, prefixes)
    ]

    if args.dry_run:
        print(json.dumps({
            "ok": True,
            "dryRun": True,
            "matched": len(targets),
            "targets": targets,
        }, ensure_ascii=True))
        return 0

    results = []
    for item in targets:
        bootstrap_status, bootstrap_data = request_json(
            f"{base_url}/api/citizens/bootstrap",
            method="POST",
            payload={
                "kind": "agent",
                "loginKey": item["loginKey"],
                "globalDisplayName": item["globalDisplayName"],
                "backendType": item["backendType"],
                "backendThreadId": item["backendThreadId"],
            },
        )

        if not (200 <= bootstrap_status < 300):
            results.append({
                "loginKey": item["loginKey"],
                "citizenId": item.get("citizenId", ""),
                "removed": False,
                "bootstrapStatus": bootstrap_status,
                "bootstrapResponse": bootstrap_data,
            })
            continue

        leave_status, leave_data = request_json(
            f"{base_url}/api/citizens/{bootstrap_data['citizenId']}/leave-system",
            method="POST",
            payload={"citizenToken": bootstrap_data["citizenToken"]},
        )
        results.append({
            "loginKey": item["loginKey"],
            "citizenId": bootstrap_data["citizenId"],
            "removed": 200 <= leave_status < 300 and bool(leave_data.get("leftSystem")),
            "leaveStatus": leave_status,
            "leaveResponse": leave_data,
        })

    print(json.dumps({
        "ok": True,
        "matched": len(targets),
        "removed": sum(1 for item in results if item.get("removed")),
        "results": results,
    }, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
