from __future__ import annotations

from collections.abc import Sequence

from pydantic_ai import ModelRetry

from agent_runtime.harness.media_check import MediaKind, bad_urls
from agent_runtime.urls import is_http_url


def require_http(url: str, *, what: str) -> None:
    if not is_http_url(url):
        raise ModelRetry(f"{what}必须是带主机名的 http(s) 地址；换成对话或工具结果里给出的地址。")


async def require_media(
    items: Sequence[tuple[str, str]],
    *,
    kind: MediaKind,
    what: str,
) -> None:
    bad = await bad_urls((url for _, url in items), kind=kind)
    listed = [f"{label}：{bad[url]}" for label, url in items if url in bad]
    if listed:
        raise ModelRetry("\n".join([f"以下{what}不能用，换成能打开的地址再调用：", *listed]))


__all__ = ["require_http", "require_media"]
