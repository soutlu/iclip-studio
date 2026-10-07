"""制作页：把检查通过的工程按视频请求排成镜头组，改一段字，给一张图换地址。

改字和换图只替换原文里对应的那几段，文件其余部分一个字不动；写之前按人保存文件时的同一套规则
检查，有问题就不写，说明是给人看的一句话。

定位用 ``target``：``shot:<Storyboard 名>:<第几个镜头>``、``element:<元素名>``、
``value:<文字名>``、``voice:<说话人>``、``block:<Storyboard 名>``；镜头里的台词用
``line:<台词名>`` 对上是哪一句。它们只在同一版文件里有效，改字时带着文件版本号一起传回。"""

from __future__ import annotations

import re
from collections.abc import Sequence
from typing import Final

from iclip.capabilities.iclip_studio.film.checks import check, check_project_content, load_project
from iclip.capabilities.iclip_studio.film.document import Document
from iclip.capabilities.iclip_studio.film.film import FILM_PATH, RUN_PATH, Film
from iclip.capabilities.iclip_studio.film.markup import Node
from iclip.capabilities.iclip_studio.film.packages import (
    IMAGE,
    MEDIA_PACKAGE,
    PROMPT_MAX_CHARS,
    RUN_MARKUP,
    RUN_ROOT,
    SEEDANCE_VARIANTS,
)
from iclip.capabilities.iclip_studio.film.prompts import (
    BODY_PHRASE,
    LINE_REFERENCE,
    PicturePrompt,
    body_sentence,
    for_video,
    render_picture,
    storyboard_images,
)
from iclip.common.film_view import (
    FilmFrame,
    FilmGroup,
    FilmLine,
    FilmPromptImage,
    FilmPromptText,
    FilmSetting,
    FilmShot,
    FilmTextEdit,
)

_SENTENCE_MARKS: Final = "。！？"
_LINE_SPLIT: Final = re.compile(r"\{[^{}]*\}")
_SRC: Final = re.compile(r"""(\ssrc\s*=\s*)(["'])(.*?)\2""", re.S)
_UNWRITABLE: Final = ("<!--", "<![CDATA[")
"""正文里有注释或 CDATA 时只换那一段会把它们弄丢，这样的正文不让在页面上改。"""


class FilmEditRejected(ValueError):
    """这次改动没有写进文件；消息是给人看的一句话。"""


def film_groups(film: Film, source: str) -> tuple[FilmGroup, ...]:
    """每个视频节点一组，顺序与文件里相同。``film`` 是工程文件 ``source`` 检查通过后的样子。"""

    project = film.project
    videos = project.find("ReferenceVideo")
    storyboards = [project.nodes[_required(video, "prompt")] for video in videos]
    elements, views = _image_owners(project, storyboards)
    groups: list[FilmGroup] = []
    for index, (video, storyboard) in enumerate(zip(videos, storyboards, strict=True), start=1):
        frames: dict[str, FilmFrame] = {}
        for use in storyboard_images(film, storyboard)[0]:
            if use.image in frames:
                continue
            generated = _generated(project, use.image)
            prompt = None
            if generated:
                prompt = tuple(
                    FilmPromptText(run)
                    if isinstance(run, str)
                    else FilmPromptImage(
                        run.image, _label(run.image, index, elements, views), run.url
                    )
                    for run in image_prompt(film, use.image).runs
                )
            frames[use.image] = FilmFrame(
                node=use.image,
                label=_label(use.image, index, elements, views),
                kind="generated" if generated else "photo",
                url=use.url,
                number=use.number,
                prompt=prompt,
            )
        groups.append(
            FilmGroup(
                index=index,
                video=video.attrs["id"],
                model=SEEDANCE_VARIANTS[video.attrs["model"]][0],
                seconds=int(video.attrs["duration"]),
                aspect_ratio=video.attrs["aspect-ratio"],
                frames=tuple(frames.values()),
                settings=_settings(project, storyboard, source),
                shots=_shots(project, storyboard, source),
            )
        )
    return tuple(groups)


def image_prompt(film: Film, image: str) -> PicturePrompt:
    """按描述生成 ``image`` 这个生图节点时发给模型的描述与参考图。"""

    node = film.project.nodes[image]
    return render_picture(film, film.project.nodes[_required(node, "prompt")])


def edit_text(source: str, film: Film, edits: Sequence[FilmTextEdit]) -> str:
    """把几段字写回工程文件，返回新的原文。``film`` 是 ``source`` 检查通过后的样子。

    镜头的改动带着这一镜的每句台词，台词只改字：不能删、不能加、不能调先后，说话人不变。台词的字
    改在台词表里。用户打的花括号换成全角，免得当成台词；不能写 ``@Image``，图的编号由后端算。"""

    if not edits:
        raise FilmEditRejected("没有要改的字")
    if len({edit.target for edit in edits}) != len(edits):
        raise FilmEditRejected("同一段字一次只改一处")
    project = film.project
    splice = _Splice()
    expected: list[tuple[str, str]] = []
    said: list[tuple[str, str]] = []
    for edit in edits:
        node = _resolve(project, edit.target)
        if node is None or not _editable(source, project, node):
            raise FilmEditRejected("要改的这段字找不到了，刷新后再改")
        if project.is_a(node, "Shot"):
            text, lines = _shot_text(node, edit)
            for name, words in lines:
                line = project.nodes[name]
                if words != line.text:
                    assert line.inner is not None
                    splice.replace(line.inner, _body(source[slice(*line.inner)], words))
                    said.append((name, words))
        else:
            text = _new_text(project, node, edit)
        assert node.inner is not None
        splice.replace(node.inner, _body(source[slice(*node.inner)], text))
        expected.append((edit.target, text))
    updated = splice.apply(source)
    problems = check_project_content(updated)
    if problems:
        too_long = any(f"超过 {PROMPT_MAX_CHARS} 字" in problem for problem in problems)
        if too_long:
            raise FilmEditRejected(f"改完以后描述超过 {PROMPT_MAX_CHARS} 字了，删短一些再保存")
        raise FilmEditRejected("这样改以后分镜有问题，没有保存；可以跟 AI 导演说想怎么改")
    rewritten = load_project(updated)
    for target, text in expected:
        node = _resolve(rewritten, target)
        if node is None or node.text != text:
            raise RuntimeError(f"写回后 {target} 读出来和要写的不一样")
    for name, words in said:
        if rewritten.nodes[name].text != words:
            raise RuntimeError(f"写回后台词 {name} 读出来和要写的不一样")
    return updated


def choose_image(
    film: Film, project_source: str, run_source: str | None, image: str, url: str | None
) -> tuple[str, str] | None:
    """给一个图片节点换图，返回 (要写的文件, 新的原文)；本来就是这样时返回 None。

    生图节点在运行文件里登记这张图并选用它，``url`` 为 None 是取消选用、回到最近一次生成的；
    用户给的图直接改工程文件里的地址，不能没有图。``url`` 是不是这段对话的图由调用方先认。"""

    project = film.project
    node = project.nodes.get(image)
    if node is None or project.declared(node).output not in (("", IMAGE), ("image", IMAGE)):
        raise FilmEditRejected("找不到这张图，刷新后再换")
    if _generated(project, image):
        updated = _select_in_run(film, run_source, image, url)
        if updated is None:
            return None
        written = check(project_source, updated)
        if isinstance(written, list) or written.errors:
            raise RuntimeError(f"给 {image} 换图后运行文件没有通过检查")
        return RUN_PATH, updated
    if url is None:
        raise FilmEditRejected("这张图是你给的，只能换成另一张，不能清空")
    if node.attrs.get("src") == url:
        return None
    found = None if node.opening is None else _SRC.search(project_source, *node.opening)
    if node.opening is None or found is None:
        raise FilmEditRejected("这张图的地址没法在页面上换，跟 AI 导演说")
    start, stop = found.span(3)
    updated = project_source[:start] + _attribute(url, found.group(2)) + project_source[stop:]
    if check_project_content(updated):
        raise RuntimeError(f"给 {image} 换图后工程文件没有通过检查")
    return FILM_PATH, updated


def _image_owners(
    project: Document, storyboards: list[Node]
) -> tuple[dict[str, str], dict[str, tuple[int, int]]]:
    """图片节点 → 挂它的出场元素；图片节点 → 用它当机位图的 (第几组, 第几个镜头)。都取最先写的。"""

    elements: dict[str, str] = {}
    holders = [
        node
        for node in project.root.walk()
        if project.is_a(node, "Picture") or project.is_a(node, "Storyboard")
    ]
    for holder in holders:
        for cast in project.kids(holder, "Cast"):
            image, element = cast.reference("image"), cast.reference("element")
            if image is not None and element is not None:
                elements.setdefault(image.partition(".")[0], element)
    views: dict[str, tuple[int, int]] = {}
    for group, storyboard in enumerate(storyboards, start=1):
        for number, shot in enumerate(project.kids(storyboard, "Shot"), start=1):
            view = shot.reference("view")
            if view is not None:
                views.setdefault(view.partition(".")[0], (group, number))
    return elements, views


def _label(
    image: str, group: int, elements: dict[str, str], views: dict[str, tuple[int, int]]
) -> str:
    if image in elements:
        return elements[image]
    if image in views:
        owner, number = views[image]
        return f"镜头 {number}" if owner == group else f"第 {owner} 组镜头 {number}"
    return image


def _generated(project: Document, image: str) -> bool:
    return project.declared(project.nodes[image]).generation is not None


def _settings(project: Document, storyboard: Node, source: str) -> tuple[FilmSetting, ...]:
    """全局设定，与拼给视频的先后相同：拍法、各出场元素、这组里说了话的声音。"""

    name = storyboard.attrs["id"]

    def target(node: Node, value: str) -> str | None:
        return value if _writable(source, node) else None

    settings: list[FilmSetting] = []
    for block in project.kids(storyboard, "Block"):
        shared = block.reference("text")
        if shared is not None:
            value = project.nodes[shared]
            settings.append(
                FilmSetting("shooting", target(value, f"value:{shared}"), None, value.text, None)
            )
        if block.text:
            settings.append(
                FilmSetting("shooting", target(block, f"block:{name}"), None, block.text, None)
            )
    for cast in project.kids(storyboard, "Cast"):
        element = project.nodes[_required(cast, "element")]
        image = cast.reference("image")
        settings.append(
            FilmSetting(
                "element",
                target(element, f"element:{element.attrs['id']}"),
                f"{element.attrs['type']} {element.attrs['id']}",
                for_video(element.text),
                None if image is None else image.partition(".")[0],
            )
        )
    voices = {voice.attrs["role"]: voice for voice in project.find("Voice")}
    speakers: list[str] = []
    for shot in project.kids(storyboard, "Shot"):
        for line in LINE_REFERENCE.findall(shot.text):
            role = project.nodes[line].attrs["role"]
            if role not in speakers:
                speakers.append(role)
    settings += [
        FilmSetting(
            "voice", target(voices[role], f"voice:{role}"), f"声音 {role}", voices[role].text, None
        )
        for role in speakers
        if role in voices
    ]
    return tuple(settings)


def _shots(project: Document, storyboard: Node, source: str) -> tuple[FilmShot, ...]:
    name = storyboard.attrs["id"]
    shots: list[FilmShot] = []
    for number, shot in enumerate(project.kids(storyboard, "Shot"), start=1):
        text = shot.text
        lines = [
            FilmLine(f"line:{line}", project.nodes[line].attrs["role"], project.nodes[line].text)
            for line in LINE_REFERENCE.findall(text)
        ]
        view = shot.reference("view")
        shots.append(
            FilmShot(
                target=f"shot:{name}:{number}" if _editable(source, project, shot) else None,
                start=float(shot.attrs["start"]),
                end=float(shot.attrs["end"]),
                parts=tuple(_LINE_SPLIT.split(text)),
                lines=tuple(lines),
                view=None if view is None else view.partition(".")[0],
            )
        )
    return tuple(shots)


def _resolve(project: Document, target: str) -> Node | None:
    """``target`` 指的那个有正文的标签；对不上返回 None。"""

    kind, _, rest = target.partition(":")
    if kind == "shot":
        name, _, number = rest.rpartition(":")
        storyboard = project.nodes.get(name)
        if storyboard is None or not project.is_a(storyboard, "Storyboard"):
            return None
        shots = project.kids(storyboard, "Shot")
        index = int(number) - 1 if number.isdigit() else -1
        return shots[index] if 0 <= index < len(shots) else None
    if kind == "block":
        storyboard = project.nodes.get(rest)
        if storyboard is None or not project.is_a(storyboard, "Storyboard"):
            return None
        blocks = project.kids(storyboard, "Block")
        return blocks[0] if blocks else None
    if kind == "voice":
        return next((v for v in project.find("Voice") if v.attrs["role"] == rest), None)
    wanted = {"element": "Element", "value": "Value"}.get(kind)
    node = project.nodes.get(rest)
    if wanted is None or node is None or not project.is_a(node, wanted):
        return None
    return node


def _writable(source: str, node: Node) -> bool:
    if node.opening is None or node.inner is None or node.children:
        return False
    raw = source[node.inner[0] : node.inner[1]]
    return not any(mark in raw for mark in _UNWRITABLE)


def _editable(source: str, project: Document, node: Node) -> bool:
    """页面上能不能改这段：镜头连同它的每句台词都要能就地改。"""

    if not _writable(source, node):
        return False
    if not project.is_a(node, "Shot"):
        return True
    return all(_writable(source, project.nodes[line]) for line in LINE_REFERENCE.findall(node.text))


def _new_text(project: Document, node: Node, edit: FilmTextEdit) -> str:
    """镜头以外这次要写进这个标签的正文（未转义）。"""

    if edit.text is None:
        raise FilmEditRejected("要给改好的文字")
    text = _clean(edit.text).strip()
    if not text:
        raise FilmEditRejected("这段字不能是空的")
    if project.is_a(node, "Element"):
        return _with_body_sentence(text, node.text)
    return text


class _Splice:
    """攒下对原文的几处替换与插入，最后从后往前一次改完，前面的位置不受影响。"""

    def __init__(self) -> None:
        self._edits: list[tuple[int, int, int, str]] = []

    def replace(self, span: tuple[int, int], text: str) -> None:
        self._edits.append((span[0], 1, span[1], text))

    def insert(self, position: int, text: str) -> None:
        self._edits.append((position, 0, position, text))

    def apply(self, source: str) -> str:
        # 同一处先替换再插入，插入的才不会被替换掉；插在同一处的几段按加进来的先后排。
        ordered = sorted(
            enumerate(self._edits), key=lambda item: (item[1][0], item[1][1], item[0]), reverse=True
        )
        for _, (start, _, stop, text) in ordered:
            source = source[:start] + text + source[stop:]
        return source


def _shot_text(shot: Node, edit: FilmTextEdit) -> tuple[str, list[tuple[str, str]]]:
    """核对一个镜头的改动，返回 (镜头的新正文, 每句台词的名字与新的字)，都未转义。"""

    names = LINE_REFERENCE.findall(shot.text)
    lines = edit.lines
    if edit.parts is None or lines is None or len(edit.parts) != len(lines) + 1:
        raise FilmEditRejected("镜头的文字和台词对不上，刷新后再改")
    if [line.target for line in lines] != [f"line:{name}" for name in names]:
        raise FilmEditRejected("台词只能改字，不能删、不能加，也不能调先后；要动台词跟 AI 导演说")
    said: list[tuple[str, str]] = []
    for name, line in zip(names, lines, strict=True):
        words = _clean(line.text).strip()
        if not words:
            raise FilmEditRejected("台词不能是空的")
        said.append((name, words))
    parts = [_clean(part) for part in edit.parts]
    body = parts[0] + "".join(
        "{" + name + "}" + part for name, part in zip(names, parts[1:], strict=True)
    )
    if not LINE_REFERENCE.sub("", body).strip():
        raise FilmEditRejected("镜头的文字不能是空的")
    return body.strip(), said


def _clean(text: str) -> str:
    if "@Image" in text:
        raise FilmEditRejected("文字里不能写 @Image，图的编号是自动排的")
    return text.replace("{", "｛").replace("}", "｝")


def _with_body_sentence(visible: str, old: str) -> str:
    """把只给生图用的那句英文身材句放回描述里：放在原来前面有几句话的位置，句数不够就放最后。"""

    found = body_sentence(old)
    if found is None or BODY_PHRASE in visible:
        return visible
    sentence = found.group(0).strip()
    before = sum(old[: found.start()].count(mark) for mark in _SENTENCE_MARKS)
    position = 0
    for _ in range(before):
        ends = [visible.find(mark, position) for mark in _SENTENCE_MARKS]
        ends = [end for end in ends if end >= 0]
        if not ends:
            position = len(visible)
            break
        position = min(ends) + 1
    head, tail = visible[:position], visible[position:]
    if head and head[-1] not in _SENTENCE_MARKS:
        head += " "
    return head + sentence + (" " + tail if tail else "")


def _body(raw: str, text: str) -> str:
    """按原来的排版写出新正文：原来另起一行缩进写的，新的每行也这样缩进。"""

    lines = _escape(text).split("\n")
    lead = raw[: len(raw) - len(raw.lstrip())]
    trail = raw[len(raw.rstrip()) :] if raw.strip() else ""
    if "\n" not in lead:
        return lead + "\n".join(lines) + trail
    pad = lead.rsplit("\n", 1)[1]
    rest = "".join("\n" + (pad + line if line else "") for line in lines[1:])
    return lead + lines[0] + rest + trail


def _escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _attribute(value: str, quote: str) -> str:
    escaped = _escape(value)
    return escaped.replace('"', "&quot;") if quote == '"' else escaped.replace("'", "&apos;")


def _select_in_run(film: Film, source: str | None, image: str, url: str | None) -> str | None:
    """在运行文件里给 ``image`` 选用 ``url``；``url`` 为 None 时删掉它的选用。没变化返回 None。"""

    output = f"{image}.image"
    run = film.run
    if source is None:
        if url is None:
            return None
        return (
            f'<?icml using="{RUN_MARKUP}"?>\n'
            f'<{RUN_ROOT} version="1">\n'
            f'  <film source="./{FILM_PATH}"/>\n'
            f'  <import as="media" from="{MEDIA_PACKAGE.ref}"/>\n\n'
            f'  <media:Image id="{image}-1" src={_quoted(url)}/>\n\n'
            f'  <use output="{output}" image={{{image}-1}}/>\n'
            f"</{RUN_ROOT}>\n"
        )
    assert run is not None, "有运行文件时，检查通过的 Film 一定带着读好的运行文件"
    current = next(
        (
            node
            for node in run.root.children
            if node.tag == "use" and node.attrs["output"] == output
        ),
        None,
    )
    splice = _Splice()
    if url is None:
        if current is None:
            return None
        splice.replace(_tag_lines(source, current), "")
        return splice.apply(source)
    registered = [node for node in run.root.children if run.is_a(node, "Image")]
    same = next((node for node in registered if node.attrs["src"] == url), None)
    if same is None:
        name = _fresh_name(run, image)
        imports = [
            node
            for node in run.root.children
            if node.tag == "import" and node.attrs.get("from") == MEDIA_PACKAGE.ref
        ]
        if imports:
            prefix = f"{imports[0].attrs['as']}:" if "as" in imports[0].attrs else ""
            anchor = registered[-1] if registered else imports[0]
            line = f'<{prefix}Image id="{name}" src={_quoted(url)}/>'
        else:
            film_tag = run.root.children[0]
            anchor = film_tag
            line = (
                f'<import as="media" from="{MEDIA_PACKAGE.ref}"/>\n'
                f'{_indent(source, film_tag)}<media:Image id="{name}" src={_quoted(url)}/>'
            )
        splice.insert(*_after(source, anchor, line))
    else:
        name = same.attrs["id"]
    use = f'<use output="{output}" image={{{name}}}/>'
    if current is not None:
        if current.reference("image") == name:
            return None
        splice.replace(_span(current), use)
    else:
        splice.insert(*_before_close(source, run.root, use))
    return splice.apply(source)


def _fresh_name(run: Document, image: str) -> str:
    number = 1
    while f"{image}-{number}" in run.nodes:
        number += 1
    return f"{image}-{number}"


def _quoted(value: str) -> str:
    return f'"{_attribute(value, chr(34))}"'


def _span(node: Node) -> tuple[int, int]:
    """一个标签的开始标签在原文里的位置；对不上原文时不在页面上改。"""

    if node.opening is None:
        raise FilmEditRejected("这一处没法在页面上改，跟 AI 导演说")
    return node.opening


def _tag_lines(source: str, node: Node) -> tuple[int, int]:
    """一个自闭合标签在原文里的位置；它独占一行时连这一行一起算。"""

    start, stop = _span(node)
    line_start = source.rfind("\n", 0, start) + 1
    line_end = source.find("\n", stop)
    line_end = len(source) if line_end < 0 else line_end
    if not source[line_start:start].strip() and not source[stop:line_end].strip():
        return line_start, min(line_end + 1, len(source))
    return start, stop


def _indent(source: str, node: Node) -> str:
    opening = _span(node)[0]
    start = source.rfind("\n", 0, opening) + 1
    head = source[start:opening]
    return head if not head.strip() else ""


def _after(source: str, node: Node, text: str) -> tuple[int, str]:
    """在自闭合标签 ``node`` 那一行后面另起一行插入，缩进与它相同。"""

    newline = source.find("\n", _span(node)[1])
    position = len(source) if newline < 0 else newline + 1
    return position, f"{_indent(source, node)}{text}\n"


def _before_close(source: str, root: Node, text: str) -> tuple[int, str]:
    """插在根标签的结束标签那一行前面。"""

    assert root.inner is not None
    position = source.rfind("\n", 0, root.inner[1]) + 1
    indent = "  "
    for child in root.children:
        indent = _indent(source, child) or indent
    return position, f"{indent}{text}\n"


def _required(node: Node, name: str) -> str:
    reference = node.reference(name)
    assert reference is not None, f"{node.tag} 的 {name} 在读文件时已经查过"
    return reference


__all__ = ["FilmEditRejected", "choose_image", "edit_text", "film_groups", "image_prompt"]
