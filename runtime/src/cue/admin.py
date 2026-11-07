from __future__ import annotations

import argparse
import asyncio
import sys

from pydantic import ValidationError
from sqlalchemy.ext.asyncio import create_async_engine

from cue.config.mcp_servers.public import SqlMcpServerStore, rotate_mcp_server_keys
from cue.config.model_providers.public import (
    SqlModelProviderStore,
    load_declarations,
    rotate_credential_keys,
)
from cue.migrations.runner import BaselineStampRefused, stamp_baseline, upgrade
from cue.secrets import CredentialCipher
from cue.settings import (
    CREDENTIAL_ENCRYPTION_KEYS_ENV,
    DATABASE_URL_ENV,
    CoreEnv,
    CredentialKeysEnv,
)


def _database_url() -> str:
    try:
        return CoreEnv().database_url  # pyright: ignore[reportCallIssue]
    except ValidationError as exc:
        sys.exit(f"{DATABASE_URL_ENV} 不合法：{exc.errors()[0]['msg']}")


async def _rotate_credential_keys() -> None:
    database_url = _database_url()
    try:
        keys = CredentialKeysEnv().key_list  # pyright: ignore[reportCallIssue]
    except ValidationError as exc:
        sys.exit(f"{CREDENTIAL_ENCRYPTION_KEYS_ENV} 不合法：{exc.errors()[0]['msg']}")
    engine = create_async_engine(database_url)
    cipher = CredentialCipher(keys)
    try:
        credentials = await rotate_credential_keys(
            SqlModelProviderStore(engine), declarations=load_declarations(), cipher=cipher
        )
        print(f"已把 {credentials} 把密钥的机密字段改用第一个 key 加密")
        servers = await rotate_mcp_server_keys(SqlMcpServerStore(engine), cipher=cipher)
        print(f"已把 {servers} 个 MCP 服务的地址与请求头改用第一个 key 加密")
    finally:
        await engine.dispose()


def _migrate() -> None:
    upgrade(_database_url())
    print("运行时的表已升到最新")


def _stamp_baseline() -> None:
    try:
        stamp_baseline(_database_url())
    except BaselineStampRefused as exc:
        sys.exit(str(exc))
    print("已打上基线标记，表结构没有改动")


def main() -> None:
    parser = argparse.ArgumentParser(description="cue 管理命令")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("rotate-credential-keys")
    sub.add_parser("migrate")
    sub.add_parser("stamp-baseline")
    command = parser.parse_args().command
    if command == "migrate":
        _migrate()
    elif command == "stamp-baseline":
        _stamp_baseline()
    else:
        asyncio.run(_rotate_credential_keys())


if __name__ == "__main__":
    main()
