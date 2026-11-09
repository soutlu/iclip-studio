from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final

from iclip_video.film_view import (
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
from iclip_video.iclip_studio.film.checks import check, check_project_content
from iclip_video.iclip_studio.film.document import Document
from iclip_video.iclip_studio.film.film import FILM_PATH, RUN_PATH, Film
from iclip_video.iclip_studio.film.kits import (
    VIDEO_AUDIO_SLOT,
    VIDEO_CAPTURE_SLOT,
    VIDEO_SETTING_SLOTS,
)
from iclip_video.iclip_studio.film.markup import Node
from iclip_video.iclip_studio.film.packages import (
    IMAGE,
    MEDIA_PACKAGE,
    RUN_MARKUP,
    RUN_ROOT,
    SEEDANCE_VARIANTS,
    VIDEO_ASPECTS,
    VIDEO_MAX_REFERENCES,
)
from iclip_video.iclip_studio.film.prompts import (
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
from iclip_video.shot_prompt import format_shot_prompt
from iclip_video.shot_rules import MAX_PROMPT_CHARS

_LINE_SPLIT: Final = re.compile(r"\{[^{}]*\}")
_SRC: Final = re.compile(r"""(\ssrc\s*=\s*)(["'])(.*?)\2""", re.S)
_ASPECT: Final = re.compile(r"""(\saspect-ratio\s*=\s*)(["'])(.*?)\2""", re.S)
_UNWRITABLE: Final = ("<!--", "<![CDATA[")

_VIEW_CITE: Final = "参考@Image{}，"

_VIEW_LOCKED: Final = "机位图的引用随选用增删；请在镜头上取消选用"

_PHOTO_NAME: Final = "素材照片{}"


class FilmEditRejected(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class TextEdited:
    source: str
    inserted: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class _Slot:
    key: int | str


@dataclass(frozen=True, slots=True)
class _Typed:
    target: str
    node: Node
    runs: tuple[str | _Slot, ...]
    head: str


@dataclass(frozen=True, slots=True)
class _View:
    video: Node
    group: int

    shot: Node
    number: int


def film_groups(film: Film, source: str) -> tuple[FilmGroup, ...]:
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


MUSIC_VALUE: Final = "配乐"


def music_description(film: Film) -> str | None:

    project = film.project
    node = project.nodes.get(MUSIC_VALUE)
    if node is None or not project.is_a(node, "Value"):
        return None
    return node.text or None


def image_prompt(film: Film, image: str) -> PicturePrompt:
    return render_picture(film, film.project.nodes[image])


def missing_references(film: Film, node: str) -> tuple[str, ...]:
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


def edit_text(
    source: str, run_source: str | None, film: Film, edits: Sequence[FilmTextEdit]
) -> TextEdited:
    if not edits:
        raise FilmEditRejected("没有要改的字")
    if len({edit.target for edit in edits}) != len(edits):
        raise FilmEditRejected("同一段字一次只改一处")
    project = film.project
    splice = _Splice()
    expected: list[tuple[str, str]] = []
    said: list[tuple[str, str]] = []
    groups: dict[Node, list[_Typed]] = {}
    edited: set[Node] = set()
    for edit in edits:
        node = _resolve(project, edit.target)
        if node is None or not _editable(source, film, node):
            raise FilmEditRejected("要改的这段字找不到了，刷新后再改")
        edited.add(node)
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
        users = _users(project, node)
        video = users[0] if len(users) == 1 and project.is_a(users[0], "ReferenceVideo") else None
        if video is not None:
            groups.setdefault(video, []).append(_typed(film, video, edit, node, text))
            continue
        if len(users) > 1 and (edit.images or IMAGE_NUMBER.search(text)):
            raise FilmEditRejected(
                "这段文字用在几个地方，无法插入图片；带图号的文字只能用在一个节点里"
            )
        if edit.images:
            raise FilmEditRejected("只能在视频的文字里插入图片")
        assert node.inner is not None
        splice.replace(node.inner, _body(source[slice(*node.inner)], text))
        expected.append((edit.target, text))
    photos = _InsertedImages(film)
    for video, typed in groups.items():
        expected += _renumber_group(source, film, video, typed, edited, splice, photos)
    photos.write(source, splice)
    updated = splice.apply(source)
    rewritten = check(updated, run_source)
    problems = rewritten if isinstance(rewritten, list) else rewritten.errors
    if problems:
        if any(f"超过 {MAX_PROMPT_CHARS} 字" in problem for problem in problems):
            raise FilmEditRejected(f"改完以后描述超过 {MAX_PROMPT_CHARS} 字了，删短一些再保存")
        if any(f"超过 {VIDEO_MAX_REFERENCES} 张" in problem for problem in problems):
            raise FilmEditRejected(
                f"插入以后这一组的参考图超过 {VIDEO_MAX_REFERENCES} 张了，删掉几张再保存"
            )
        raise FilmEditRejected("这样改以后分镜有问题，没有保存；可以跟 AI 导演说想怎么改")
    assert not isinstance(rewritten, list)
    for target, text in expected:
        node = _resolve(rewritten.project, target)
        if node is None or node.text != text:
            raise RuntimeError(f"写回后 {target} 读出来和要写的不一样")
    for name, words in said:
        if rewritten.lines[name].text != words:
            raise RuntimeError(f"写回后台词 {name} 读出来和要写的不一样")
    return TextEdited(updated, photos.inserted)


def choose_image(
    film: Film, project_source: str, run_source: str | None, image: str, url: str | None
) -> list[tuple[str, str]]:
    project = film.project
    node = project.nodes.get(image)
    if node is None or project.declared(node).output not in (("", IMAGE), ("image", IMAGE)):
        raise FilmEditRejected("找不到这张图，刷新后再换")
    if url is not None and _repeats_a_reference(film, image, url):
        raise FilmEditRejected("同一组参考图里已经有这张图了，换一张")
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


def _repeats_a_reference(film: Film, image: str, url: str) -> bool:
    project = film.project
    view = _views(project, project.find("ReferenceVideo")).get(image)
    joining = None if view is None else view.video
    for node in project.root.walk():
        listed = listed_images(film, node)
        if node is not joining and all(item.image != image for item in listed):
            continue
        if any(item.image != image and item.url == url for item in listed):
            return True
    return False


def set_aspect_ratio(film: Film, project_source: str, aspect: str) -> str | None:
    if aspect not in VIDEO_ASPECTS:
        raise FilmEditRejected(f"不支持 {aspect} 画幅，可选 {'、'.join(VIDEO_ASPECTS)}")
    project = film.project
    videos = project.find("ReferenceVideo")
    views = [project.nodes[name] for name in _views(project, videos)]
    splice = _Splice()
    changed = False
    for node in (*videos, *views):
        current = node.attrs.get("aspect-ratio")
        if current is None or current == aspect:
            continue
        found = None if node.opening is None else _ASPECT.search(project_source, *node.opening)
        if found is None:
            raise FilmEditRejected("画幅无法在页面上修改，请让 AI 导演修改")
        splice.replace(found.span(3), aspect)
        changed = True
    if not changed:
        return None
    updated = splice.apply(project_source)
    if check_project_content(updated):
        raise RuntimeError(f"把画幅改成 {aspect} 后工程文件没有通过检查")
    return updated


def _views(project: Document, videos: list[Node]) -> dict[str, _View]:
    views: dict[str, _View] = {}
    for group, video in enumerate(videos, start=1):
        for number, shot in enumerate(project.kids(video_shots(project, video), "Shot"), start=1):
            view = shot.reference("view")
            if view is not None:
                views.setdefault(view.partition(".")[0], _View(video, group, shot, number))
    return views


def _label(image: str, group: int | None, views: dict[str, _View]) -> str:
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
                len(_users(project, value)) > 1,
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
    cite = _VIEW_CITE.format(number)
    lead = len(raw) - len(raw.lstrip())
    if text is not view.shot or not raw[lead:].startswith(cite):
        return raw
    return raw[:lead] + raw[lead + len(cite) :]


def _shifted(found: re.Match[str], number: int, shift: int) -> str:
    current = int(found.group(1))
    moves = current >= number if shift > 0 else current > number
    return f"@Image{current + shift}" if moves else found.group(0)


def _users(project: Document, text: Node) -> list[Node]:
    return [
        node
        for node in project.root.walk()
        if (tag := project.tags.get(node.tag)) is not None
        and tag.generation is not None
        and text in written_texts(project, node)
    ]


def _typed(film: Film, video: Node, edit: FilmTextEdit, node: Node, text: str) -> _Typed:
    old = listed_images(film, video)
    count = len(old)
    keys: list[int | str] = []
    for url in edit.images:
        same = next((index for index, item in enumerate(old) if item.url == url), None)
        keys.append(url if same is None else same)
    runs: list[str | _Slot] = []
    temps: set[int] = set()
    for index, piece in enumerate(IMAGE_NUMBER.split(text)):
        if index % 2 == 0:
            if piece:
                runs.append(piece)
            continue
        number = int(piece)
        if number <= count:
            runs.append(_Slot(number - 1))
        elif number <= count + len(keys):
            runs.append(_Slot(keys[number - count - 1]))
            temps.add(number)
        else:
            raise FilmEditRejected(f"字里的 @Image{number} 没有对应的图，刷新后再改")
    if len(temps) != len(keys):
        raise FilmEditRejected("插入的图和字对不上，刷新后再改")
    return _Typed(edit.target, node, tuple(runs), text)


def _renumber_group(
    source: str,
    film: Film,
    video: Node,
    typed: list[_Typed],
    edited: set[Node],
    splice: _Splice,
    photos: _InsertedImages,
) -> list[tuple[str, str]]:
    project = film.project
    listing = references(project, video)
    count = len(listing)
    shots = {
        view: shot
        for shot in project.kids(video_shots(project, video), "Shot")
        if (view := shot.reference("view")) is not None
    }
    views = {
        index: shots[reference]
        for index, item in enumerate(listing)
        if (reference := item.reference("image")) is not None and reference in shots
    }
    texts = written_texts(project, video)
    by_node = {item.node: item for item in typed}
    used: dict[int | str, int] = {}
    for text in texts:
        item = by_node.get(text)
        keys = (
            [run.key for run in item.runs if isinstance(run, _Slot)]
            if item is not None
            else [int(number) - 1 for number in IMAGE_NUMBER.findall(text.text)]
        )
        for key in keys:
            used[key] = used.get(key, 0) + 1
    for index, shot in views.items():
        item = by_node.get(shot)
        lead = item is None or item.head.startswith(_VIEW_CITE.format(index + 1))
        if not lead or used.get(index) != 1:
            raise FilmEditRejected(_VIEW_LOCKED)
    added = list(dict.fromkeys(key for key in used if isinstance(key, str)))
    first_view = min(views, default=count)
    kept = [index for index in range(count) if index in views or index in used]
    order: list[int | str] = [
        *(index for index in kept if index < first_view),
        *added,
        *(index for index in kept if index >= first_view),
    ]
    final = {key: position for position, key in enumerate(order, start=1)}

    for index in range(count):
        if index not in final:
            splice.replace(_tag_lines(source, listing[index]), "")
    if added:
        prefix = video.tag.rpartition(":")[0]
        tag = f"{prefix}:Reference" if prefix else "Reference"
        lines = [f"<{tag} image={{{photos.reference_for(url)}}}/>" for url in added]
        if first_view < count:
            anchor = listing[first_view]
            indent = _indent(source, anchor)
            position = source.rfind("\n", 0, _span(anchor)[0]) + 1
            splice.insert(position, "".join(f"{indent}{line}\n" for line in lines))
        elif listing:
            indent = _indent(source, listing[-1])
            splice.insert(*_after(source, listing[-1], f"\n{indent}".join(lines)))
        else:
            indent = _indent(source, video) + "  "
            splice.insert(*_before_end(source, video, f"\n{indent}".join(lines)))

    def numbered(key: int | str) -> str:
        return f"@Image{final[key]}"

    expected: list[tuple[str, str]] = []
    for text in texts:
        item = by_node.get(text)
        if item is not None:
            assert text.inner is not None, "改过的段在核对时已经确认能就地改"
            written = "".join(
                run if isinstance(run, str) else numbered(run.key) for run in item.runs
            )
            splice.replace(text.inner, _body(source[slice(*text.inner)], written))
            expected.append((item.target, written))
            continue
        if text in edited or text.inner is None:
            continue
        raw = source[slice(*text.inner)]
        renumbered = IMAGE_NUMBER.sub(lambda found: numbered(int(found.group(1)) - 1), raw)
        if renumbered == raw:
            continue
        if not _writable(source, text):
            raise FilmEditRejected("这一组的文字没法在页面上调整图号，跟 AI 导演说")
        splice.replace(text.inner, renumbered)
    return expected


class _InsertedImages:
    def __init__(self, film: Film) -> None:
        project = film.project
        self._project = project
        views = {
            view.partition(".")[0]
            for shot in project.find("Shot")
            if (view := shot.reference("view")) is not None
        }
        self._generated: dict[str, str] = {}
        for node in film.image_nodes():
            name = node.attrs["id"]
            url = film.image_url(f"{name}.image")
            if url is not None:
                self._generated.setdefault(url, name)
        self._views = views
        self._named = {
            node.attrs["src"]: node.attrs["id"]
            for node in project.find("Image", MEDIA_PACKAGE)
            if node.parent is project.root
        }
        self._new: list[tuple[str, str]] = []
        self._inserted: list[str] = []

    @property
    def inserted(self) -> tuple[str, ...]:
        return tuple(self._inserted)

    def reference_for(self, url: str) -> str:
        if url not in self._inserted:
            self._inserted.append(url)
        generated = self._generated.get(url)
        if generated is not None:
            if generated in self._views:
                raise FilmEditRejected("机位图只随选用进参考图列表，无法插入；请在镜头上选用")
            return f"{generated}.image"
        return self._photo(url)

    def _photo(self, url: str) -> str:
        name = self._named.get(url)
        if name is not None:
            return name
        taken = {*self._project.nodes, *self._project.kits, *self._named.values()}
        number = 1
        while _PHOTO_NAME.format(number) in taken:
            number += 1
        name = _PHOTO_NAME.format(number)
        self._named[url] = name
        self._new.append((name, url))
        return name

    def write(self, source: str, splice: _Splice) -> None:
        if not self._new:
            return
        project = self._project
        root = project.root.children
        videos = project.find("ReferenceVideo")
        before = videos[0].line if videos else None
        photos = [
            node
            for node in project.find("Image", MEDIA_PACKAGE)
            if node.parent is project.root and (before is None or node.line < before)
        ]
        imports = [node for node in root if node.tag == "import"]
        media = next(
            (node for node in imports if node.attrs.get("from") == MEDIA_PACKAGE.ref), None
        )
        prefix = media.attrs.get("as", "media") if media is not None else "media"
        lines = [f'<{prefix}:Image id="{name}" src={_quoted(url)}/>' for name, url in self._new]
        if media is None:
            lines.insert(0, f'<import as="media" from="{MEDIA_PACKAGE.ref}"/>')
        anchor = photos[-1] if photos else imports[-1]
        indent = _indent(source, anchor)
        splice.insert(*_after(source, anchor, f"\n{indent}".join(lines)))


def _resolve(project: Document, target: str) -> Node | None:
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
    if not _writable(source, node):
        return False
    if not film.project.is_a(node, "Shot"):
        return True
    return all(film.lines[line].span is not None for line in LINE_REFERENCE.findall(node.text))


def _new_text(edit: FilmTextEdit) -> str:
    if edit.text is None:
        raise FilmEditRejected("要给改好的文字")
    text = _clean(edit.text).strip()
    if not text:
        raise FilmEditRejected("这段字不能是空的")
    return text


class _Splice:
    def __init__(self) -> None:
        self._edits: list[tuple[int, int, int, str]] = []

    def replace(self, span: tuple[int, int], text: str) -> None:
        self._edits.append((span[0], 1, span[1], text))

    def insert(self, position: int, text: str) -> None:
        self._edits.append((position, 0, position, text))

    def apply(self, source: str) -> str:
        ordered = sorted(
            enumerate(self._edits), key=lambda item: (item[1][0], item[1][1], item[0]), reverse=True
        )
        for _, (start, _, stop, text) in ordered:
            source = source[:start] + text + source[stop:]
        return source


def _shot_text(shot: Node, edit: FilmTextEdit) -> tuple[str, list[tuple[str, str]]]:
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
    if node.opening is None:
        raise FilmEditRejected("这一处没法在页面上改，跟 AI 导演说")
    return node.opening


def _tag_lines(source: str, node: Node) -> tuple[int, int]:
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
    newline = source.find("\n", _span(node)[1])
    position = len(source) if newline < 0 else newline + 1
    return position, f"{_indent(source, node)}{text}\n"


def _before_close(source: str, root: Node, text: str) -> tuple[int, str]:
    assert root.inner is not None
    position = source.rfind("\n", 0, root.inner[1]) + 1
    indent = "  "
    for child in root.children:
        indent = _indent(source, child) or indent
    return position, f"{indent}{text}\n"


def _before_end(source: str, node: Node, text: str) -> tuple[int, str]:
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
    "TextEdited",
    "choose_image",
    "edit_text",
    "film_groups",
    "image_prompt",
    "missing_references",
    "set_aspect_ratio",
]
