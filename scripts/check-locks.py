from __future__ import annotations

import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER_LOCK = Path("server/uv.lock")
RUNTIME_LOCK = Path("deploy/runtime-video/uv.lock")


def locked_versions(lock: Path) -> dict[str, set[str]]:
    packages = tomllib.loads((ROOT / lock).read_text(encoding="utf-8"))["package"]
    versions: dict[str, set[str]] = {}
    for package in packages:
        if {"editable", "virtual"} & package["source"].keys():
            continue
        versions.setdefault(package["name"], set()).add(package["version"])
    return versions


def main() -> int:
    server = locked_versions(SERVER_LOCK)
    runtime = locked_versions(RUNTIME_LOCK)
    problems = [
        f"{name}：{SERVER_LOCK} {', '.join(sorted(server[name]))}，"
        f"{RUNTIME_LOCK} {', '.join(sorted(runtime[name]))}"
        for name in sorted(server.keys() & runtime.keys())
        if server[name] != runtime[name]
    ]
    for line in problems:
        print(line)
    if problems:
        print(
            f"[locks] {len(problems)} 个包版本不一致：在 deploy/runtime-video 用 "
            "`uv lock -P <包>==<后端的版本>` 对齐"
        )
        return 1
    print(f"[locks] {RUNTIME_LOCK} 与 {SERVER_LOCK} 共有的包版本一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
