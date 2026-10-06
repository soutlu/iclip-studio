"""一条新片读进来以后的样子：工程文件、运行文件里登记和选用的图，以及每个图引用现在的地址。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Final

from iclip.capabilities.iclip_studio.film.document import Document
from iclip.capabilities.iclip_studio.film.markup import Node
from iclip.capabilities.iclip_studio.film.packages import IMAGE

FILM_PATH: Final = "film.icml"
RUN_PATH: Final = "film.icrun"


@dataclass
class Film:
    project: Document

    run: Document | None = None
    """运行文件；没有或没读通时为 None。"""

    registered: dict[str, str] = field(default_factory=dict[str, str])
    """运行文件里登记的图：登记名 → 地址。"""

    selected: dict[str, str] = field(default_factory=dict[str, str])
    """运行文件里的选用：生图节点名 → 登记名。"""

    generated: dict[str, str] = field(default_factory=dict[str, str])
    """生图节点名 → 它最近一次生成成功的图片地址；由调用方从生成记录里查来填。"""

    errors: list[str] = field(default_factory=list[str])
    hints: list[str] = field(default_factory=list[str])

    def image_nodes(self) -> list[Node]:
        """工程文件里的生图节点，按先后。"""

        return [
            node
            for node in self.project.root.walk()
            if (tag := self.project.tags.get(node.tag)) is not None
            and tag.generation is not None
            and tag.output == ("image", IMAGE)
        ]

    def given_images(self) -> list[tuple[Document, Node]]:
        """两个文件里用 ``media:Image`` 写了地址的节点：用户给的图和登记的图。"""

        documents = [self.project] if self.run is None else [self.project, self.run]
        return [
            (document, node)
            for document in documents
            for node in document.root.walk()
            if "src" in node.attrs and document.tags.get(node.tag) is not None
        ]

    def image_url(self, reference: str | None, *, assume_generated: bool = False) -> str | None:
        """一个「图」引用现在的地址；还没有图时是 None。

        用户给的图用它自己的地址。生图节点在运行文件里选用了登记的图就用那一张；没有选用就用
        它最近一次生成成功的；都没有就是还没有图。
        ``assume_generated`` 把还没有图的当作已有，给一个占位地址，只用来按「写了的图全部已生成」
        算张数和字数上限。"""

        if reference is None:
            return None
        name = reference.partition(".")[0]
        node = self.project.nodes[name]
        source = node.attrs.get("src")
        if source is not None:
            return source
        chosen = self.selected.get(name)
        if chosen is not None:
            return self.registered[chosen]
        latest = self.generated.get(name)
        if latest is not None:
            return latest
        return f"<待生成:{reference}>" if assume_generated else None


__all__ = ["FILM_PATH", "RUN_PATH", "Film"]
