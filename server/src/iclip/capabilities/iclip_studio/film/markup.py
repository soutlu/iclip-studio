"""工程文件与运行文件共用的写法：把源文读成节点树。

写法是 XML 加两条：``属性={名字}`` 表示引用前面定义的节点，不加引号；``<script>`` 的正文是剧本，
不按 XML 读。解析分两步：先把标签里引号外的 ``={名字}`` 换成带记号的普通属性值、把剧本正文转义成
普通文字，再交给标准库的 XML 解析器。换的时候不增减换行，所以报错的行号就是原文的行号；每个标签
还记下它在原文里的位置，改一处正文或属性时只换那一段。剧本正文读出来与原文一字不差，由
``script`` 按剧本的写法再读。"""

from __future__ import annotations

import bisect
import re
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Final, Literal
from xml.parsers import expat

from iclip.capabilities.iclip_studio.film.packages import SCRIPT_TAG

HEADER_TARGET: Final = "icml"
"""文件头 ``<?icml using="…"?>`` 的名字，工程文件和运行文件相同。"""

_REFERENCE_MARK: Final = "␞ref:"
"""换成普通属性值后的引用前缀；记录分隔符的图形字符，正常文本里不会出现。"""

_USING: Final = re.compile(r'using="([^"]+)"')

_RAW_OPENING: Final = re.compile(rf"<{SCRIPT_TAG}[\s/>]")
_RAW_CLOSING: Final = f"</{SCRIPT_TAG}"

_Piece = Literal["text", "comment", "instruction", "tag", "raw"]


class MarkupError(Exception):
    """源文读不成节点树：XML 写错、引用的花括号没闭合，或缺文件头。"""

    def __init__(self, line: int, message: str) -> None:
        super().__init__(message)
        self.line = line
        self.message = message


def _no_parts() -> list[str | Node]:
    return []


@dataclass(eq=False)
class Node:
    """一个标签：名字、属性、所在行，以及按出现顺序排的正文片段与子标签。"""

    tag: str
    attrs: dict[str, str]
    line: int
    parent: Node | None = None
    parts: list[str | Node] = field(default_factory=_no_parts)

    opening: tuple[int, int] | None = None
    """开始标签在原文里的起止位置（字符下标，含尖括号）；对不上原文时为 None，这个标签不能就地改。"""

    inner: tuple[int, int] | None = None
    """开始标签与结束标签之间那一段在原文里的起止位置；自闭合或对不上原文时为 None。"""

    @property
    def children(self) -> list[Node]:
        return [part for part in self.parts if isinstance(part, Node)]

    @property
    def text(self) -> str:
        """正文：去掉首尾空行和每行共同的缩进。"""

        return _dedent("".join(part for part in self.parts if isinstance(part, str)))

    @property
    def has_text(self) -> bool:
        return any(isinstance(part, str) and part.strip() for part in self.parts)

    def reference(self, name: str) -> str | None:
        """属性写的是引用时返回花括号里的名字；没写这个属性或写的是普通值返回 None。"""

        value = self.attrs.get(name)
        if value is None or not value.startswith(_REFERENCE_MARK):
            return None
        return value[len(_REFERENCE_MARK) :]

    def walk(self) -> Iterator[Node]:
        """自己和全部后代，按文件里的先后。"""

        yield self
        for child in self.children:
            yield from child.walk()


def is_reference(value: str) -> bool:
    """属性值是不是 ``={名字}`` 写出来的引用。"""

    return value.startswith(_REFERENCE_MARK)


def parse(source: str, *, using: str) -> tuple[str, Node]:
    """读源文，返回 (文件头里选的写法, 根节点)。``using`` 只用来在缺文件头时提示该写什么。"""

    document = Node("#document", {}, 0)
    cursor = [document]
    headers: list[tuple[str, str]] = []
    parser = expat.ParserCreate()
    xml, pieces = _to_xml(source)
    # 解析器报的位置是换过之后、按 UTF-8 编码的字节下标；按片段起点查回原文的字符下标。
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
        # 自闭合的标签报的是标签末尾，那里不是结束标签，这样的标签没有正文那一段。
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
    """把源文切成正文、注释、处理指令、标签、剧本正文五种片段，给出起止位置。"""

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
                # 剧本正文一直到 </script>；没有结束标签时剩下的全算正文，由 XML 解析器报没闭合。
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
    """标签的结束位置：引号和花括号里的 ``>`` 不算。"""

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
    """换成标准 XML，并给出每个片段 (换过之后的字节起点, 原文起点, 原文终点)。"""

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
    """标签里引号外的 ``={名字}`` 换成 ``="<记号>名字"``。"""

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
