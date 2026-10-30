"""把运行时服务的 OpenAPI 导出到 ``contract/runtime-openapi.json``。

用占位设置建 app 取文档，不连库、不读环境变量与配置文件；插件登记表给空的，路由不随登记表变。

用法：``make contract`` 导出，``make contract-check`` 只校验不写。
"""

from __future__ import annotations

import base64
import json
import sys
from collections.abc import Sequence
from pathlib import Path

from agent_runtime.http import create_app
from agent_runtime.settings import (
    AgentRunsSection,
    CompactionSection,
    ResolvedApp,
    RuntimeSettings,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
OUTPUT = REPO_ROOT / "contract" / "runtime-openapi.json"

PLACEHOLDER_SETTINGS = RuntimeSettings(
    database_url="postgresql+asyncpg://placeholder:placeholder@127.0.0.1:5432/placeholder",
    # 合法的 Fernet key 形状（32 字节 urlsafe base64），由可读的占位串编码而来。
    credential_encryption_keys=(
        base64.urlsafe_b64encode(b"openapi-dump-placeholder-key-001").decode(),
    ),
    apps=(ResolvedApp(id="placeholder", key="openapi-dump-placeholder-app-key-0123", admin=True),),
    agent_runs=AgentRunsSection(),
    compaction=CompactionSection(),
    log_level="WARNING",
    log_format="console",
)


def build_document() -> dict[str, object]:
    return create_app(PLACEHOLDER_SETTINGS, plugins={}).openapi()


def render(document: dict[str, object]) -> str:
    """排序键名，避免字典顺序变化导致合同漂移。"""

    return json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def main(argv: Sequence[str]) -> int:
    rendered = render(build_document())
    relative = OUTPUT.relative_to(REPO_ROOT)

    if "--check" in argv:
        current = OUTPUT.read_text(encoding="utf-8") if OUTPUT.exists() else ""
        if current != rendered:
            print(f"[contract] {relative} 与运行时当前路由不一致，跑 make contract 重新导出")
            return 1
        print(f"[contract] {relative} 与运行时一致")
        return 0

    OUTPUT.write_text(rendered, encoding="utf-8")
    print(f"[contract] 已写出 {relative}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
