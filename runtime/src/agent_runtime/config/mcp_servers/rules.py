"""MCP 服务的纯规则：标识、名称、描述、地址、时限与请求头的整理，请求头的加解密与打码。不合格是
``ValidationFailed``，消息直接给人看，从不带请求头的值。"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from urllib.parse import urlsplit

from agent_runtime.config.mcp_servers.models import (
    HEADER_NAME_PATTERN,
    MAX_DESCRIPTION_CHARS,
    MAX_HEADER_VALUE_CHARS,
    MAX_HEADERS,
    MAX_NAME_CHARS,
    MAX_TIMEOUT_SECONDS,
    MAX_URL_CHARS,
    MCP_SERVER_ID_PATTERN,
    MIN_TIMEOUT_SECONDS,
    McpHeader,
)
from agent_runtime.config.mcp_servers.schemas import McpHeaderIn
from agent_runtime.errors import ValidationFailed
from agent_runtime.secrets import CredentialCipher, mask_secret


def check_server_id(server_id: str) -> str:
    if MCP_SERVER_ID_PATTERN.fullmatch(server_id) is None:
        raise ValidationFailed("标识只能用小写字母、数字和连字符，以小写字母开头，最多 40 个字符")
    return server_id


def clean_name(name: str) -> str:
    """连续的空白并成一个空格、去掉首尾；空的、超长的不收。"""

    cleaned = " ".join(name.split())
    if not cleaned:
        raise ValidationFailed("请填写名称")
    if len(cleaned) > MAX_NAME_CHARS:
        raise ValidationFailed(f"名称最多 {MAX_NAME_CHARS} 个字")
    return cleaned


def clean_description(description: str) -> str:
    cleaned = description.strip()
    if len(cleaned) > MAX_DESCRIPTION_CHARS:
        raise ValidationFailed(f"描述最多 {MAX_DESCRIPTION_CHARS} 个字")
    return cleaned


def check_url(url: str) -> str:
    """只收 ``http`` 与 ``https`` 的完整地址，去掉首尾空白。"""

    cleaned = url.strip()
    if len(cleaned) > MAX_URL_CHARS:
        raise ValidationFailed(f"地址最多 {MAX_URL_CHARS} 个字符")
    try:
        parts = urlsplit(cleaned)
        host = parts.hostname
    except ValueError:
        raise ValidationFailed("地址不是合法的 URL") from None
    if parts.scheme not in {"http", "https"} or not host:
        raise ValidationFailed("地址要以 http:// 或 https:// 开头，并写明主机")
    return cleaned


def check_timeout(seconds: int) -> int:
    if not MIN_TIMEOUT_SECONDS <= seconds <= MAX_TIMEOUT_SECONDS:
        raise ValidationFailed(f"超时要在 {MIN_TIMEOUT_SECONDS} 到 {MAX_TIMEOUT_SECONDS} 秒之间")
    return seconds


def plain_headers(
    given: Sequence[McpHeaderIn], current: Mapping[str, str] | None = None
) -> tuple[McpHeader, ...]:
    """请求头的明文：名字按 HTTP 规矩、不分大小写不能重复，值去掉首尾空白、不能为空、不能换行。

    ``current`` 是已保存的明文请求头（按名字，不分大小写）：没给 ``value`` 的取同名的原值；没有 ``current``
    或里面没有这个名字时，没给 ``value`` 就是不合格。"""

    if len(given) > MAX_HEADERS:
        raise ValidationFailed(f"请求头最多 {MAX_HEADERS} 个")
    known = {name.lower(): value for name, value in (current or {}).items()}
    seen: set[str] = set()
    headers: list[McpHeader] = []
    for one in given:
        name = one.name.strip()
        if HEADER_NAME_PATTERN.fullmatch(name) is None:
            raise ValidationFailed("请求头名只能用字母、数字与 - _ . 等 HTTP 允许的符号")
        key = name.lower()
        if key in seen:
            raise ValidationFailed(f"请求头 {name} 写了两遍")
        seen.add(key)
        if one.value is None:
            if key not in known:
                raise ValidationFailed(f"请填写请求头 {name} 的值")
            value = known[key]
        else:
            value = one.value.strip()
        if not value:
            raise ValidationFailed(f"请填写请求头 {name} 的值")
        if "\r" in value or "\n" in value:
            raise ValidationFailed(f"请求头 {name} 的值不能换行")
        if len(value) > MAX_HEADER_VALUE_CHARS:
            raise ValidationFailed(f"请求头 {name} 的值最多 {MAX_HEADER_VALUE_CHARS} 个字符")
        headers.append(McpHeader(name=name, value=value))
    return tuple(headers)


def encrypt_headers(plain: Sequence[McpHeader], cipher: CredentialCipher) -> tuple[McpHeader, ...]:
    """明文换成存储形态：每个请求头的值都加密。"""

    return tuple(McpHeader(name=one.name, value=cipher.encrypt(one.value)) for one in plain)


def decrypt_headers(stored: Sequence[McpHeader], cipher: CredentialCipher) -> tuple[McpHeader, ...]:
    return tuple(McpHeader(name=one.name, value=cipher.decrypt(one.value)) for one in stored)


def masked_headers(plain: Sequence[McpHeader]) -> tuple[McpHeader, ...]:
    """返回给人看的请求头：每个值都打码。"""

    return tuple(McpHeader(name=one.name, value=mask_secret(one.value)) for one in plain)


__all__ = [
    "check_server_id",
    "check_timeout",
    "check_url",
    "clean_description",
    "clean_name",
    "decrypt_headers",
    "encrypt_headers",
    "masked_headers",
    "plain_headers",
]
