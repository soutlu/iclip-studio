"""一条新片读进来以后的样子：工程文件、剧本里的台词、运行文件里登记和选用的图，以及每个图引用
现在的地址。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Final

from iclip.capabilities.iclip_studio.film.document import Document
from iclip.capabilities.iclip_studio.film.markup import Node
from iclip.capabilities.iclip_studio.film.packages import IMAGE
from iclip.capabilities.iclip_studio.film.script import ScriptLine

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

    lines: dict[str, ScriptLine] = field(default_factory=dict[str, ScriptLine])
    """剧本里的台词：段名 → 台词，按剧本的先后；检查内容时读出来。"""

    errors: list[str] = field(default_factory=list[str])

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

    def image_url(self, reference: str | None) -> str | None:
        """一个「图」引用现在的地址；还没有图时是 None。

        用户给的图用它自己的地址。生图节点只认运行文件里的选用：选用了登记的图就用那一张，
        没有选用就是还没有图，生成过也不算。"""

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
        return None


__all__ = ["FILM_PATH", "RUN_PATH", "Film"]
