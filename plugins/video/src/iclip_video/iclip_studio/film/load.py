"""读两份文件并检查结构，以及把图片地址检查出的问题挂到写着它的节点上。

AI 导演的工具和制作页都从这里拿到同一个 ``Film``；地址取不取得到只在提交点另查。"""

from __future__ import annotations

from collections.abc import Mapping

from iclip_video.iclip_studio.film.checks import check
from iclip_video.iclip_studio.film.film import Film


def load_film(project_source: str, run_source: str | None) -> Film | list[str]:
    """通过时返回 ``Film``，否则返回全部问题。只查结构，不查文件里写的地址取不取得到。"""

    film = check(project_source, run_source)
    if isinstance(film, list):
        return film
    if film.errors:
        return film.errors
    return film


def image_problems(film: Film, reasons: Mapping[str, str]) -> list[str]:
    """``reasons`` 是（图片地址 → 用不了的原因）：写着这些地址的每个节点挂一条问题，返回全部问题。

    原因不带地址：问题按节点位置说，不把地址回显进模型上下文。"""

    for document, node in film.given_images():
        reason = reasons.get(node.attrs["src"])
        if reason is None:
            continue
        document.error(node, f"src 用不了：{reason}；换成能打开的图片地址")
        if document is not film.project:
            film.errors.append(document.errors[-1])
    return film.errors


__all__ = ["image_problems", "load_film"]
