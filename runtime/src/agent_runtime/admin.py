"""运行时服务的管理命令，直连数据库：``python -m agent_runtime.admin rotate-credential-keys``。

``rotate-credential-keys`` 把模型供应商全部密钥的机密字段与全部 MCP 服务的地址、请求头的值改用
``CREDENTIAL_ENCRYPTION_KEYS`` 的第一个 key 加密，打印各改了几个；连接串取 ``DATABASE_URL``。换钥步骤见
docs/deploy.md「换密钥加密钥匙」。
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from pydantic import ValidationError
from sqlalchemy.ext.asyncio import create_async_engine

from agent_runtime.config.mcp_servers.public import SqlMcpServerStore, rotate_mcp_server_keys
from agent_runtime.config.model_providers.public import (
    SqlModelProviderStore,
    load_declarations,
    rotate_credential_keys,
)
from agent_runtime.secrets import CredentialCipher
from agent_runtime.settings import (
    CREDENTIAL_ENCRYPTION_KEYS_ENV,
    DATABASE_URL_ENV,
    CoreEnv,
    CredentialKeysEnv,
)


async def _rotate_credential_keys() -> None:
    try:
        database_url = CoreEnv().database_url  # pyright: ignore[reportCallIssue]
    except ValidationError as exc:
        sys.exit(f"{DATABASE_URL_ENV} 不合法：{exc.errors()[0]['msg']}")
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


def main() -> None:
    parser = argparse.ArgumentParser(description="agent runtime 管理命令")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("rotate-credential-keys")
    parser.parse_args()
    asyncio.run(_rotate_credential_keys())


if __name__ == "__main__":
    main()
