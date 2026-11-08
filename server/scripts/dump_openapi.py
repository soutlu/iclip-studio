from __future__ import annotations

import json
import os
import sys
from collections.abc import Sequence
from pathlib import Path

PLACEHOLDER_ENV = {
    "AUTH_SECRET": "openapi-dump-placeholder-secret-0123456789",
    "DATABASE_URL": "postgresql+asyncpg://placeholder:placeholder@127.0.0.1:5432/placeholder",
    "IMAGE_API_BASE": "https://placeholder.invalid/image",
    "OSS_ACCESS_KEY_ID": "placeholder",
    "OSS_ACCESS_KEY_SECRET": "placeholder",
    "OSS_BUCKET": "placeholder",
    "OSS_ENDPOINT": "https://placeholder.invalid",
    "OSS_PUBLIC_URL_BASE": "https://placeholder.invalid/public",
    "PRODUCT_CATALOG_DATABASE_URL": "postgresql+asyncpg://placeholder:placeholder@127.0.0.1:5432/placeholder",
    "QWEN_API_KEY": "openapi-dump-placeholder",
    "RUNTIME_APP_KEY": "openapi-dump-placeholder-runtime-key-0123456789",
    "RUNTIME_INTERNAL_TOKEN": "openapi-dump-placeholder-internal-0123456789",
    "RUNTIME_URL": "https://placeholder.invalid/runtime",
    "SSO_BASE_URL": "https://placeholder.invalid/sso",
    "SSO_REDIRECT_URL": "https://placeholder.invalid/auth/sso/callback",
    "VIDEO_API_KEY": "openapi-dump-placeholder",
    "VIDEO_ENHANCE_SUBMIT_URL": "https://placeholder.invalid/video/enhance",
    "VIDEO_STATUS_BASE_URL": "https://placeholder.invalid/video/status",
    "VIDEO_SUBMIT_URL": "https://placeholder.invalid/video/submit",
}

REPO_ROOT = Path(__file__).resolve().parents[2]
OUTPUT = REPO_ROOT / "contract" / "openapi.json"
PLACEHOLDER_CONFIG_DIR = Path(__file__).resolve().parent / "contract"


def build_document() -> dict[str, object]:
    for name, value in PLACEHOLDER_ENV.items():
        os.environ.setdefault(name, value)
    os.environ.setdefault("CONFIG_FILE", str(PLACEHOLDER_CONFIG_DIR / "config.yaml"))

    from iclip.asgi import app

    return app.openapi()


def render(document: dict[str, object]) -> str:
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
