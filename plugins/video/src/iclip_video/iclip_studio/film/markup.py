from __future__ import annotations

import bisect
import re
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Final, Literal
from xml.parsers import expat

from iclip_video.iclip_studio.film.packages import SCRIPT_TAG
from iclip_video.iclip_studio.film.script import ENTITY

HEADER_TARGET: Final = "icml"

_REFERENCE_MARK: Final = "␞ref:"

_USING: Final = re.compile(r'using="([^"]+)"')

_RAW_OPENING: Final = re.compile(rf"<{SCRIPT_TAG}[\s/>]")
_RAW_CLOSING: Final = f"</{SCRIPT_TAG}"

_TAG_STARTERS: Final = "/!?_:"
_CLOSING_NAME: Final = re.compile(rb"[^\s/>]+")

_TAG_MISMATCH: Final = expat.errors.codes[expat.errors.XML_ERROR_TAG_MISMATCH]
_NO_ELEMENTS: Final = expat.errors.codes[expat.errors.XML_ERROR_NO_ELEMENTS]
_UNCLOSED_TOKEN: Final = expat.errors.codes[expat.errors.XML_ERROR_UNCLOSED_TOKEN]

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
        raise _syntax_error(exc, xml, parser.ErrorByteIndex, document, cursor[0]) from exc
    chosen = _USING.fullmatch(headers[0][1]) if headers and headers[0][0] == HEADER_TARGET else None
    if chosen is None:
        raise MarkupError(1, f'第一行要写 <?{HEADER_TARGET} using="{using}"?>')
    return chosen.group(1), document.children[0]


def _syntax_error(
    exc: expat.ExpatError, xml: str, at: int, document: Node, open_node: Node
) -> MarkupError:
    line = exc.lineno
    if open_node is document:
        if document.children:
            return MarkupError(line, f"</{document.children[0].tag}> 后面不能再写内容")
    elif exc.code == _TAG_MISMATCH:
        closing = _CLOSING_NAME.match(xml.encode("utf-8"), at)
        assert closing is not None
        return MarkupError(
            open_node.line,
            f"<{open_node.tag}> 没有正确闭合，"
            f"到第 {line} 行遇到了 </{closing.group(0).decode('utf-8')}>",
        )
    elif exc.code == _NO_ELEMENTS or (
        exc.code == _UNCLOSED_TOKEN and line == xml.rstrip().count("\n") + 1
    ):
        return MarkupError(line, f"文件到这里就结束了，<{open_node.tag}> 没有闭合；把文件写完整")
    return MarkupError(line, f"写法错误：{expat.errors.messages[exc.code]}")


def _line_at(source: str, index: int) -> int:
    return source.count("\n", 0, index) + 1


def _check_ampersands(source: str, start: int, stop: int) -> None:
    index = source.find("&", start, stop)
    while index >= 0:
        if ENTITY.match(source, index) is None:
            raise MarkupError(_line_at(source, index), "& 要写成 &amp;")
        index = source.find("&", index + 1, stop)


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
            if kind == "text":
                # expat 对裸 & 报的行号不可靠（会把后面的字一直当实体名读下去），所以先自己查
                _check_ampersands(source, start, stop)
            text = source[start:stop]
        pieces.append((offset, start, stop))
        out.append(text)
        offset += len(text.encode("utf-8"))
    return "".join(out), pieces


def _tag_to_xml(source: str, start: int, stop: int) -> str:
    tag = source[start:stop]
    first = tag[1:2]
    if first and not (first.isalpha() or first in _TAG_STARTERS):
        raise MarkupError(_line_at(source, start), "正文里的 < 要写成 &lt;")
    out: list[str] = []
    index, quote = 0, ""
    while index < len(tag):
        char = tag[index]
        after = tag[index + 1 : index + 2]
        if quote:
            if char == quote:
                quote = ""
            elif char == "&" and ENTITY.match(tag, index) is None:
                raise MarkupError(_line_at(source, start + index), "& 要写成 &amp;")
        elif char in "\"'":
            quote = char
        elif char == "=" and after == "{":
            close = tag.find("}", index)
            if close < 0:
                raise MarkupError(_line_at(source, start + index), "引用的花括号没有闭合")
            name = tag[index + 2 : close].replace("&", "&amp;").replace('"', "&quot;")
            out.append(f'="{_REFERENCE_MARK}{name.replace("<", "&lt;")}"')
            index = close + 1
            continue
        elif char == "=" and after and after not in "\"'" and not after.isspace():
            raise MarkupError(
                _line_at(source, start + index), "属性值要加英文双引号，引用要写成 {名字}"
            )
        out.append(char)
        index += 1
    return "".join(out)


__all__ = ["HEADER_TARGET", "MarkupError", "Node", "is_reference", "parse"]
