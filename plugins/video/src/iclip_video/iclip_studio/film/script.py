from __future__ import annotations

import html
import re
from dataclasses import dataclass
from typing import Final

SEGMENT_NAME: Final = re.compile(r"[a-z][a-z0-9_-]{0,63}")

_SPEAKER: Final = re.compile(r"[0-9A-Za-z一-鿿]+")
_OPENING: Final = re.compile(r"<([^<>\s/]+)>")
_TAG_LIKE: Final = re.compile(r"<[^<>]*>")
_COMMENT: Final = re.compile(r"<!--.*?-->", re.S)
_ENTITY: Final = re.compile(r"&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);")


@dataclass(frozen=True, slots=True)
class ScriptLine:
    name: str

    speaker: str
    text: str
    line: int

    span: tuple[int, int] | None


def read_script(
    source: str, start: int, stop: int
) -> tuple[list[ScriptLine], list[tuple[int, str]]]:
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
