"""剧本：``<script>`` 的正文按 hypit 剧本写法的一个子集读。

剧本由一段一段组成，一段写成 ``<段名><说话人>台词</段名>``，一段就是一句台词；段与段之间只能有
空白和注释。hypit 剧本的其余写法这一版不支持，写了就报「剧本里不支持……」。台词里的 ``&`` 和
``<`` 照 XML 转义，读出来的台词是转义还原、去掉首尾空白、连续空白合成一个空格之后的字。"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass
from typing import Final

SEGMENT_NAME: Final = re.compile(r"[a-z][a-z0-9_-]{0,63}")
"""段名：小写英文字母开头，后面是小写英文字母、数字、``-``、``_``，最长 64 个字符。"""

_SPEAKER: Final = re.compile(r"[0-9A-Za-z一-鿿]+")
_OPENING: Final = re.compile(r"<([^<>\s/]+)>")
_TAG_LIKE: Final = re.compile(r"<[^<>]*>")
_COMMENT: Final = re.compile(r"<!--.*?-->", re.S)
_ENTITY: Final = re.compile(r"&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);")


@dataclass(frozen=True, slots=True)
class ScriptLine:
    """剧本里的一句台词。"""

    name: str
    """段名，镜头正文里写 ``{段名}`` 引用。"""

    speaker: str
    text: str
    line: int
    """这一段在文件里的行号。"""

    span: tuple[int, int] | None
    """台词原文（去掉首尾空白）在文件原文里的位置；台词里夹着注释时为 None，不能就地改。"""


def read_script(
    source: str, start: int, stop: int
) -> tuple[list[ScriptLine], list[tuple[int, str]]]:
    """读 ``source[start:stop]`` 这段剧本正文，返回 (按先后排的台词, (行号, 问题))。

    有问题的段不进台词表；一段只报它的第一处问题。"""

    reader = _Reader(source)
    position = start
    while position < stop:
        position = _skip_space(source, position, stop)
        if position >= stop:
            break
        if source.startswith("<!--", position):
            close = source.find("-->", position, stop)
            if close < 0:
                reader.problem(position, "剧本里的注释没有闭合")
                break
            position = close + 3
            continue
        opening = _OPENING.match(source, position, stop)
        if opening is None:
            reader.problem(position, "剧本里段与段之间只能有空白和注释，一段写成 <段名>……</段名>")
            following = source.find("<", position + 1, stop)
            position = stop if following < 0 else following
            continue
        name = opening.group(1)
        closing = f"</{name}>"
        end = source.find(closing, opening.end(), stop)
        if end < 0:
            reader.problem(position, f"段 <{name}> 没有用 {closing} 闭合")
            break
        reader.segment(name, position, opening.end(), end)
        position = end + len(closing)
    return reader.lines, reader.problems


class _Reader:
    def __init__(self, source: str) -> None:
        self.source = source
        self.lines: list[ScriptLine] = []
        self.problems: list[tuple[int, str]] = []
        self._names: set[str] = set()

    def line_of(self, position: int) -> int:
        return self.source.count("\n", 0, position) + 1

    def problem(self, position: int, message: str) -> None:
        self.problems.append((self.line_of(position), message))

    def segment(self, name: str, at: int, start: int, stop: int) -> None:
        """一段：``source[start:stop]`` 是段名标签和结束标签之间的那一段。"""

        source = self.source
        if not SEGMENT_NAME.fullmatch(name):
            self.problem(
                at,
                f"段名 {name} 不对：小写英文字母开头，后面是小写英文字母、数字、- 和 _，"
                "最长 64 个字符",
            )
            return
        if name in self._names:
            self.problem(at, f"段名 {name} 重复")
            return
        self._names.add(name)
        begin = _skip_space(source, start, stop)
        if begin >= stop:
            self.problem(at, "剧本里不支持空的段")
            return
        speaker = _TAG_LIKE.match(source, begin, stop)
        if speaker is None:
            self.problem(at, f"段 {name} 开头要写说话人，如 <短发女生>")
            return
        role = speaker.group(0)[1:-1]
        if "|" in role:
            self.problem(at, "剧本里不支持 <显示|读法> 的写法")
            return
        if not _SPEAKER.fullmatch(role):
            self.problem(at, f"说话人 {role} 只能用中文、英文字母和数字")
            return
        raw = source[speaker.end() : stop]
        commented = _COMMENT.search(raw) is not None
        visible = _COMMENT.sub(" ", raw)
        fault = _fault(visible)
        if fault is not None:
            self.problem(at, fault)
            return
        text = " ".join(html.unescape(visible).split())
        if not text:
            self.problem(at, f"段 {name} 的台词是空的")
            return
        left = speaker.end() + len(raw) - len(raw.lstrip())
        right = stop - (len(raw) - len(raw.rstrip()))
        self.lines.append(
            ScriptLine(name, role, text, self.line_of(at), None if commented else (left, right))
        )


def _skip_space(source: str, position: int, stop: int) -> int:
    while position < stop and source[position].isspace():
        position += 1
    return position


def _fault(text: str) -> str | None:
    """台词里第一处不支持或写错的地方；都没有返回 None。"""

    tag = _TAG_LIKE.search(text)
    if tag is not None:
        if "|" in tag.group(0):
            return "剧本里不支持 <显示|读法> 的写法"
        return "剧本里不支持一段里写第二个说话人"
    if "<" in text:
        return "台词里的 < 要写成 &lt;"
    if "||" in text:
        return "剧本里不支持 ||"
    if "|" in text:
        return "剧本里不支持单独的 |"
    if "@{" in text:
        return "剧本里不支持 @{…}"
    if "{" in text or "}" in text:
        return "剧本里不支持花括号"
    if text.count("&") != len(_ENTITY.findall(text)):
        return "台词里的 & 要写成 &amp;"
    return None


__all__ = ["SEGMENT_NAME", "ScriptLine", "read_script"]
