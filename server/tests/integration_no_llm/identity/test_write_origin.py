from __future__ import annotations

import httpx
import pytest

from tests.helpers.auth import login_as_editor, register_and_login

ALLOWED_ORIGIN = "https://allowed.example"
# make_client 的 Host 是 test；同站的另一个子域名。
SIBLING_ORIGIN = "http://sibling.test"


@pytest.fixture
def cors_allow_origins() -> tuple[str, ...]:
    return (ALLOWED_ORIGIN,)


@pytest.mark.parametrize(
    ("origin", "status"),
    [
        (SIBLING_ORIGIN, 403),
        ("null", 403),
        ("http://test", 204),
        (None, 204),
        (ALLOWED_ORIGIN, 204),
    ],
    ids=["sibling-subdomain", "null", "same-origin", "no-origin", "allowlisted"],
)
async def test_a_write_passes_only_from_the_app_itself_an_allowlisted_origin_or_no_origin(
    client: httpx.AsyncClient, origin: str | None, status: int
) -> None:
    await register_and_login(client)

    logout = await client.post("/auth/logout", headers={} if origin is None else {"origin": origin})

    assert logout.status_code == status, logout.text
    signed_in = (await client.get("/users/me")).status_code == 200
    assert signed_in is (status == 403), "被拒的写请求没有生效，放行的照常生效"


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
async def test_every_state_changing_method_from_a_sibling_subdomain_is_refused(
    client: httpx.AsyncClient, pg_url: str, method: str
) -> None:
    await login_as_editor(client, pg_url)
    path = "/conversations/00000000-0000-0000-0000-000000000000"
    unchecked = await client.request(method, path)
    assert unchecked.status_code != 403, "不带 Origin 时路由自己不答 403，下面的 403 只来自来源检查"

    refused = await client.request(method, path, headers={"origin": SIBLING_ORIGIN})

    assert refused.status_code == 403, refused.text
    assert "detail" in refused.json()


async def test_reads_are_not_checked_for_origin(client: httpx.AsyncClient) -> None:
    await register_and_login(client)

    me = await client.get("/users/me", headers={"origin": SIBLING_ORIGIN})

    assert me.status_code == 200, me.text
