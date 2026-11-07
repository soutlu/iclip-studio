from __future__ import annotations

import httpx
import pytest
from cryptography.fernet import Fernet
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from agent_runtime.config.model_providers.catalog import load_declarations
from agent_runtime.config.model_providers.infra_sql import SqlModelProviderStore
from agent_runtime.config.model_providers.service import rotate_credential_keys
from agent_runtime.secrets import CredentialCipher
from tests.helpers.model_providers import GOOD_KEY, OTHER_KEY, add_credential, connect_bailian
from tests.helpers.runtime_service import TEST_CREDENTIAL_KEY


async def all_fields(engine: AsyncEngine) -> list[dict[str, str]]:
    async with engine.connect() as conn:
        rows = await conn.execute(
            text("SELECT fields FROM agent_runtime.provider_credentials ORDER BY name")
        )
        return [dict(row[0]) for row in rows]


async def test_rotation_moves_every_secret_to_the_first_key(
    admin: httpx.AsyncClient, engine: AsyncEngine
) -> None:
    provider = await connect_bailian(admin)
    await add_credential(admin, provider["id"], name="a")
    await add_credential(admin, provider["id"], name="b", api_key=OTHER_KEY)
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
