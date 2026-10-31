"""应用密钥鉴权与代办用户。

- ``/v1`` 下每个路由都要 ``Authorization: Bearer <应用密钥>``，按配置认出是哪个应用；缺了或不认得是
  401，信封与领域错误相同。两条 WebSocket 带同一个头，认不出在握手前以 1008 关闭。
- ``/v1/admin`` 另要求这个应用有管理权限，没有是 403。
- 代办用户放在 ``X-End-User`` 请求头里，是用户 id（UUID）：管理接口的写操作（POST、PUT、PATCH、DELETE）
  一律必填，缺了或不是 UUID 是 422；读操作不用。
- 会话接口里同一个头是会话的属主（``SessionOwner``），不是看的人：发消息、读写工作区与素材台账要它算
  命名空间，分叉与拷文件时它是目标会话的属主；用得到它的路由必填。
"""

from __future__ import annotations

import hmac
import uuid
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Header
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from agent_runtime.app_wire import END_USER_HEADER
from agent_runtime.errors import AuthenticationFailed, PermissionDenied
from agent_runtime.settings import ResolvedApp

_bearer = HTTPBearer(
    scheme_name="AppKey",
    description="接入应用的密钥，按运行时配置里的 apps 认出是哪个应用。",
    # 自己报 401：FastAPI 自带的报错不是统一信封。
    auto_error=False,
)

EndUser = Annotated[
    uuid.UUID,
    Header(alias=END_USER_HEADER, description="代哪个用户操作：用户 id。管理接口的写操作必填。"),
]
"""写操作的代办用户；交给服务当操作人（``by``）。"""

SessionOwner = Annotated[
    uuid.UUID,
    Header(
        alias=END_USER_HEADER,
        description="会话的属主：用户 id。应用替看的人转发时也给属主，不给看的人。",
    ),
]
"""会话接口的属主：工作区与素材台账的命名空间按它算，新消息记在它名下。"""


@dataclass(frozen=True, slots=True)
class CallingApp:
    """这次请求是哪个应用发的。"""

    id: str
    admin: bool


@dataclass(frozen=True, slots=True)
class AppAuth:
    """两个依赖：``calling_app`` 认应用，``admin_app`` 在它之上再要求管理权限。

    ``identify`` 给 WebSocket 用（HTTP 的 Bearer 依赖不在 WebSocket 上跑）：收 ``Authorization`` 头的原值，
    认不出是 ``None``。"""

    calling_app: Callable[..., Awaitable[CallingApp]]
    admin_app: Callable[..., Awaitable[CallingApp]]
    identify: Callable[[str | None], CallingApp | None]


def build_app_auth(apps: Sequence[ResolvedApp]) -> AppAuth:
    """按配置的应用名单建出鉴权依赖；同一个请求里两个依赖共用一次认证结果。"""

    known = tuple((app.key.encode(), CallingApp(id=app.id, admin=app.admin)) for app in apps)

    def match(presented: str) -> CallingApp | None:
        found: CallingApp | None = None
        # 每把都比一遍、用定长比较：认出与否、认出的是第几个，耗时都一样。
        for key, app in known:
            if hmac.compare_digest(key, presented.encode()):
                found = app
        return found

    async def calling_app(
        credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    ) -> CallingApp:
        if credentials is None:
            raise AuthenticationFailed("缺少应用密钥")
        found = match(credentials.credentials)
        if found is None:
            raise AuthenticationFailed("应用密钥无效")
        return found

    def identify(authorization: str | None) -> CallingApp | None:
        scheme, _, presented = (authorization or "").partition(" ")
        if scheme.lower() != "bearer" or not presented:
            return None
        return match(presented.strip())

    # Depends 写在默认值里：注解是字符串，按模块全局解析，认不出这个闭包里的 calling_app。
    async def admin_app(app: CallingApp = Depends(calling_app)) -> CallingApp:  # noqa: B008
        if not app.admin:
            raise PermissionDenied("这个应用没有管理权限")
        return app

    return AppAuth(calling_app=calling_app, admin_app=admin_app, identify=identify)


__all__ = [
    "AppAuth",
    "CallingApp",
    "EndUser",
    "SessionOwner",
    "build_app_auth",
]
