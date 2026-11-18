"""核对运行时镜像的锁 deploy/runtime-video/uv.lock 与后端锁 server/uv.lock 共有的包是否同一版本。

不带参数只核对，不一致时退出码 1；带 --fix 时先在 deploy/runtime-video 用 `uv lock -P <包>==<后端的版本>`
把不一致的包对齐到后端的版本，再核对一遍，仍不一致时同样退出码 1。
"""

from __future__ import annotations

import subprocess
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


def mismatched() -> tuple[dict[str, set[str]], dict[str, set[str]], list[str]]:
    server = locked_versions(SERVER_LOCK)
    runtime = locked_versions(RUNTIME_LOCK)
    names = [
        name for name in sorted(server.keys() & runtime.keys()) if server[name] != runtime[name]
    ]
    return server, runtime, names


def align_to_server(server: dict[str, set[str]], names: list[str]) -> None:
    """在 deploy/runtime-video 重锁，把 names 里的包钉到后端锁里的版本；uv 解析失败时抛出 CalledProcessError。"""
    pins: list[str] = []
    for name in names:
        if len(server[name]) != 1:
            # 后端锁里同一个包按平台锁了多个版本时，-P 只能钉一个，交给人决定。
            raise SystemExit(
                f"[locks] {name} 在 {SERVER_LOCK} 里有多个版本 {', '.join(sorted(server[name]))}，"
                "无法自动对齐"
            )
        pins += ["-P", f"{name}=={next(iter(server[name]))}"]
    print(f"[locks] 在 deploy/runtime-video 对齐 {len(names)} 个包到后端的版本", flush=True)
    subprocess.run(["uv", "lock", *pins], cwd=ROOT / "deploy/runtime-video", check=True)


def main() -> int:
    fix = "--fix" in sys.argv[1:]
    server, runtime, names = mismatched()
    if names and fix:
        align_to_server(server, names)
        server, runtime, names = mismatched()
    for name in names:
        print(
            f"{name}：{SERVER_LOCK} {', '.join(sorted(server[name]))}，"
            f"{RUNTIME_LOCK} {', '.join(sorted(runtime[name]))}"
        )
    if names:
        hint = "对齐后仍不一致，需手动处理" if fix else "在仓库根目录执行 `make lock-sync` 对齐"
        print(f"[locks] {len(names)} 个包版本不一致：{hint}")
        return 1
    print(f"[locks] {RUNTIME_LOCK} 与 {SERVER_LOCK} 共有的包版本一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
