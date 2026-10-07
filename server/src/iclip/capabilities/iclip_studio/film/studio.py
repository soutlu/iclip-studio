"""制作页：把检查通过的工程按视频请求排成镜头组，改一段字，给一张图换地址。

改字和换图只替换原文里对应的那几段，文件其余部分一个字不动；写之前按人保存文件时的同一套规则
检查，有问题就不写，说明是给人看的一句话。

定位用 ``target``：``shot:<Storyboard 名>:<第几个镜头>``、``element:<元素名>``、
``value:<文字名>``、``voice:<说话人>``、``block:<Storyboard 名>``；镜头里的台词用
``line:<台词名>`` 指明是原有的哪一句。它们只在同一版文件里有效，改字时带着文件版本号一起传回。"""

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
    body_sentence,
    for_video,
    storyboard_images,
)
from iclip.common.film_view import (
    FilmFrame,
    FilmGroup,
    FilmLine,
    FilmLineEdit,
    FilmSetting,
    FilmShot,
    FilmTextEdit,
)

_SENTENCE_MARKS: Final = "。！？"
_LINE_SPLIT: Final = re.compile(r"\{[^{}]*\}")
_SRC: Final = re.compile(r"""(\ssrc\s*=\s*)(["'])(.*?)\2""", re.S)
_ROLE: Final = re.compile(r"""(\srole\s*=\s*)(["'])(.*?)\2""", re.S)
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
            if use.image not in frames:
                frames[use.image] = FilmFrame(
                    node=use.image,
                    label=_label(use.image, index, elements, views),
                    kind="generated" if _generated(project, use.image) else "photo",
                    url=use.url,
                    number=use.number,
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
                speakers=tuple(_speakers(project, storyboard)),
            )
        )
    return tuple(groups)


def edit_text(source: str, film: Film, edits: Sequence[FilmTextEdit]) -> str:
    """把几段字写回工程文件，返回新的原文。``film`` 是 ``source`` 检查通过后的样子。

    镜头的改动带着这一镜改完的全部台词：少了的从台词表里删掉，新加的按镜头先后排进台词表，
    说话人只能是这组里能说话的人，台词的先后不能调。用户打的花括号换成全角，免得当成台词；
    不能写 ``@Image``，图的编号由后端算。"""

    if not edits:
        raise FilmEditRejected("没有要改的字")
    if len({edit.target for edit in edits}) != len(edits):
        raise FilmEditRejected("同一段字一次只改一处")
    project = film.project
    splice = _Splice()
    script = _ScriptChanges(project)
    expected: list[tuple[str, str]] = []
    for edit in edits:
        node = _resolve(project, edit.target)
        if node is None or not _editable(source, project, node):
            raise FilmEditRejected("要改的这段字找不到了，刷新后再改")
        if project.is_a(node, "Shot"):
            text = script.shot(source, node, edit)
        else:
            text = _new_text(project, node, edit)
        assert node.inner is not None
        splice.replace(node.inner, _body(source[slice(*node.inner)], text))
        expected.append((edit.target, text))
    script.write(source, splice)
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
    script.verify(rewritten)
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


def _speakers(project: Document, storyboard: Node) -> list[str]:
    """这组里能说话的人：不是出场元素的声音（如旁白），加上这组里 Cast 了的出场元素。"""

    elements = {element.attrs["id"] for element in project.find("Element")}
    cast = {cast.reference("element") for cast in project.kids(storyboard, "Cast")}
    return [
        voice.attrs["role"]
        for voice in project.find("Voice")
        if voice.attrs["role"] not in elements or voice.attrs["role"] in cast
    ]


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


class _ScriptChanges:
    """镜头里台词的增删改，连带台词表一起改。"""

    def __init__(self, project: Document) -> None:
        self._project = project
        self._shots: dict[Node, list[str]] = {}
        """改过的镜头 → 改完后按先后引用的台词名。"""

        self._added: dict[str, tuple[str, str]] = {}
        """新加的台词名 → (说话人, 台词)。"""

        self._changed: dict[str, tuple[str, str]] = {}
        self._removed: set[str] = set()

    def shot(self, source: str, shot: Node, edit: FilmTextEdit) -> str:
        """核对一个镜头的改动，返回它的新正文（未转义）。"""

        project = self._project
        lines = edit.lines
        if edit.parts is None or lines is None or len(edit.parts) != len(lines) + 1:
            raise FilmEditRejected("镜头的文字和台词对不上，刷新后再改")
        before = LINE_REFERENCE.findall(shot.text)
        assert shot.parent is not None
        speakers = _speakers(project, shot.parent)
        names: list[str] = []
        for line in lines:
            role, text = line.role, _clean(line.text).strip()
            if role not in speakers:
                raise FilmEditRejected(f"「{role}」不能在这组镜头里说话，说话人从列表里选")
            if not text:
                raise FilmEditRejected("台词不能是空的")
            names.append(self._line(before, names, line, role, text))
        kept = [name for name in names if name not in self._added]
        if kept != [name for name in before if name in kept]:
            raise FilmEditRejected("台词的先后不能调，要调跟 AI 导演说")
        self._removed.update(name for name in before if name not in kept)
        self._shots[shot] = names
        parts = [_clean(part) for part in edit.parts]
        body = parts[0] + "".join(
            "{" + name + "}" + part for name, part in zip(names, parts[1:], strict=True)
        )
        if not LINE_REFERENCE.sub("", body).strip():
            raise FilmEditRejected("镜头的文字不能是空的")
        return body.strip()

    def _line(
        self, before: list[str], taken: list[str], line: FilmLineEdit, role: str, text: str
    ) -> str:
        if line.target is None:
            name = self._fresh()
            self._added[name] = (role, text)
            return name
        kind, _, name = line.target.partition(":")
        if kind != "line" or name not in before or name in taken:
            raise FilmEditRejected("这句台词找不到了，刷新后再改")
        said = self._project.nodes[name]
        if (said.attrs["role"], said.text) != (role, text):
            self._changed[name] = (role, text)
        return name

    def _fresh(self) -> str:
        number = 1
        while f"台词{number}" in self._project.nodes or f"台词{number}" in self._added:
            number += 1
        return f"台词{number}"

    def write(self, source: str, splice: _Splice) -> None:
        """把台词表要改的几处加进 ``splice``。"""

        project = self._project
        for name, (role, text) in self._changed.items():
            said = project.nodes[name]
            if role != said.attrs["role"]:
                assert said.opening is not None
                found = _ROLE.search(source, *said.opening)
                assert found is not None, "台词读文件时已查过有 role"
                splice.replace(found.span(3), _attribute(role, found.group(2)))
            if text != said.text:
                assert said.inner is not None
                splice.replace(said.inner, _body(source[slice(*said.inner)], text))
        written = project.find("Line")
        survivors = [line for line in written if line.attrs["id"] not in self._removed]
        if not survivors and not self._added:
            for script in project.find("Script"):
                splice.replace(_whole_lines(source, script), "")
            return
        for line in written:
            if line.attrs["id"] in self._removed:
                splice.replace(_whole_lines(source, line), "")
        self._insert(source, splice, survivors)

    def _insert(self, source: str, splice: _Splice, survivors: list[Node]) -> None:
        """新加的台词按改完后所有镜头引用的先后，接在前一句留下来的台词后面。"""

        if not self._added:
            return
        project = self._project
        runs: dict[str | None, list[str]] = {}
        anchor: str | None = None
        for storyboard in project.find("Storyboard"):
            for shot in project.kids(storyboard, "Shot"):
                for name in self._shots.get(shot, LINE_REFERENCE.findall(shot.text)):
                    if name in self._added:
                        runs.setdefault(anchor, []).append(name)
                    else:
                        anchor = name
        written = project.find("Line")
        indent = _indent(source, written[0]) if written else ""
        tag = self._tag("Line")
        for after, names in runs.items():
            text = "".join(
                f'{indent}<{tag} id="{name}" role={_quoted(self._added[name][0])}>'
                f"{_escape(self._added[name][1])}</{tag}>\n"
                for name in names
            )
            if after is not None:
                splice.insert(_line_end(source, project.nodes[after]), text)
            elif survivors:
                splice.insert(_line_start(source, survivors[0]), text)
            elif written:
                # 原有的台词全删了：新的接在台词表里第一句原来所在的那一行。
                splice.insert(_line_start(source, written[0]), text)
            else:
                self._new_script(source, splice, text)

    def _tag(self, name: str) -> str:
        """台词表与台词的写法，前缀与文件里的声音相同：它们同属导演包。说了话就一定有声音。"""

        voice = self._project.find("Voice")[0]
        return voice.tag[: -len("Voice")] + name

    def _new_script(self, source: str, splice: _Splice, lines: str) -> None:
        """还没有台词表：接在最后一个声音后面另起一个。"""

        voice = self._project.find("Voice")[-1]
        indent = _indent(source, voice)
        tag = self._tag("Script")
        body = "".join(f"{indent}  {line}\n" for line in lines.splitlines())
        splice.insert(_line_end(source, voice), f"\n{indent}<{tag}>\n{body}{indent}</{tag}>\n")

    def verify(self, rewritten: Document) -> None:
        """写回后台词表读出来要和这次改的一样。"""

        for name, (role, text) in {**self._changed, **self._added}.items():
            said = rewritten.nodes.get(name)
            if said is None or (said.attrs["role"], said.text) != (role, text):
                raise RuntimeError(f"写回后台词 {name} 读出来和要写的不一样")
        if any(name in rewritten.nodes for name in self._removed):
            raise RuntimeError("写回后删掉的台词还在")


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
    if url is None:
        if current is None:
            return None
        start, stop = _whole_lines(source, current)
        return source[:start] + source[stop:]
    registered = [node for node in run.root.children if run.is_a(node, "Image")]
    same = next((node for node in registered if node.attrs["src"] == url), None)
    edits: list[tuple[int, int, str]] = []
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
        edits.append(_after(source, anchor, line))
    else:
        name = same.attrs["id"]
    use = f'<use output="{output}" image={{{name}}}/>'
    if current is not None:
        if current.reference("image") == name:
            return None
        edits.append((*_span(current), use))
    else:
        edits.append(_before_close(source, run.root, use))
    # 从后往前改，前面的位置不受影响；插在同一处的几段按列出的先后排。
    updated = source
    for _, (start, stop, text) in sorted(
        enumerate(edits), key=lambda e: (e[1][0], e[0]), reverse=True
    ):
        updated = updated[:start] + text + updated[stop:]
    return updated


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


def _line_start(source: str, node: Node) -> int:
    return source.rfind("\n", 0, _span(node)[0]) + 1


def _line_end(source: str, node: Node) -> int:
    """``node`` 整个标签所在那一行之后的位置，即下一行的开头。"""

    end = _span(node)[1] if node.inner is None else source.find(">", node.inner[1]) + 1
    newline = source.find("\n", end)
    return len(source) if newline < 0 else newline + 1


def _whole_lines(source: str, node: Node) -> tuple[int, int]:
    """整个标签在原文里的位置；它独占几行时连这几行一起算。"""

    start = _span(node)[0]
    stop = _span(node)[1] if node.inner is None else source.find(">", node.inner[1]) + 1
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


def _after(source: str, node: Node, text: str) -> tuple[int, int, str]:
    """在 ``node`` 那一行后面另起一行插入，缩进与它相同。"""

    position = _line_end(source, node)
    return position, position, f"{_indent(source, node)}{text}\n"


def _before_close(source: str, root: Node, text: str) -> tuple[int, int, str]:
    """插在根标签的结束标签那一行前面。"""

    assert root.inner is not None
    position = source.rfind("\n", 0, root.inner[1]) + 1
    indent = "  "
    for child in root.children:
        indent = _indent(source, child) or indent
    return position, position, f"{indent}{text}\n"


def _required(node: Node, name: str) -> str:
    reference = node.reference(name)
    assert reference is not None, f"{node.tag} 的 {name} 在读文件时已经查过"
    return reference


__all__ = ["FilmEditRejected", "choose_image", "edit_text", "film_groups"]
