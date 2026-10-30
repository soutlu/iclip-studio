"""把后端的 OpenAPI 导出到 ``contract/openapi.json``。

使用占位环境变量与 ``contract/`` 下的占位配置启用全部可选模块，供前端生成完整类型与 zod schema。
占位值仅用于装配，不建立连接或发送请求；新增必需环境变量时须更新 ``PLACEHOLDER_ENV``，
新增影响路由的配置段时须更新占位配置。真实配置不进仓库。

用法：``make contract`` 导出，``make contract-check`` 只校验不写（已进 ``make check``）。
"""

from __future__ import annotations

import base64
import json
import os
import sys
from collections.abc import Sequence
from pathlib import Path

# 占位值须符合 Pydantic 的 URL 格式和密钥长度约束。
PLACEHOLDER_ENV = {
    "AUTH_SECRET": "openapi-dump-placeholder-secret-0123456789",
    # 合法的 Fernet key 形状（32 字节 urlsafe base64），由可读的占位串编码而来。
    "CREDENTIAL_ENCRYPTION_KEYS": base64.urlsafe_b64encode(
        b"openapi-dump-placeholder-key-001"
    ).decode(),
    "DATABASE_URL": "postgresql+asyncpg://placeholder:placeholder@127.0.0.1:5432/placeholder",
    "IMAGE_API_BASE": "https://placeholder.invalid/image",
    "OSS_ACCESS_KEY_ID": "placeholder",
    "OSS_ACCESS_KEY_SECRET": "placeholder",
    "OSS_BUCKET": "placeholder",
    "OSS_ENDPOINT": "https://placeholder.invalid",
    "OSS_PUBLIC_URL_BASE": "https://placeholder.invalid/public",
    "PRODUCT_CATALOG_DATABASE_URL": "postgresql+asyncpg://placeholder:placeholder@127.0.0.1:5432/placeholder",
    "QWEN_API_KEY": "openapi-dump-placeholder",
    # 内部接口挂上也不进合同（include_in_schema=False），导出照样逐字相同。
    "RUNTIME_INTERNAL_TOKEN": "openapi-dump-placeholder-internal-0123456789",
    "SSO_BASE_URL": "https://placeholder.invalid/sso",
    "SSO_REDIRECT_URL": "https://placeholder.invalid/auth/sso/callback",
    "VIDEO_API_KEY": "openapi-dump-placeholder",
    "VIDEO_ENHANCE_SUBMIT_URL": "https://placeholder.invalid/video/enhance",
    "VIDEO_STATUS_BASE_URL": "https://placeholder.invalid/video/status",
    "VIDEO_SUBMIT_URL": "https://placeholder.invalid/video/submit",
    "VIDEO_UNDERSTANDING_API_KEY": "openapi-dump-placeholder",
    "VIDEO_UNDERSTANDING_URL": "https://placeholder.invalid/video/understanding",
}

REPO_ROOT = Path(__file__).resolve().parents[2]
OUTPUT = REPO_ROOT / "contract" / "openapi.json"
PLACEHOLDER_CONFIG_DIR = Path(__file__).resolve().parent / "contract"


def build_document() -> dict[str, object]:
    """使用占位环境装配完整应用，获取 OpenAPI 文档。"""

    for name, value in PLACEHOLDER_ENV.items():
        os.environ.setdefault(name, value)
    os.environ.setdefault("CONFIG_FILE", str(PLACEHOLDER_CONFIG_DIR / "config.yaml"))

    from iclip.asgi import app

    return app.openapi()


def render(document: dict[str, object]) -> str:
    """排序键名，避免字典顺序变化导致合同漂移。"""

    return json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def main(argv: Sequence[str]) -> int:
    rendered = render(build_document())
    relative = OUTPUT.relative_to(REPO_ROOT)

    if "--check" in argv:
        current = OUTPUT.read_text(encoding="utf-8") if OUTPUT.exists() else ""
        if current != rendered:
            print(f"[contract] {relative} 与后端当前路由不一致，跑 make contract 重新导出")
            return 1
        print(f"[contract] {relative} 与后端一致")
        return 0

    OUTPUT.write_text(rendered, encoding="utf-8")
    print(f"[contract] 已写出 {relative}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
