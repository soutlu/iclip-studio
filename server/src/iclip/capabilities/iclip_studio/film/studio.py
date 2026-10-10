"""制作页：把检查通过的工程按视频请求排成镜头组，改一段字，给一张图换地址或选用。

改字和换图只替换原文里对应的那几段，文件其余部分一个字不动；写之前按人保存文件时的同一套规则
检查，有问题就不写，说明是给人看的一句话。

定位用 ``target``：``value:<名字>`` 是一段 ``text:Value`` 的正文，``shot:<Shots 名>:<第几镜>``
是一个镜头的正文；镜头里的台词用 ``line:<段名>`` 对上是剧本里的哪一句。它们只在同一版文件里
有效，改字时带着文件版本号一起传回。"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final

from iclip.capabilities.iclip_studio.film.checks import check, check_project_content
from iclip.capabilities.iclip_studio.film.document import Document
from iclip.capabilities.iclip_studio.film.film import FILM_PATH, RUN_PATH, Film
from iclip.capabilities.iclip_studio.film.kits import (
    VIDEO_AUDIO_SLOT,
    VIDEO_CAPTURE_SLOT,
    VIDEO_SETTING_SLOTS,
)
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
    IMAGE_NUMBER,
    LINE_REFERENCE,
    PicturePrompt,
    listed_images,
    references,
    render_picture,
    render_video,
    slot_values,
    video_shots,
    written_texts,
)
from iclip.common.film_view import (
    FilmFrame,
    FilmGroup,
    FilmLine,
    FilmPromptImage,
    FilmPromptRun,
    FilmPromptText,
    FilmSetting,
    FilmShot,
    FilmTextEdit,
    SettingKind,
)
from iclip.common.shot_prompt import format_shot_prompt

_LINE_SPLIT: Final = re.compile(r"\{[^{}]*\}")
_SRC: Final = re.compile(r"""(\ssrc\s*=\s*)(["'])(.*?)\2""", re.S)
_UNWRITABLE: Final = ("<!--", "<![CDATA[")
"""正文里有注释或 CDATA 时只换那一段会把它们弄丢，这样的正文不让在页面上改。"""

_VIEW_CITE: Final = "参考@Image{}，"
"""机位图选用时写在那一镜正文开头的一句，N 是它在这组视频参考图列表里的位置。"""


class FilmEditRejected(ValueError):
    """这次改动没有写进文件；消息是给人看的一句话。"""


@dataclass(frozen=True, slots=True)
class _View:
    """一张机位图：用它的那一镜，以及这一镜所在的视频。"""

    video: Node
    group: int
    """视频是第几组，从 1 起。"""

    shot: Node
    number: int
    """这一镜在这组里排第几，从 1 起。"""


def film_groups(film: Film, source: str) -> tuple[FilmGroup, ...]:
    """每个视频节点一组，顺序与文件里相同。``film`` 是工程文件 ``source`` 检查通过后的样子。

    ``frames`` 先是这组视频的参考图列表，编号就是位置；再按镜头先后接上这组里还没进列表的机位图，
    没有编号，好让人在页面上生成、选用它们。"""

    project = film.project
    videos = project.find("ReferenceVideo")
    views = _views(project, videos)
    groups: list[FilmGroup] = []
    for index, video in enumerate(videos, start=1):
        listed = listed_images(film, video)
        names = {item.image for item in listed}
        unlisted = sorted(
            (view.number, image)
            for image, view in views.items()
            if view.group == index and image not in names
        )
        frames = tuple(
            _frame(film, item.image, item.url, number, index, views)
            for number, item in enumerate(listed, start=1)
        ) + tuple(
            _frame(film, image, film.image_url(f"{image}.image"), None, index, views)
            for _, image in unlisted
        )
        groups.append(
            FilmGroup(
                index=index,
                video=video.attrs["id"],
                model=SEEDANCE_VARIANTS[video.attrs["model"]][0],
                seconds=int(video.attrs["duration"]),
                aspect_ratio=video.attrs["aspect-ratio"],
                frames=frames,
                settings=_settings(project, video, source),
                shots=_shots(film, video, source),
                prompt=format_shot_prompt(render_video(film, video)),
            )
        )
    return tuple(groups)


def image_prompt(film: Film, image: str) -> PicturePrompt:
    """按描述生成 ``image`` 这个生图节点时发给模型的描述与参考图。"""

    return render_picture(film, film.project.nodes[image])


def missing_references(film: Film, node: str) -> tuple[str, ...]:
    """生成节点 ``node`` 的参考图列表里现在没有图的那几张，按列表先后，用给人看的称呼；不为空时
    不能生成。机位图按 ``node`` 所在的那一组称呼：视频是它自己这组，生图节点是用它当机位图的那组。"""

    project = film.project
    videos = project.find("ReferenceVideo")
    views = _views(project, videos)
    target = project.nodes[node]
    if target in videos:
        group: int | None = videos.index(target) + 1
    else:
        owner = views.get(node)
        group = None if owner is None else owner.group
    return tuple(
        _label(item.image, group, views) for item in listed_images(film, target) if item.url is None
    )


def edit_text(source: str, film: Film, edits: Sequence[FilmTextEdit]) -> str:
    """把几段字写回工程文件，返回新的原文。``film`` 是 ``source`` 检查通过后的样子。

    镜头的改动带着这一镜的每句台词，台词只改字：不能删、不能加、不能调先后，说话人不变。台词的字
    改在剧本里那一段说话人的后面。用户打的花括号换成全角，免得当成台词。改完的文件按保存检查把关，
    图号对不上参考图列表时不写。"""

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
        if node is None or not _editable(source, film, node):
            raise FilmEditRejected("要改的这段字找不到了，刷新后再改")
        if project.is_a(node, "Shot"):
            text, lines = _shot_text(node, edit)
            for name, words in lines:
                line = film.lines[name]
                if words != line.text:
                    assert line.span is not None
                    splice.replace(line.span, _escape(words))
                    said.append((name, words))
        else:
            text = _new_text(edit)
        assert node.inner is not None
        splice.replace(node.inner, _body(source[slice(*node.inner)], text))
        expected.append((edit.target, text))
    updated = splice.apply(source)
    rewritten = check(updated)
    problems = rewritten if isinstance(rewritten, list) else rewritten.errors
    if problems:
        too_long = any(f"超过 {PROMPT_MAX_CHARS} 字" in problem for problem in problems)
        if too_long:
            raise FilmEditRejected(f"改完以后描述超过 {PROMPT_MAX_CHARS} 字了，删短一些再保存")
        raise FilmEditRejected("这样改以后分镜有问题，没有保存；可以跟 AI 导演说想怎么改")
    assert not isinstance(rewritten, list)
    for target, text in expected:
        node = _resolve(rewritten.project, target)
        if node is None or node.text != text:
            raise RuntimeError(f"写回后 {target} 读出来和要写的不一样")
    for name, words in said:
        if rewritten.lines[name].text != words:
            raise RuntimeError(f"写回后台词 {name} 读出来和要写的不一样")
    return updated


def choose_image(
    film: Film, project_source: str, run_source: str | None, image: str, url: str | None
) -> list[tuple[str, str]]:
    """给一个图片节点换图，返回按先后要写的 (文件, 新的原文)；本来就是这样时返回空列表。

    生图节点在运行文件里登记这张图并选用它，``url`` 为 None 是删掉它的选用，这张图就没有图了；
    用户给的图直接改工程文件里的地址，不能没有图。``url`` 是不是这段对话的图由调用方先认。

    生图节点是某一镜的机位图（那一镜的 ``view`` 指着它）时，工程文件跟着改：选用时它不在那组视频的
    参考图列表里，就插进列表、在那一镜正文开头写「参考@ImageN，」、这组文字里不小于 N 的图号各加 1；
    取消选用时它在列表里，就删掉这两处、比 N 大的图号各减 1；换成另一版只改运行文件。

    两个文件都要写时，先写的那一个写完而后一个没写成，留下的是「列表里有、但没有选用」：两份文件
    都照样通过检查，出片时这组被缺图拦住，再选用或取消选用一次就补齐。所以选用先写工程文件，
    取消选用先写运行文件。"""

    project = film.project
    node = project.nodes.get(image)
    if node is None or project.declared(node).output not in (("", IMAGE), ("image", IMAGE)):
        raise FilmEditRejected("找不到这张图，刷新后再换")
    if _generated(project, image):
        run_updated = _select_in_run(film, run_source, image, url)
        project_updated = _place_view(film, project_source, image, listed=url is not None)
        if run_updated is None and project_updated is None:
            return []
        new_project = project_updated or project_source
        new_run = run_source if run_updated is None else run_updated
        written = check(new_project, new_run)
        if isinstance(written, list) or written.errors:
            raise RuntimeError(f"给 {image} 换图后两个文件没有通过检查")
        changes = [(FILM_PATH, project_updated), (RUN_PATH, run_updated)]
        if url is None:
            changes.reverse()
        return [(path, content) for path, content in changes if content is not None]
    if url is None:
        raise FilmEditRejected("这张图是你给的，只能换成另一张，不能清空")
    if node.attrs.get("src") == url:
        return []
    found = None if node.opening is None else _SRC.search(project_source, *node.opening)
    if node.opening is None or found is None:
        raise FilmEditRejected("这张图的地址没法在页面上换，跟 AI 导演说")
    start, stop = found.span(3)
    updated = project_source[:start] + _attribute(url, found.group(2)) + project_source[stop:]
    if check_project_content(updated):
        raise RuntimeError(f"给 {image} 换图后工程文件没有通过检查")
    return [(FILM_PATH, updated)]


def _views(project: Document, videos: list[Node]) -> dict[str, _View]:
    """图片节点 → 用它当机位图的那一镜。保存检查保证一张机位图只给一个镜头用。"""

    views: dict[str, _View] = {}
    for group, video in enumerate(videos, start=1):
        for number, shot in enumerate(project.kids(video_shots(project, video), "Shot"), start=1):
            view = shot.reference("view")
            if view is not None:
                views.setdefault(view.partition(".")[0], _View(video, group, shot, number))
    return views


def _label(image: str, group: int | None, views: dict[str, _View]) -> str:
    """给人看的称呼：机位图叫「镜头 N」，别组的叫「第 M 组镜头 N」；其余的叫图片节点的名字。"""

    view = views.get(image)
    if view is None:
        return image
    if view.group == group:
        return f"镜头 {view.number}"
    return f"第 {view.group} 组镜头 {view.number}"


def _frame(
    film: Film,
    image: str,
    url: str | None,
    number: int | None,
    group: int,
    views: dict[str, _View],
) -> FilmFrame:
    project = film.project
    generated = _generated(project, image)
    prompt: tuple[FilmPromptRun, ...] | None = None
    missing: tuple[str, ...] = ()
    if generated:
        picture = image_prompt(film, image)
        prompt = tuple(
            FilmPromptText(run)
            if isinstance(run, str)
            else FilmPromptImage(run.image, _label(run.image, group, views), run.url, run.number)
            for run in picture.runs
        )
        missing = tuple(_label(name, group, views) for name in picture.missing)
    return FilmFrame(
        node=image,
        label=_label(image, group, views),
        kind="generated" if generated else "photo",
        url=url,
        number=number,
        prompt=prompt,
        aspect_ratio=project.nodes[image].attrs["aspect-ratio"] if generated else None,
        missing=missing,
    )


def _generated(project: Document, image: str) -> bool:
    return project.declared(project.nodes[image]).generation is not None


def _settings(project: Document, video: Node, source: str) -> tuple[FilmSetting, ...]:
    """全局设定，与拼给视频的先后相同：拍法、人物产品场景、声音；称呼是模板里这个槽的段名。"""

    prompt = project.nodes[_required(video, "prompt")]
    kit = project.template(_required(prompt, "template"))
    filled = slot_values(project, prompt)
    settings: list[FilmSetting] = []
    for name in VIDEO_SETTING_SLOTS:
        slot = kit.slot(name)
        assert slot is not None, f"{name} 在读模板时已经查过"
        kind: SettingKind = (
            "shooting"
            if name == VIDEO_CAPTURE_SLOT
            else "voice"
            if name == VIDEO_AUDIO_SLOT
            else "element"
        )
        settings += [
            FilmSetting(
                kind,
                f"value:{value.attrs['id']}" if _writable(source, value) else None,
                slot.title,
                value.text,
                (),
            )
            for value in filled[name]
        ]
    return tuple(settings)


def _shots(film: Film, video: Node, source: str) -> tuple[FilmShot, ...]:
    project = film.project
    holder = video_shots(project, video)
    name = holder.attrs["id"]
    shots: list[FilmShot] = []
    for number, shot in enumerate(project.kids(holder, "Shot"), start=1):
        text = shot.text
        lines = [
            FilmLine(f"line:{line}", film.lines[line].speaker, film.lines[line].text)
            for line in LINE_REFERENCE.findall(text)
        ]
        view = shot.reference("view")
        shots.append(
            FilmShot(
                target=f"shot:{name}:{number}" if _editable(source, film, shot) else None,
                start=float(shot.attrs["start"]),
                end=float(shot.attrs["end"]),
                parts=tuple(_LINE_SPLIT.split(text)),
                lines=tuple(lines),
                view=None if view is None else view.partition(".")[0],
            )
        )
    return tuple(shots)


def _place_view(film: Film, source: str, image: str, *, listed: bool) -> str | None:
    """``image`` 是某一镜的机位图时，让它在那组视频的参考图列表里（``listed``）或不在，连同那一镜
    开头的引用和这组的图号；返回新的原文，不是机位图或本来就是这样时返回 None。"""

    project = film.project
    view = _views(project, project.find("ReferenceVideo")).get(image)
    if view is None:
        return None
    target = f"{image}.image"
    listing = references(project, view.video)
    present = next((item for item in listing if item.reference("image") == target), None)
    if listed == (present is not None):
        return None
    splice = _Splice()
    if present is None:
        later = _later_views(project, view, listing)
        number = (listing.index(later) if later is not None else len(listing)) + 1
        prefix = view.video.tag.rpartition(":")[0]
        line = f"<{prefix + ':' if prefix else ''}Reference image={{{target}}}/>"
        if later is not None:
            start = _span(later)[0]
            splice.insert(source.rfind("\n", 0, start) + 1, f"{_indent(source, later)}{line}\n")
        elif listing:
            splice.insert(*_after(source, listing[-1], line))
        else:
            splice.insert(*_before_end(source, view.video, line))
        shift, cite = 1, _VIEW_CITE.format(number)
    else:
        number = listing.index(present) + 1
        splice.replace(_tag_lines(source, present), "")
        shift, cite = -1, ""
    for text in written_texts(project, view.video):
        raw = source[slice(*text.inner)] if text.inner is not None else ""
        kept = raw if shift > 0 else _drop_cite(raw, number, text, view)
        renumbered = IMAGE_NUMBER.sub(lambda found: _shifted(found, number, shift), kept)
        if text is view.shot and cite:
            lead = len(renumbered) - len(renumbered.lstrip())
            renumbered = renumbered[:lead] + cite + renumbered[lead:]
        if renumbered == raw:
            continue
        if not _writable(source, text):
            raise FilmEditRejected("这一组的文字没法在页面上调整图号，跟 AI 导演说")
        assert text.inner is not None
        splice.replace(text.inner, renumbered)
    return splice.apply(source)


def _later_views(project: Document, view: _View, listing: list[Node]) -> Node | None:
    """列表里第一张排在 ``view`` 那一镜之后的机位图：新的机位图插在它前面。"""

    order = {
        shot.reference("view"): number
        for number, shot in enumerate(project.kids(video_shots(project, view.video), "Shot"), 1)
        if shot.reference("view") is not None
    }
    return next(
        (
            item
            for item in listing
            if (position := order.get(item.reference("image"))) is not None
            and position > view.number
        ),
        None,
    )


def _drop_cite(raw: str, number: int, text: Node, view: _View) -> str:
    """取消选用时去掉那一镜开头的「参考@ImageN，」；其余原样。"""

    cite = _VIEW_CITE.format(number)
    lead = len(raw) - len(raw.lstrip())
    if text is not view.shot or not raw[lead:].startswith(cite):
        return raw
    return raw[:lead] + raw[lead + len(cite) :]


def _shifted(found: re.Match[str], number: int, shift: int) -> str:
    """插入时不小于 N 的图号加 1；删除时比 N 大的减 1。"""

    current = int(found.group(1))
    moves = current >= number if shift > 0 else current > number
    return f"@Image{current + shift}" if moves else found.group(0)


def _resolve(project: Document, target: str) -> Node | None:
    """``target`` 指的那个有正文的标签；对不上返回 None。"""

    kind, _, rest = target.partition(":")
    if kind == "shot":
        name, _, number = rest.rpartition(":")
        holder = project.nodes.get(name)
        if holder is None or not project.is_a(holder, "Shots"):
            return None
        shots = project.kids(holder, "Shot")
        index = int(number) - 1 if number.isdigit() else -1
        return shots[index] if 0 <= index < len(shots) else None
    node = project.nodes.get(rest)
    if kind != "value" or node is None or not project.is_a(node, "Value"):
        return None
    return node


def _writable(source: str, node: Node) -> bool:
    if node.opening is None or node.inner is None or node.children:
        return False
    raw = source[node.inner[0] : node.inner[1]]
    return not any(mark in raw for mark in _UNWRITABLE)


def _editable(source: str, film: Film, node: Node) -> bool:
    """页面上能不能改这段：镜头连同它的每句台词都要能就地改。"""

    if not _writable(source, node):
        return False
    if not film.project.is_a(node, "Shot"):
        return True
    return all(film.lines[line].span is not None for line in LINE_REFERENCE.findall(node.text))


def _new_text(edit: FilmTextEdit) -> str:
    """镜头以外这次要写进这个标签的正文（未转义）。"""

    if edit.text is None:
        raise FilmEditRejected("要给改好的文字")
    text = _clean(edit.text).strip()
    if not text:
        raise FilmEditRejected("这段字不能是空的")
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
    """核对一个镜头的改动，返回 (镜头的新正文, 每句台词的段名与新的字)，都未转义。台词的字
    照剧本的读法去掉首尾空白、连续空白合成一个空格。"""

    names = LINE_REFERENCE.findall(shot.text)
    lines = edit.lines
    if edit.parts is None or lines is None or len(edit.parts) != len(lines) + 1:
        raise FilmEditRejected("镜头的文字和台词对不上，刷新后再改")
    if [line.target for line in lines] != [f"line:{name}" for name in names]:
        raise FilmEditRejected("台词只能改字，不能删、不能加，也不能调先后；要动台词跟 AI 导演说")
    said: list[tuple[str, str]] = []
    for name, line in zip(names, lines, strict=True):
        words = " ".join(_clean(line.text).split())
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
    return text.replace("{", "｛").replace("}", "｝")


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


def _before_end(source: str, node: Node, text: str) -> tuple[int, str]:
    """插在 ``node`` 的结束标签那一行前面，比它多缩进一级；``node`` 自闭合或结束标签不独占一行时
    不在页面上改。"""

    if node.inner is None:
        raise FilmEditRejected("这一组的参考图列表没法在页面上改，跟 AI 导演说")
    position = source.rfind("\n", 0, node.inner[1]) + 1
    if source[position : node.inner[1]].strip() or position <= node.inner[0]:
        raise FilmEditRejected("这一组的参考图列表没法在页面上改，跟 AI 导演说")
    return position, f"{_indent(source, node)}  {text}\n"


def _required(node: Node, name: str) -> str:
    reference = node.reference(name)
    assert reference is not None, f"{node.tag} 的 {name} 在读文件时已经查过"
    return reference


__all__ = [
    "FilmEditRejected",
    "choose_image",
    "edit_text",
    "film_groups",
    "image_prompt",
    "missing_references",
]
