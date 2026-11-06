from __future__ import annotations

from collections.abc import Callable

import httpx

from iclip.platform.media.fetch import MediaDownloads


def as_is(url: str) -> str:
    return url


def rewriting(public_base: str, fetch_base: str) -> Callable[[str], str]:
    def fetch_url(url: str) -> str:
        if url.startswith(public_base):
            return fetch_base + url[len(public_base) :]
        return url

    return fetch_url


def all_own(client: httpx.AsyncClient, fetch_url: Callable[[str], str] = as_is) -> MediaDownloads:
    return MediaDownloads(internal=client, public=client, fetch_url=fetch_url, owns=_always)


def _always(url: str) -> bool:
    return True
