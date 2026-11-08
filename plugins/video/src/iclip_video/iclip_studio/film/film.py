from __future__ import annotations

from dataclasses import dataclass, field
from typing import Final

from iclip_video.iclip_studio.film.document import Document
from iclip_video.iclip_studio.film.markup import Node
from iclip_video.iclip_studio.film.packages import IMAGE
from iclip_video.iclip_studio.film.script import ScriptLine

FILM_PATH: Final = "film.icml"
RUN_PATH: Final = "film.icrun"


@dataclass
class Film:
    project: Document

    run: Document | None = None

    registered: dict[str, str] = field(default_factory=dict[str, str])

    selected: dict[str, str] = field(default_factory=dict[str, str])

    lines: dict[str, ScriptLine] = field(default_factory=dict[str, ScriptLine])

    errors: list[str] = field(default_factory=list[str])

    def image_nodes(self) -> list[Node]:
        return [
            node
            for node in self.project.root.walk()
            if (tag := self.project.tags.get(node.tag)) is not None
            and tag.generation is not None
            and tag.output == ("image", IMAGE)
        ]

    def given_images(self) -> list[tuple[Document, Node]]:
        documents = [self.project] if self.run is None else [self.project, self.run]
        return [
            (document, node)
            for document in documents
            for node in document.root.walk()
            if "src" in node.attrs and document.tags.get(node.tag) is not None
        ]

    def image_url(self, reference: str | None) -> str | None:
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
