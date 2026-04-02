#!/usr/bin/env python3
import argparse
import os
from pathlib import Path
import shutil
import sys
import tempfile


def resolve_codex_home() -> Path:
    codex_home = os.environ.get("CODEX_HOME", "").strip()
    if codex_home:
        return Path(codex_home).expanduser().resolve()
    return (Path.home() / ".codex").resolve()


def resolve_claude_home() -> Path:
    claude_home = os.environ.get("CLAUDE_HOME", "").strip()
    if claude_home:
        return Path(claude_home).expanduser().resolve()
    return (Path.home() / ".claude").resolve()


def resolve_opencode_home() -> Path:
    opencode_home = os.environ.get("OPENCODE_HOME", "").strip()
    if opencode_home:
        return Path(opencode_home).expanduser().resolve()
    return (Path.home() / ".config" / "opencode").resolve()


def resolve_skill_name(value: str) -> str:
    skill_name = value.strip()
    if not skill_name or skill_name in {".", ".."} or "/" in skill_name or "\\" in skill_name:
        raise ValueError("skill_name must be a single directory name")
    return skill_name


def install_skill(source_dir: Path, target_dir: Path, skill_name: str) -> None:
    target_dir.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix=f"{skill_name}-", dir=target_dir.parent) as temp_dir:
        temp_target = Path(temp_dir) / skill_name
        shutil.copytree(source_dir, temp_target)

        backup_dir = None
        if target_dir.exists():
            backup_dir = Path(temp_dir) / f"{skill_name}.backup"
            target_dir.replace(backup_dir)

        temp_target.replace(target_dir)
        if backup_dir and backup_dir.exists():
            shutil.rmtree(backup_dir)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Install a versioned AgentTavern skill into the local agent skills directory."
    )
    parser.add_argument("skill_name", help="Skill folder name under tools/skills")
    parser.add_argument(
        "--target",
        choices=["codex", "claude", "opencode", "all"],
        default="all",
        help="Which agent runtime to install into (default: all)",
    )
    args = parser.parse_args()

    try:
        skill_name = resolve_skill_name(args.skill_name)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    repo_root = Path(__file__).resolve().parent.parent
    source_dir = (repo_root / "tools" / "skills" / skill_name).resolve()
    skills_root = (repo_root / "tools" / "skills").resolve()
    if skills_root not in source_dir.parents:
        print(f"skill not found: {source_dir}", file=sys.stderr)
        return 1
    if not source_dir.exists():
        print(f"skill not found: {source_dir}", file=sys.stderr)
        return 1

    targets: list[tuple[str, Path]] = []
    if args.target in ("codex", "all"):
        targets.append(("codex", resolve_codex_home() / "skills" / skill_name))
    if args.target in ("claude", "all"):
        targets.append(("claude", resolve_claude_home() / "skills" / skill_name))
    if args.target in ("opencode", "all"):
        targets.append(("opencode", resolve_opencode_home() / "skills" / skill_name))

    installed: list[str] = []
    errors: list[str] = []
    for runtime, target_dir in targets:
        target_dir = target_dir.resolve()
        try:
            install_skill(source_dir, target_dir, skill_name)
            installed.append(str(target_dir))
        except Exception as exc:
            errors.append(f"{runtime}: {exc}")

    for path in installed:
        print(path)

    if errors:
        for err in errors:
            print(f"error: {err}", file=sys.stderr)
        # Only fail if nothing was installed at all
        if not installed:
            return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
