"""工具收的素材地址：形状检查，以及提交点上「链接能打开、类型对」的检查翻成给模型的话。

探地址见 ``agent_runtime.harness.media_check``；这里只决定怎么跟模型说。
"""

from __future__ import annotations

from collections.abc import Sequence

from pydantic_ai import ModelRetry

from agent_runtime.harness.media_check import MediaKind, bad_urls
from agent_runtime.urls import is_http_url


def require_http(url: str, *, what: str) -> None:
    """要求素材地址使用 HTTP(S)；错误不回显被拒地址。"""

    if not is_http_url(url):
        raise ModelRetry(f"{what}必须是带主机名的 http(s) 地址；换成对话或工具结果里给出的地址。")


async def require_media(
    items: Sequence[tuple[str, str]],
    *,
    kind: MediaKind,
    what: str,
) -> None:
    """``items``（称呼，地址）里的地址都要能打开、类型对，称呼由调用方按位置起，如「第 2 组第 1 张」。

    有不行的抛 ``ModelRetry``，按先后逐条列出称呼与原因（打不开、不是图片或不是视频），不回显地址。"""

    bad = await bad_urls((url for _, url in items), kind=kind)
    listed = [f"{label}：{bad[url]}" for label, url in items if url in bad]
    if listed:
        raise ModelRetry("\n".join([f"以下{what}不能用，换成能打开的地址再调用：", *listed]))


__all__ = ["require_http", "require_media"]
