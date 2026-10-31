"""错误信封：领域错误按分类映射状态码、``{"detail"}`` 加有值时的 ``code``；请求校验失败一律 422、一句话；
OpenAPI 里的 422 也是这个形状。"""

from __future__ import annotations

from collections.abc import AsyncGenerator

import httpx
import pytest
from fastapi import FastAPI
from pydantic import BaseModel

from agent_runtime.errors import (
    AgentUnavailable,
    AuthenticationFailed,
    Conflict,
    DomainError,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)
from agent_runtime.http.errors import (
    install_error_handlers,
    status_code_for,
    validation_error_detail,
)


class Shot(BaseModel):
    seconds: int


class Body(BaseModel):
    shots: list[Shot]


ERRORS: dict[str, DomainError] = {
    "not-found": NotFound("没有这个 agent"),
    "forbidden": PermissionDenied("没有权限"),
    "conflict": Conflict("版本对不上"),
    "invalid": ValidationFailed("名字不合法"),
    "unauthenticated": AuthenticationFailed("缺少应用密钥"),
    "unavailable": AgentUnavailable("模型被停用"),
    "unknown": DomainError("说不清"),
    "blank": NotFound(),
}


@pytest.fixture
def app() -> FastAPI:
    app = FastAPI()
    install_error_handlers(app)

    @app.get("/raise/{name}")
    async def raise_error(name: str) -> None:
        raise ERRORS[name]

    @app.post("/shots")
    async def shots(body: Body) -> int:
        return len(body.shots)

    return app


@pytest.fixture
async def client(app: FastAPI) -> AsyncGenerator[httpx.AsyncClient]:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://runtime.test"
    ) as c:
        yield c


@pytest.mark.parametrize(
    ("name", "status", "body"),
    [
        ("not-found", 404, {"detail": "没有这个 agent"}),
        ("forbidden", 403, {"detail": "没有权限"}),
        ("conflict", 409, {"detail": "版本对不上"}),
        ("invalid", 422, {"detail": "名字不合法"}),
        ("unauthenticated", 401, {"detail": "缺少应用密钥"}),
        ("unavailable", 409, {"detail": "模型被停用", "code": "agent_unavailable"}),
        ("unknown", 500, {"detail": "说不清"}),
        ("blank", 404, {"detail": "NotFound"}),
    ],
)
async def test_domain_errors_map_to_status_and_envelope(
    client: httpx.AsyncClient, name: str, status: int, body: dict[str, str]
) -> None:
    response = await client.get(f"/raise/{name}")

    assert (response.status_code, response.json()) == (status, body)


async def test_request_validation_is_one_sentence_with_the_field_path(
    client: httpx.AsyncClient,
) -> None:
    response = await client.post("/shots", json={"shots": [{"seconds": 3}, {"seconds": "x"}]})

    assert response.status_code == 422
    assert response.json() == {
        "detail": "shots[1].seconds: Input should be a valid integer, unable to parse string as an integer"
    }


async def test_malformed_json_keeps_only_the_reason(client: httpx.AsyncClient) -> None:
    response = await client.post(
        "/shots", content=b"{", headers={"Content-Type": "application/json"}
    )

    assert (response.status_code, response.json()) == (422, {"detail": "JSON decode error"})


def test_openapi_documents_the_same_validation_envelope(app: FastAPI) -> None:
    schemas = app.openapi()["components"]["schemas"]

    assert schemas["HTTPValidationError"]["properties"] == {
        "detail": {"title": "Detail", "type": "string"}
    }
    assert "ValidationError" not in schemas


def test_a_subclass_inherits_its_parent_status() -> None:
    class SelfishAction(ValidationFailed):
        pass

    assert status_code_for(SelfishAction()) == 422


def test_a_model_level_error_keeps_only_the_reason() -> None:
    """模型级校验器报在请求体自身，位置剥掉就空了，只留原因；自定义校验器的前缀去掉。"""

    errors = [
        {"type": "value_error", "loc": ("body",), "msg": "Value error, prompt 与 shot 至少传一个"}
    ]
    assert validation_error_detail(errors) == "prompt 与 shot 至少传一个"


def test_only_the_first_error_is_reported() -> None:
    errors = [
        {"type": "missing", "loc": ("body", "model"), "msg": "Field required"},
        {"type": "missing", "loc": ("body", "prompt"), "msg": "Field required"},
    ]
    assert validation_error_detail(errors) == "model: Field required"


def test_no_errors_still_give_a_non_empty_detail() -> None:
    assert validation_error_detail([]) == "请求格式无效"
