"""用真实的百炼密钥试连一次：通过 make test-external 运行。

需要 ``MODEL_API_KEY``（百炼的 API Key）与 ``MODEL_BASE_URL``（百炼的 OpenAI 兼容接口地址），缺一个就跳过。
声明里每个模型都试一次，各是一次最小的付费请求。"""

from __future__ import annotations

import os

import pytest

from iclip.app.model_providers import PydanticAiCredentialProbe
from iclip.domains.model_providers.catalog import load_declarations
from iclip.domains.model_providers.models import ProviderModel

REQUIRED_ENV = ("MODEL_API_KEY", "MODEL_BASE_URL")


@pytest.fixture
def fields() -> dict[str, str]:
    missing = [name for name in REQUIRED_ENV if not os.environ.get(name, "").strip()]
    if missing:
        pytest.skip(f"缺少环境变量 {', '.join(missing)}，跳过百炼真实试连")
    return {
        "api_key": os.environ["MODEL_API_KEY"].strip(),
        "base_url": os.environ["MODEL_BASE_URL"].strip(),
    }


@pytest.mark.parametrize(
    "model_name", [model.name for model in load_declarations()["bailian"].models]
)
async def test_bailian_declared_models_answer_the_probe(
    fields: dict[str, str], model_name: str
) -> None:
    bailian = load_declarations()["bailian"]
    (declared,) = [one for one in bailian.models if one.name == model_name]
    model = ProviderModel(
        name=declared.name,
        type=declared.type,
        source="declared",
        properties=declared.properties(),
        enabled=True,
    )

    good = await PydanticAiCredentialProbe().probe(bailian, model, fields)
    bad = await PydanticAiCredentialProbe().probe(
        bailian, model, {**fields, "api_key": "sk-invalid-0000000000000000"}
    )

    assert good.ok, good.reason
    assert not bad.ok
    assert bad.reason is not None
    assert "sk-invalid-0000000000000000" not in bad.reason
