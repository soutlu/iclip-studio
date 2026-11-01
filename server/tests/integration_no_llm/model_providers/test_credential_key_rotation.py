"""换钥：新 key 加在最前面后旧密文照读；换钥把全部机密字段改用新 key，去掉旧 key 后仍读得出，明文字段不动。"""

from __future__ import annotations

from collections.abc import AsyncGenerator

import httpx
import pytest
from agent_runtime.config.model_providers.catalog import load_declarations
from agent_runtime.config.model_providers.infra_sql import SqlModelProviderStore
from agent_runtime.config.model_providers.service import rotate_credential_keys
from agent_runtime.secrets import CredentialCipher
from cryptography.fernet import Fernet
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from tests.helpers.app import TEST_CREDENTIAL_KEY, make_client
from tests.helpers.auth import register_and_login, set_roles_in_db
from tests.helpers.model_providers import GOOD_KEY, OTHER_KEY, add_credential, connect_bailian


@pytest.fixture
async def root(
    engine: AsyncEngine, app: FastAPI, migrated_pg: str
) -> AsyncGenerator[httpx.AsyncClient]:
    """``engine`` 夹具建起时会清表，先于登录建好，免得把刚注册的 root 清掉。"""

    async with make_client(app) as client:
        await register_and_login(client, username="root", email="root@example.com")
        await set_roles_in_db(migrated_pg, "root@example.com", ["root"])
        yield client


async def all_fields(engine: AsyncEngine) -> list[dict[str, str]]:
    async with engine.connect() as conn:
        rows = await conn.execute(
            text("SELECT fields FROM agent_runtime.provider_credentials ORDER BY name")
        )
        return [dict(row[0]) for row in rows]


async def test_rotation_moves_every_secret_to_the_first_key(
    root: httpx.AsyncClient, engine: AsyncEngine
) -> None:
    provider = await connect_bailian(root)
    await add_credential(root, provider["id"], name="a")
    await add_credential(root, provider["id"], name="b", api_key=OTHER_KEY)
    old = CredentialCipher([TEST_CREDENTIAL_KEY])
    new_key = Fernet.generate_key().decode()
    both = CredentialCipher([new_key, TEST_CREDENTIAL_KEY])
    before = await all_fields(engine)
    assert [both.decrypt(fields["api_key"]) for fields in before] == [GOOD_KEY, OTHER_KEY]

    rotated = await rotate_credential_keys(
        SqlModelProviderStore(engine), declarations=load_declarations(), cipher=both
    )

    assert rotated == 2
    after = await all_fields(engine)
    only_new = CredentialCipher([new_key])
    assert [only_new.decrypt(fields["api_key"]) for fields in after] == [GOOD_KEY, OTHER_KEY]
    assert [fields["base_url"] for fields in after] == [fields["base_url"] for fields in before]
    with pytest.raises(RuntimeError):
        old.decrypt(after[0]["api_key"])
