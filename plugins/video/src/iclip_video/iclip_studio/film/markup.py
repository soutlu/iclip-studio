from __future__ import annotations

import bisect
import re
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Final, Literal
from xml.parsers import expat

from iclip_video.iclip_studio.film.packages import SCRIPT_TAG

HEADER_TARGET: Final = "icml"

_REFERENCE_MARK: Final = "␞ref:"

_USING: Final = re.compile(r'using="([^"]+)"')

_RAW_OPENING: Final = re.compile(rf"<{SCRIPT_TAG}[\s/>]")
_RAW_CLOSING: Final = f"</{SCRIPT_TAG}"

_Piece = Literal["text", "comment", "instruction", "tag", "raw"]


class MarkupError(Exception):
    def __init__(self, line: int, message: str) -> None:
        super().__init__(message)
        self.line = line
        self.message = message


def _no_parts() -> list[str | Node]:
    return []


@dataclass(eq=False)
class Node:
    tag: str
    attrs: dict[str, str]
    line: int
    parent: Node | None = None
    parts: list[str | Node] = field(default_factory=_no_parts)

    opening: tuple[int, int] | None = None

    inner: tuple[int, int] | None = None

    @property
    def children(self) -> list[Node]:
        return [part for part in self.parts if isinstance(part, Node)]

    @property
    def text(self) -> str:
        return _dedent("".join(part for part in self.parts if isinstance(part, str)))

    @property
    def has_text(self) -> bool:
        return any(isinstance(part, str) and part.strip() for part in self.parts)

    def reference(self, name: str) -> str | None:
        value = self.attrs.get(name)
        if value is None or not value.startswith(_REFERENCE_MARK):
            return None
        return value[len(_REFERENCE_MARK) :]

    def walk(self) -> Iterator[Node]:
        yield self
        for child in self.children:
            yield from child.walk()


def is_reference(value: str) -> bool:
    return value.startswith(_REFERENCE_MARK)


def parse(source: str, *, using: str) -> tuple[str, Node]:
    document = Node("#document", {}, 0)
    cursor = [document]
    headers: list[tuple[str, str]] = []
    parser = expat.ParserCreate()
    xml, pieces = _to_xml(source)
    starts = [piece[0] for piece in pieces]

    def piece_at(offset: int) -> tuple[int, int, int] | None:
        index = bisect.bisect_left(starts, offset)
        return pieces[index] if index < len(pieces) and starts[index] == offset else None

    def start(tag: str, attrs: dict[str, str]) -> None:
        node = Node(tag, attrs, parser.CurrentLineNumber, cursor[0])
        piece = piece_at(parser.CurrentByteIndex)
        if piece is not None:
            node.opening = (piece[1], piece[2])
        cursor[0].parts.append(node)
        cursor[0] = node

    def end(_tag: str) -> None:
        node = cursor[0]
        closing = piece_at(parser.CurrentByteIndex)
        if node.opening is not None and closing is not None and source.startswith("</", closing[1]):
            node.inner = (node.opening[1], closing[1])
        parent = node.parent
        assert parent is not None
        cursor[0] = parent

    def doctype(*_args: object) -> None:
        raise MarkupError(parser.CurrentLineNumber, "不能写 DOCTYPE")

    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.CharacterDataHandler = lambda data: cursor[0].parts.append(data)
    parser.ProcessingInstructionHandler = lambda target, data: headers.append((target, data))
    parser.StartDoctypeDeclHandler = doctype
    try:
        parser.Parse(xml, True)
    except expat.ExpatError as exc:
        raise MarkupError(exc.lineno, f"写法错误：{expat.errors.messages[exc.code]}") from exc
    chosen = _USING.fullmatch(headers[0][1]) if headers and headers[0][0] == HEADER_TARGET else None
    if chosen is None:
        raise MarkupError(1, f'第一行要写 <?{HEADER_TARGET} using="{using}"?>')
    return chosen.group(1), document.children[0]


def _dedent(text: str) -> str:
    lines = text.strip("\n").split("\n")
    pad = min((len(line) - len(line.lstrip()) for line in lines if line.strip()), default=0)
    return "\n".join(line[pad:] for line in lines).strip()


def _pieces(source: str) -> Iterator[tuple[_Piece, int, int]]:
    index, size = 0, len(source)
    while index < size:
        if source.startswith("<!--", index):
            close = source.find("-->", index)
            stop = size if close < 0 else close + 3
            yield "comment", index, stop
        elif source.startswith("<?", index):
            close = source.find("?>", index)
            stop = size if close < 0 else close + 2
            yield "instruction", index, stop
        elif source[index] == "<":
            stop = _tag_end(source, index)
            yield "tag", index, stop
            if _RAW_OPENING.match(source, index) and not source.endswith("/>", index, stop):
                close = source.find(_RAW_CLOSING, stop)
                index, stop = stop, size if close < 0 else close
                if stop > index:
                    yield "raw", index, stop
        else:
            close = source.find("<", index)
            stop = size if close < 0 else close
            yield "text", index, stop
        index = stop


def _tag_end(source: str, start: int) -> int:
    index, quote, depth = start + 1, "", 0
    while index < len(source):
        char = source[index]
        if quote:
            quote = "" if char == quote else quote
        elif char in "\"'":
            quote = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
        elif char == ">" and depth <= 0:
            return index + 1
        index += 1
    return len(source)


def _to_xml(source: str) -> tuple[str, list[tuple[int, int, int]]]:
    out: list[str] = []
    pieces: list[tuple[int, int, int]] = []
    offset = 0
    for kind, start, stop in _pieces(source):
        if kind == "tag":
            text = _tag_to_xml(source, start, stop)
        elif kind == "raw":
            text = (
                source[start:stop].replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            )
        else:
            text = source[start:stop]
        pieces.append((offset, start, stop))
        out.append(text)
        offset += len(text.encode("utf-8"))
    return "".join(out), pieces


def _tag_to_xml(source: str, start: int, stop: int) -> str:
    tag = source[start:stop]
    out: list[str] = []
    index, quote = 0, ""
    while index < len(tag):
        char = tag[index]
        if quote:
            quote = "" if char == quote else quote
        elif char in "\"'":
            quote = char
        elif char == "=" and tag[index + 1 : index + 2] == "{":
            close = tag.find("}", index)
            if close < 0:
                line = source.count("\n", 0, start + index) + 1
                raise MarkupError(line, "引用的花括号没有闭合")
            name = tag[index + 2 : close].replace("&", "&amp;").replace('"', "&quot;")
            out.append(f'="{_REFERENCE_MARK}{name.replace("<", "&lt;")}"')
            index = close + 1
            continue
        out.append(char)
        index += 1
    return "".join(out)


__all__ = ["HEADER_TARGET", "MarkupError", "Node", "is_reference", "parse"]
