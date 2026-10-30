"""运行时服务的模型供应商与默认模型管理接口：接入、建密钥（先试连）、试连不保存、自己加模型、设默认模型。"""

from __future__ import annotations

import httpx

from tests.helpers.model_providers import BAD_KEY, GOOD_KEY


async def test_admin_connects_a_provider_with_a_credential_and_a_default_model(
    admin: httpx.AsyncClient,
) -> None:
    declarations = await admin.get("/model-providers/declarations")
    assert declarations.status_code == 200, declarations.text
    assert "bailian" in {one["name"] for one in declarations.json()["declarations"]}

    connected = await admin.post(
        "/model-providers", json={"name": "bailian-main", "provider": "bailian", "label": "百炼"}
    )
    assert connected.status_code == 201, connected.text
    provider = connected.json()
    base = f"/model-providers/{provider['id']}"

    rejected = await admin.post(
        f"{base}/credentials", json={"name": "坏的", "fields": {"api_key": BAD_KEY}}
    )
    assert rejected.status_code == 422
    credential = await admin.post(
        f"{base}/credentials", json={"name": "主账号", "fields": {"api_key": GOOD_KEY}}
    )
    assert credential.status_code == 201, credential.text
    assert GOOD_KEY not in credential.text

    probed = await admin.post(f"{base}/credentials/test", json={"fields": {"api_key": BAD_KEY}})
    assert probed.status_code == 200, probed.text
    assert probed.json()["ok"] is False

    added = await admin.post(
        f"{base}/models", json={"name": "my-model", "type": "llm", "api": "chat"}
    )
    assert added.status_code == 201, added.text

    listed = (await admin.get("/model-providers")).json()["providers"]
    assert [one["name"] for one in listed] == ["bailian-main"]
    assert listed[0]["defaultCredentialId"] == credential.json()["id"]
    assert "my-model" in {one["name"] for one in listed[0]["models"]}

    chosen = await admin.put(
        "/default-models/llm", json={"providerId": provider["id"], "modelName": "my-model"}
    )
    assert chosen.status_code == 200, chosen.text
    defaults = (await admin.get("/default-models")).json()
    assert defaults == {"defaults": [chosen.json()]}

    assert (await admin.delete(f"{base}/credentials/{credential.json()['id']}")).status_code == 409
