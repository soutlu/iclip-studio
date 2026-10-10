"""读两份文件并检查，再认文件里写的图片地址。

AI 导演的工具和制作页都从这里拿到同一个 ``Film``。"""

from __future__ import annotations

from dataclasses import dataclass

from iclip.capabilities.iclip_studio.film.checks import check
from iclip.capabilities.iclip_studio.film.film import Film
from iclip.platform.material_ledger.store import MaterialLedger


@dataclass(frozen=True, slots=True)
class ConversationImages:
    """一段对话里的图片：素材台账里登记的图片。"""

    ledger: MaterialLedger
    namespace: str

    async def known(self, url: str) -> bool:
        """这个地址是不是这段对话素材台账里的图片。"""

        recorded = await self.ledger.lookup(self.namespace, url)
        return recorded is not None and recorded.kind == "image"


async def load_film(
    project_source: str,
    run_source: str | None,
    *,
    images: ConversationImages,
) -> Film | list[str]:
    """通过时返回 ``Film``，否则返回全部问题。文件里写的地址要在这段对话的素材台账里。"""

    film = check(project_source, run_source)
    if isinstance(film, list):
        return film
    if film.errors:
        return film.errors
    for document, node in film.given_images():
        if not await images.known(node.attrs["src"]):
            # 不回显地址：没被认可的地址不通过报错进模型上下文。
            document.error(node, "src 不在这段对话的素材里；只能写对话素材里的图片地址")
            if document is not film.project:
                film.errors.append(document.errors[-1])
    if film.errors:
        return film.errors
    return film


__all__ = ["ConversationImages", "load_film"]
