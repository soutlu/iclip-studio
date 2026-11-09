from __future__ import annotations

from collections.abc import Mapping

from iclip_video.iclip_studio.film.checks import check
from iclip_video.iclip_studio.film.film import Film


def load_film(project_source: str, run_source: str | None) -> Film | list[str]:
    film = check(project_source, run_source)
    if isinstance(film, list):
        return film
    if film.errors:
        return film.errors
    return film


def image_problems(film: Film, reasons: Mapping[str, str]) -> list[str]:
    for document, node in film.given_images():
        reason = reasons.get(node.attrs["src"])
        if reason is None:
            continue
        document.error(node, f"src {reason}，换成能打开的图片地址")
        if document is not film.project:
            film.errors.append(document.errors[-1])
    return film.errors


__all__ = ["image_problems", "load_film"]
