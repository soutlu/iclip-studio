from __future__ import annotations

import math
import re
from typing import Final

from iclip_video.iclip_studio.film.document import Document, load
from iclip_video.iclip_studio.film.film import FILM_PATH, RUN_PATH, Film
from iclip_video.iclip_studio.film.kits import (
    KITS,
    PICTURE_KIT,
    VIDEO_KIT,
    VIDEO_SHOTS_SLOT,
)
from iclip_video.iclip_studio.film.markup import MarkupError, Node
from iclip_video.iclip_studio.film.packages import (
    IMAGE,
    PROJECT_MARKUP,
    PROJECT_PACKAGES,
    PROJECT_ROOT,
    RUN_MARKUP,
    RUN_PACKAGES,
    RUN_ROOT,
    RUN_TAGS,
    SCRIPT_TAG,
    SEEDANCE_VARIANTS,
)
from iclip_video.iclip_studio.film.prompts import (
    IMAGE_NUMBER,
    LINE_REFERENCE,
    is_kit,
    references,
    render_picture,
    render_video,
    video_shots,
    written_texts,
)
from iclip_video.iclip_studio.film.script import read_script
from iclip_video.shot_prompt import format_shot_prompt

_ANY_MARK: Final = re.compile(r"@image", re.IGNORECASE)

_WRITTEN_MARK: Final = re.compile(r"@image\s*\d*", re.IGNORECASE)


def check(project_source: str, run_source: str | None = None) -> Film | list[str]:
    try:
        project = load_project(project_source)
    except MarkupError as exc:
        return [f"{FILM_PATH} 第 {exc.line} 行：{exc.message}"]
    film = Film(project, errors=project.errors)
    if film.errors:
        return film
    _check_content(film, project_source)
    if run_source is not None and not film.errors:
        _check_run(film, run_source)
    if not film.errors:
        _check_limits(film)
    return film


def load_project(source: str) -> Document:
    return load(
        source,
        label=FILM_PATH,
        using=PROJECT_MARKUP,
        root_tag=PROJECT_ROOT,
        packages=PROJECT_PACKAGES,
        kits=KITS,
    )


def load_run(source: str) -> Document:
    run = load(
        source,
        label=RUN_PATH,
        using=RUN_MARKUP,
        root_tag=RUN_ROOT,
        packages=RUN_PACKAGES,
        builtins=RUN_TAGS,
    )
    if run.root.attrs != {"version": "1"}:
        run.error(run.root, f'根标签要写 <{RUN_ROOT} version="1">')
    children = run.root.children
    films = [node for node in children if node.tag == "film"]
    if (
        len(films) != 1
        or children[0] is not films[0]
        or films[0].attrs.get("source") != f"./{FILM_PATH}"
    ):
        run.error(
            films[0] if films else run.root,
            f'第一个标签要写 <film source="./{FILM_PATH}"/>，只写一次',
        )
    return run


def check_project_content(source: str) -> list[str]:
    try:
        project = load_project(source)
    except MarkupError as exc:
        return [f"{FILM_PATH} 第 {exc.line} 行：{exc.message}"]
    film = Film(project, errors=project.errors)
    if not film.errors:
        _check_content(film, source)
    if not film.errors:
        _check_limits(film)
    return film.errors


def check_run_content(source: str) -> list[str]:
    try:
        return load_run(source).errors
    except MarkupError as exc:
        return [f"{RUN_PATH} 第 {exc.line} 行：{exc.message}"]


def _check_content(film: Film, source: str) -> None:
    _check_script(film, source)
    _check_renders(film.project)
    _check_marks(film)
    if film.errors:
        return
    _check_generations(film.project)
    if film.errors:
        return
    _check_shots(film)
    _check_videos(film)
    if film.errors:
        return
    _check_numbers(film.project)


def _check_script(film: Film, source: str) -> None:
    project = film.project
    scripts = project.find(SCRIPT_TAG)
    for extra in scripts[1:]:
        project.error(extra, "一个文件最多写一份剧本")
    if not scripts or scripts[0].inner is None:
        return
    lines, problems = read_script(source, *scripts[0].inner)
    for line, message in problems:
        project.error_at(line, message)
    film.lines = {line.name: line for line in lines}


def _check_renders(project: Document) -> None:
    for render in project.find("Render"):
        reference = render.reference("template")
        assert reference is not None
        kit = project.template(reference)
        opened: set[str] = set()
        filled: set[str] = set()
        used: set[str] = set()
        for child in render.children:
            is_set = project.is_a(child, "Set")
            if not (is_set or project.is_a(child, "Append")):
                continue
            slot = child.attrs["name"]
            target = child.reference("text")
            assert target is not None
            if kit.slot(slot) is None:
                names = "、".join(item.name for item in kit.slots)
                project.error(child, f"模板 {kit.name} 没有「{slot}」这个槽，可以写 {names}")
                continue
            if is_set:
                if slot in opened:
                    project.error(child, f"「{slot}」槽只 Set 一次，后面的用 Append")
                opened.add(slot)
            elif slot not in opened:
                project.error(child, f"「{slot}」槽要先 Set 再 Append")
            filled.add(slot)
            value = project.nodes[target]
            if kit.name == VIDEO_KIT and slot == VIDEO_SHOTS_SLOT:
                if not is_set:
                    project.error(child, f"「{slot}」槽只 Set 一个 film:Shots，不 Append")
                elif not project.is_a(value, "Shots"):
                    project.error(child, f"「{slot}」槽要 Set 一个 film:Shots，{{{target}}} 不是")
            elif not project.is_a(value, "Value"):
                project.error(child, f"「{slot}」槽里填 text:Value，{{{target}}} 不是")
            if target in used:
                project.error(child, f"{{{target}}} 在这个 Render 里填了两次")
            used.add(target)
        for item in kit.slots:
            if item.required and item.name not in filled:
                project.error(render, f"模板 {kit.name} 的「{item.name}」槽必填，没有填")


def _check_marks(film: Film) -> None:
    project = film.project
    for node in project.root.walk():
        if not (project.is_a(node, "Value") or project.is_a(node, "Shot")):
            continue
        text = node.text
        wrong = [
            _written_mark(text, found.start())
            for found in _ANY_MARK.finditer(text)
            if IMAGE_NUMBER.match(text, found.start()) is None
        ]
        if wrong:
            project.error(
                node,
                f"图号 {'、'.join(dict.fromkeys(wrong))} 写错了；"
                "要写成 @Image 后面直接跟从 1 起的数字，如 @Image1",
            )
    for line in film.lines.values():
        if _ANY_MARK.search(line.text):
            project.error_at(line.line, f"台词 {line.name} 里不能写 @Image")


def _written_mark(text: str, start: int) -> str:
    found = _WRITTEN_MARK.match(text, start)
    assert found is not None
    return found.group(0)


def _check_generations(project: Document) -> None:
    for node in _generation_nodes(project):
        reference = node.reference("prompt")
        assert reference is not None
        kit = PICTURE_KIT if _is_picture(project, node) else VIDEO_KIT
        if not is_kit(project, project.nodes[reference], kit):
            what = "生图" if kit == PICTURE_KIT else "视频"
            project.error(node, f"{what}的 prompt 要写 {kit} 模板的 text:Render")
        seen: dict[str, int] = {}
        for position, item in enumerate(references(project, node), start=1):
            image = item.reference("image")
            assert image is not None
            first = seen.setdefault(image, position)
            if first != position:
                project.error(
                    item,
                    f"第 {position} 张参考图 {{{image}}} 和第 {first} 张重复了，"
                    f"去掉第 {position} 张，并修正其它受影响的图片编号",
                )


def _check_shots(film: Film) -> None:
    project = film.project
    scripts = project.find(SCRIPT_TAG)
    script = scripts[0] if scripts else None
    holders: dict[Node, list[Node]] = {}
    for video in _videos(project):
        holders.setdefault(video_shots(project, video), []).append(video)
    views: dict[str, tuple[Node, int]] = {}
    said: list[str] = []
    for shots in project.find("Shots"):
        videos = holders.get(shots, [])
        if len(videos) != 1:
            project.error(
                shots,
                f"film:Shots {shots.attrs['id']} 要正好用在一个视频里，现在用在了 {len(videos)} 个",
            )
        cursor = 0.0
        quotes_script = False
        for order, shot in enumerate(project.kids(shots, "Shot")):
            start, end = float(shot.attrs["start"]), float(shot.attrs["end"])
            if start != cursor and order == 0:
                project.error(shot, f"每组镜头的第一个从 0.0 开始，写的是 {start:.1f}")
            elif start != cursor:
                project.error(shot, f"镜头从 {start:.1f} 开始，没接上上一个的结束 {cursor:.1f}")
            if end <= start:
                project.error(shot, "结束要晚于开始")
            cursor = end
            body = shot.text
            if not LINE_REFERENCE.sub("", body).strip():
                project.error(shot, "镜头正文是空的")
            for name in LINE_REFERENCE.findall(body):
                if name not in film.lines:
                    project.error(shot, f"花括号里要写剧本里的段名，「{name[:20]}」不是")
                    continue
                quotes_script = True
                if name in said:
                    project.error(shot, f"台词 {name} 在前面的镜头里已经引用过")
                else:
                    said.append(name)
            view = shot.reference("view")
            if view is not None:
                if view in views:
                    owner, number = views[view]
                    project.error(
                        shot,
                        f"{{{view}}} 已经是 {owner.attrs['id']} 第 {number} 镜的机位图；"
                        "一张机位图只给一个镜头用",
                    )
                else:
                    views[view] = (shots, order + 1)
        if quotes_script and script is not None and script.line > shots.line:
            project.error(shots, f"剧本 {script.attrs['id']} 要写在引用它台词的 film:Shots 之前")
    for name, line in film.lines.items():
        if name not in said:
            project.error_at(line.line, f"台词 {name} 没有被任何镜头引用")
    if not film.errors and said != list(film.lines):
        assert script is not None
        project.error(script, f"剧本里台词的先后要和镜头里一致，镜头里依次是 {'、'.join(said)}")


def _check_videos(film: Film) -> None:
    project = film.project
    first: Node | None = None
    for video in _videos(project):
        shots = project.kids(video_shots(project, video), "Shot")
        seconds = math.ceil(float(shots[-1].attrs["end"]))
        model = video.attrs["model"]
        _, shortest, longest = SEEDANCE_VARIANTS[model]
        duration = int(video.attrs["duration"])
        if duration != seconds:
            project.error(video, f"duration 写的是 {duration}，这组镜头是 {seconds} 秒")
        if not shortest <= seconds <= longest:
            project.error(
                video,
                f"{video.attrs['id']} 有 {seconds} 秒，超出 {model} 的 {shortest}–{longest} 秒，"
                "按段落重新分组",
            )
        aspect = video.attrs["aspect-ratio"]
        if first is None:
            first = video
        elif first.attrs["aspect-ratio"] != aspect:
            project.error(
                video,
                f"画幅是 {aspect}，前面的视频 {first.attrs['id']} 是 "
                f"{first.attrs['aspect-ratio']}；一个文件里所有视频的画幅要相同",
            )
        for shot in shots:
            reference = shot.reference("view")
            if reference is None:
                continue
            view = project.nodes[reference.partition(".")[0]]
            view_aspect = view.attrs.get("aspect-ratio")
            if view_aspect is not None and view_aspect != aspect:
                project.error(
                    shot, f"机位图 {view.attrs['id']} 的画幅是 {view_aspect}，视频是 {aspect}"
                )


def _check_numbers(project: Document) -> None:
    nodes = _generation_nodes(project)
    texts = {node: written_texts(project, node) for node in nodes}
    for node in nodes:
        count = len(references(project, node))
        used = {int(number) for text in texts[node] for number in IMAGE_NUMBER.findall(text.text)}
        expected = set(range(1, count + 1))
        if used == expected:
            continue
        name = node.attrs["id"]
        marks = "、".join(f"@Image{number}" for number in sorted(used - expected))
        if count == 0:
            project.error(node, f"{name} 没有挂参考图，提示词里不能写图号，写了 {marks}")
            continue
        problems = [f"{name} 挂了 {count} 张参考图，提示词里的图号要正好是 @Image1–@Image{count}"]
        absent = sorted(expected - used)
        if absent:
            problems.append(f"没有写 {'、'.join(f'@Image{number}' for number in absent)}")
        if marks:
            problems.append(f"{marks} 没有对应的参考图")
        project.error(node, "；".join(problems))
    for value in project.find("Value"):
        if not IMAGE_NUMBER.search(value.text):
            continue
        users = [node.attrs["id"] for node in nodes if value in texts[node]]
        if len(users) != 1:
            where = f"：{'、'.join(users)}" if users else ""
            project.error(
                value,
                f"{value.attrs['id']} 里写了图号，要正好用在一个生成节点里，"
                f"现在用在了 {len(users)} 个{where}",
            )
    _check_listed_views(project, texts)


def _check_listed_views(project: Document, texts: dict[Node, list[Node]]) -> None:
    views: dict[str, tuple[Node, Node, int]] = {}
    for shots in project.find("Shots"):
        for number, shot in enumerate(project.kids(shots, "Shot"), start=1):
            view = shot.reference("view")
            if view is not None:
                views.setdefault(view, (shots, shot, number))
    for video in _videos(project):
        name = video.attrs["id"]
        own = video_shots(project, video)
        for position, item in enumerate(references(project, video), start=1):
            image = item.reference("image")
            if image not in views:
                continue
            holder, shot, number = views[image]
            if holder is not own:
                project.error(
                    item,
                    f"{{{image}}} 是 {holder.attrs['id']} 第 {number} 镜的机位图，"
                    f"那一镜不在视频 {name} 里",
                )
                continue
            cite = f"参考@Image{position}，"
            if not shot.text.startswith(cite):
                project.error(
                    shot,
                    f"{{{image}}} 在视频 {name} 的参考图里排第 {position}，"
                    f"这一镜正文要以「{cite}」开头",
                )
            written = sum(
                int(found) == position
                for text in texts[video]
                for found in IMAGE_NUMBER.findall(text.text)
            )
            if written != 1:
                project.error(
                    video,
                    f"@Image{position} 是第 {number} 镜的机位图，只在那一镜开头写一次，"
                    f"现在写了 {written} 次",
                )


def _check_run(film: Film, source: str) -> None:
    try:
        run = load_run(source)
    except MarkupError as exc:
        film.errors.append(f"{RUN_PATH} 第 {exc.line} 行：{exc.message}")
        return
    if not run.errors:
        film.run = run
        image_nodes = {node.attrs["id"] for node in film.image_nodes()}
        for node in run.root.children:
            if run.is_a(node, "Image"):
                film.registered[node.attrs["id"]] = node.attrs["src"]
            elif node.tag == "use":
                name, _, path = node.attrs["output"].partition(".")
                if name not in image_nodes:
                    run.error(node, f"{FILM_PATH} 里没有叫 {name} 的生图节点")
                elif path != "image":
                    run.error(node, f"output 要写 {name}.image")
                elif name in film.selected:
                    run.error(node, f"{name} 选用了两次")
                else:
                    chosen = node.reference("image")
                    assert chosen is not None
                    film.selected[name] = chosen
    film.errors += run.errors


def _check_limits(film: Film) -> None:
    project = film.project
    for node in _generation_nodes(project):
        tag = project.declared(node)
        assert tag.generation is not None
        if _is_picture(project, node):
            text = render_picture(film, node).text
            trim = "描述"
        else:
            text = format_shot_prompt(render_video(film, node))
            trim = "设定"
        count = len(references(project, node))
        limits = tag.generation
        if len(text) > limits.max_prompt_chars:
            project.error(
                node,
                f"{node.attrs['id']} 的提示词有 {len(text)} 字，"
                f"超过 {limits.max_prompt_chars} 字，请精简它的{trim}",
            )
        if count > limits.max_references:
            most = limits.max_references
            project.error(
                node,
                f"{node.attrs['id']} 的参考图有 {count} 张，超过 {most} 张，"
                f"减到 {most} 张以内，并修正其它受影响的图片编号",
            )
        earlier: dict[str, tuple[int, str]] = {}
        for position, item in enumerate(references(project, node), start=1):
            image = item.reference("image")
            url = film.image_url(image)
            if image is None or url is None:
                continue
            first_position, first = earlier.setdefault(url, (position, image))
            if first_position != position:
                project.error(
                    item,
                    f"第 {position} 张参考图 {{{image}}} 和第 {first_position} 张 {{{first}}} 重复了，"
                    f"去掉第 {position} 张，并修正其它受影响的图片编号",
                )


def _generation_nodes(project: Document) -> list[Node]:
    return [
        node
        for node in project.root.walk()
        if (tag := project.tags.get(node.tag)) is not None and tag.generation is not None
    ]


def _videos(project: Document) -> list[Node]:
    return [node for node in _generation_nodes(project) if not _is_picture(project, node)]


def _is_picture(project: Document, node: Node) -> bool:
    return project.declared(node).output == ("image", IMAGE)


__all__ = ["check", "check_project_content", "check_run_content", "load_project", "load_run"]
