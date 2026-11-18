"""final-cut 工程：对话工作区里的 ``final-cut/`` 目录，在预览域名上按令牌给出，属主可以新建文件、
翻译工程里的字。"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import unicodedata
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Final
from urllib.parse import quote

from iclip.common.errors import Conflict, NotFound, PermissionDenied, ValidationFailed
from iclip.common.final_cut import PROJECT_DIR, TargetLocale
from iclip.common.urls import is_http_origin
from iclip.domains.conversations.final_cut_translation import FinalCutText, FinalCutTranslator
from iclip.domains.conversations.service import (
    ConversationService,
    DerivedFileContent,
    ReadDerivedFile,
    WriteDerivedFile,
)
from iclip.domains.identity.public import ModelGroupOf, Principal

FINAL_CUT_PREVIEW_PREFIX: Final = "/final-cut/preview"

PREVIEW_TOKEN_LIFETIME: Final = timedelta(hours=1)

VENDOR_DIR: Final = "vendor/"

VENDOR_ROUTE: Final = "/hyperframes/vendor/"

# 这些字符在 URL 路径里本来合法，转码后按字面找文件的静态服务器就找不到（如版本号前的 @）。
_PATH_SAFE_CHARS: Final = "/:@!$&'()*+,;="

_TOKEN_KEY_PURPOSE: Final = b"iclip/final-cut-preview-token/v1"


@dataclass(frozen=True, slots=True)
class PreviewGrant:
    """令牌里签进去的内容：取哪段对话的工程、发令牌的应用来源、什么时候失效。"""

    owner_user_id: uuid.UUID
    conversation_id: uuid.UUID
    app_origin: str
    expires_at: datetime


class PreviewTokens:
    """无状态的预览令牌：``<载荷>.<签名>``，两段都是不带填充的 base64url。

    载荷是 JSON（``o`` 属主、``c`` 对话、``a`` 应用来源、``e`` 失效时刻的 Unix 秒）；签名是
    HMAC-SHA256，密钥由 ``AUTH_SECRET`` 对固定用途串做 HMAC 派生，不与登录态共用。
    """

    def __init__(self, auth_secret: str) -> None:
        self._key = hmac.new(auth_secret.encode(), _TOKEN_KEY_PURPOSE, hashlib.sha256).digest()

    def issue(self, grant: PreviewGrant) -> str:
        payload = json.dumps(
            {
                "o": str(grant.owner_user_id),
                "c": str(grant.conversation_id),
                "a": grant.app_origin,
                "e": int(grant.expires_at.timestamp()),
            },
            separators=(",", ":"),
        )
        body = _b64encode(payload.encode())
        return f"{body}.{_b64encode(self._sign(body))}"

    def verify(self, token: str, *, now: datetime) -> PreviewGrant | None:
        """验签并解析；签名不对、格式不对或已过期都答 None。"""

        body, dot, signature = token.partition(".")
        if not dot:
            return None
        try:
            given = _b64decode(signature)
        except ValueError:
            return None
        if not hmac.compare_digest(given, self._sign(body)):
            return None
        try:
            fields = json.loads(_b64decode(body))
            grant = PreviewGrant(
                owner_user_id=uuid.UUID(fields["o"]),
                conversation_id=uuid.UUID(fields["c"]),
                app_origin=str(fields["a"]),
                expires_at=datetime.fromtimestamp(int(fields["e"]), UTC),
            )
        except (ValueError, KeyError, TypeError):
            return None
        return grant if now < grant.expires_at else None

    def _sign(self, body: str) -> bytes:
        return hmac.new(self._key, body.encode(), hashlib.sha256).digest()


def _b64encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _b64decode(text: str) -> bytes:
    try:
        return base64.b64decode(text + "=" * (-len(text) % 4), altchars=b"-_", validate=True)
    except binascii.Error as exc:
        raise ValueError(str(exc)) from exc


def project_path(raw: str) -> str | None:
    """工程里的相对路径，合规就原样答回，不合规答 None。

    不许空段、``.`` 与 ``..``、以 ``/`` 开头或结尾、反斜杠、控制字符和非 NFC 形式：工作区存储会把
    ``a//b``、``/a`` 这类写法折成另一条路径，所以这里只认已经是规范形式的写法。
    """

    if not raw or "\\" in raw or unicodedata.normalize("NFC", raw) != raw:
        return None
    if any(unicodedata.category(ch) == "Cc" for ch in raw):
        return None
    if any(segment in ("", ".", "..") for segment in raw.split("/")):
        return None
    return raw


@dataclass(frozen=True, slots=True)
class PreviewTicket:
    origin: str
    token: str
    expires_at: datetime


@dataclass(frozen=True, slots=True)
class PreviewRedirect:
    """公共库的文件：转到同主机上前端静态文件的这个地址。"""

    location: str


_NO_PREVIEW_ORIGIN = "尚未配置 final-cut 预览域名"
_NO_APP_ORIGIN = "请求没有带有效的 Origin 请求头，无法签发预览令牌"
_BAD_TOKEN = "预览令牌无效或已过期"
_NO_FILE = "final-cut 工程里没有这个文件"


class FinalCutProject:
    """final-cut 工程的四件事：给能读对话的人发预览令牌、按令牌给工程文件、属主新建工程文件、
    属主翻译工程里的字。"""

    def __init__(
        self,
        conversations: ConversationService,
        *,
        read_file: ReadDerivedFile,
        write_file: WriteDerivedFile,
        preview_origin: str | None,
        tokens: PreviewTokens,
        translator: FinalCutTranslator,
        model_group_of: ModelGroupOf,
    ) -> None:
        self._conversations = conversations
        self._read_file = read_file
        self._write_file = write_file
        self._preview_origin = preview_origin
        self._tokens = tokens
        self._translator = translator
        self._model_group_of = model_group_of

    async def open_preview(
        self, principal: Principal, conversation_id: uuid.UUID, *, app_origin: str | None
    ) -> PreviewTicket:
        """给能读这段对话的人发一张 1 小时的预览令牌，签进对话的属主与发令牌那次请求的来源。

        看不见这段对话 404；没配置预览域名、请求没带合规的 ``Origin`` 都是 422。
        """

        conversation = await self._conversations.get(principal, conversation_id)
        if self._preview_origin is None:
            raise ValidationFailed(_NO_PREVIEW_ORIGIN)
        if app_origin is None or not is_http_origin(app_origin):
            raise ValidationFailed(_NO_APP_ORIGIN)
        expires_at = datetime.now(UTC).replace(microsecond=0) + PREVIEW_TOKEN_LIFETIME
        token = self._tokens.issue(
            PreviewGrant(
                owner_user_id=conversation.owner_user_id,
                conversation_id=conversation.id,
                app_origin=app_origin,
                expires_at=expires_at,
            )
        )
        return PreviewTicket(origin=self._preview_origin, token=token, expires_at=expires_at)

    def app_origin(self, token: str) -> str:
        """令牌里签进去的应用来源；令牌不对或过期抛 ``PermissionDenied``。"""

        return self._grant(token).app_origin

    async def preview_file(self, token: str, path: str) -> DerivedFileContent | PreviewRedirect:
        """按令牌取工程里的一个文件：``vendor/`` 开头的转到公共库，其余读工作区的
        ``final-cut/<path>``。

        令牌不对或过期抛 ``PermissionDenied``；路径不合规或文件不存在抛 ``NotFound``。
        """

        grant = self._grant(token)
        checked = project_path(path)
        if checked is None:
            raise NotFound(_NO_FILE)
        if checked.startswith(VENDOR_DIR):
            return PreviewRedirect(
                location=VENDOR_ROUTE
                + quote(checked.removeprefix(VENDOR_DIR), safe=_PATH_SAFE_CHARS)
            )
        found = await self._read_file(
            grant.owner_user_id, grant.conversation_id, f"{PROJECT_DIR}/{checked}"
        )
        if found is None:
            raise NotFound(_NO_FILE)
        return found

    async def create_file(
        self, principal: Principal, conversation_id: uuid.UUID, *, path: str, content: str
    ) -> DerivedFileContent:
        """属主在工程里新建一个文件，答复写进工作区的那一份（路径带 ``final-cut/``）。

        路径不合规 422；文件已存在 409，不覆盖。先读后写，两步之间别人写进同名文件时以后写的为准。
        """

        conversation = await self._conversations.workspace_writable(principal, conversation_id)
        checked = project_path(path)
        if checked is None:
            raise ValidationFailed(f"路径 {path!r} 不合规：用 / 分隔的相对路径，不带 . 或 .. 段")
        full = f"{PROJECT_DIR}/{checked}"
        owner = conversation.owner_user_id
        if await self._read_file(owner, conversation.id, full) is not None:
            raise Conflict("final-cut 工程里已经有这个文件")
        return await self._write_file(owner, conversation.id, full, content, None)

    async def translate(
        self,
        principal: Principal,
        conversation_id: uuid.UUID,
        *,
        locale: TargetLocale,
        entries: Sequence[FinalCutText],
    ) -> tuple[FinalCutText, ...]:
        """属主把一批原文短句翻成 ``locale``，答复按请求的顺序每个 id 恰好一条。不落库、不写工作区。
        调模型用属主所在配置组的密钥。

        看不见这段对话 404，看得见但不是属主或对话已删除 403，这两种都不调模型。模型没启用抛
        ``ModelUnavailable``，调用失败或回答不对抛 ``FinalCutTranslationFailed``。
        """

        conversation = await self._conversations.workspace_writable(principal, conversation_id)
        return await self._translator.translate(
            entries,
            locale=locale,
            model_group=await self._model_group_of(conversation.owner_user_id),
        )

    def _grant(self, token: str) -> PreviewGrant:
        grant = self._tokens.verify(token, now=datetime.now(UTC))
        if grant is None:
            raise PermissionDenied(_BAD_TOKEN)
        return grant


__all__ = [
    "FINAL_CUT_PREVIEW_PREFIX",
    "PREVIEW_TOKEN_LIFETIME",
    "FinalCutProject",
    "PreviewGrant",
    "PreviewRedirect",
    "PreviewTicket",
    "PreviewTokens",
    "project_path",
]
