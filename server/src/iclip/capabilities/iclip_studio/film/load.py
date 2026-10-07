"""读两份文件并检查，再认文件里写的图片地址、查每个生图节点最近一次生成的图。

AI 导演的工具和制作页都从这里拿到同一个 ``Film``。"""

from __future__ import annotations

from dataclasses import dataclass

from iclip.capabilities.iclip_studio.film.checks import check
from iclip.capabilities.iclip_studio.film.film import Film
from iclip.capabilities.iclip_studio.ports import NodeImages
from iclip.domains.identity.public import Principal
from iclip.platform.material_ledger.store import MaterialLedger


@dataclass(frozen=True, slots=True)
class ConversationImages:
    """一段对话里的图片：素材台账里登记的，加上生成记录里这段对话的。

    ``images`` 为 None 表示没开媒体生成，只认台账，也查不到最近生成的图。"""

    ledger: MaterialLedger
    namespace: str
    images: NodeImages | None
    principal: Principal
    conversation_id: str

    async def known(self, url: str) -> bool:
        """这个地址是不是这段对话里的图片。"""

        recorded = await self.ledger.lookup(self.namespace, url)
        if recorded is not None and recorded.kind == "image":
            return True
        return self.images is not None and await self.images.belongs(
            self.principal, self.conversation_id, url
        )


async def load_film(
    project_source: str,
    run_source: str | None,
    *,
    images: ConversationImages,
) -> Film | list[str]:
    """通过时返回 ``Film``，否则返回全部问题。文件里写的地址要是这段对话的图片。"""

    film = check(project_source, run_source)
    if isinstance(film, list):
        return film
    if film.errors:
        return film.errors
    for document, node in film.given_images():
        if not await images.known(node.attrs["src"]):
            # 不回显地址：没被认可的地址不通过报错进模型上下文。
            document.error(node, "src 不是这段对话里的图片；只能写对话里给出或生成的图片地址")
            if document is not film.project:
                film.errors.append(document.errors[-1])
    if film.errors:
        return film.errors
    if images.images is not None:
        names = [node.attrs["id"] for node in film.image_nodes()]
        film.generated.update(
            await images.images.latest(images.principal, images.conversation_id, names)
        )
    return film


__all__ = ["ConversationImages", "load_film"]
