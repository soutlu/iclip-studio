"""检查工程文件和运行文件。

分四步，前一步有问题就不做后一步：按包声明读工程文件；内容规则（剧本、模板与填槽、生成节点和
参考图、镜头和台词、视频）；运行文件；按「写了的图全部已生成」算提示词字数和参考图张数。问题
带文件名和行号，改对一处就少一条。"""

from __future__ import annotations

import math

from iclip.capabilities.iclip_studio.film.document import Document, load
from iclip.capabilities.iclip_studio.film.film import FILM_PATH, RUN_PATH, Film
from iclip.capabilities.iclip_studio.film.kits import (
    KITS,
    PICTURE_KIT,
    VIDEO_ELEMENT_SLOTS,
    VIDEO_KIT,
    VIDEO_SHOTS_SLOT,
)
from iclip.capabilities.iclip_studio.film.markup import MarkupError, Node
from iclip.capabilities.iclip_studio.film.packages import (
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
from iclip.capabilities.iclip_studio.film.prompts import (
    LINE_REFERENCE,
    element_names,
    is_kit,
    references,
    render_picture,
    render_video,
    slot_values,
    video_shots,
)
from iclip.capabilities.iclip_studio.film.script import read_script
from iclip.common.shot_prompt import format_shot_prompt

_IMAGE_MARK = "@Image"


def check(project_source: str, run_source: str | None = None) -> Film | list[str]:
    """检查两个文件。工程文件读得成节点树时返回 ``Film``，问题在它的 ``errors`` 里；连 XML 都
    读不通时返回这一条问题。``run_source`` 为 None 表示没有运行文件。"""

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
    """按包声明读工程文件；XML 读不通时抛 ``MarkupError``。"""

    return load(
        source,
        label=FILM_PATH,
        using=PROJECT_MARKUP,
        root_tag=PROJECT_ROOT,
        packages=PROJECT_PACKAGES,
        kits=KITS,
    )


def load_run(source: str) -> Document:
    """按声明读运行文件，并查它自己就能判断的规则；XML 读不通时抛 ``MarkupError``。

    要对照工程文件的规则（``use`` 写的节点存不存在）不在这里。"""

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
    """只看工程文件自己：声明、内容规则和上限。给人保存这个文件时用，那里拿不到另一个文件。"""

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
    """只看运行文件自己。给人保存这个文件时用。"""

    try:
        return load_run(source).errors
    except MarkupError as exc:
        return [f"{RUN_PATH} 第 {exc.line} 行：{exc.message}"]


def _check_content(film: Film, source: str) -> None:
    """内容规则。剧本和填槽有问题时不往下查：镜头、参考图的规则都要先认得台词和槽。"""

    _check_script(film, source)
    _check_renders(film.project)
    _check_image_marks(film)
    if film.errors:
        return
    _check_generations(film.project)
    if film.errors:
        return
    _check_shots(film)
    _check_videos(film)


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
    """模板与填槽：槽名在模板里，一个槽先 Set 一次再 Append，必填的槽要填；槽里填 text:Value，
    多镜头视频模板的「镜头」槽 Set 一个 film:Shots；同一段文字在一个 Render 里只填一次。"""

    for render in project.find("Render"):
        reference = render.reference("template")
        assert reference is not None
        kit = project.template(reference)
        # opened 是 Set 过的槽；filled 是 Set 或 Append 过的槽，先 Append 后 Set 只报一处，
        # 也不再算成必填没填。
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


def _check_image_marks(film: Film) -> None:
    """拼进提示词的文字里不写 ``@Image``：图的编号由后端算。"""

    project = film.project
    message = f"文字里不写 {_IMAGE_MARK}，图的编号由后端算"
    for node in project.root.walk():
        written = any(project.is_a(node, name) for name in ("Value", "Reference", "Shot"))
        if written and _IMAGE_MARK in node.text:
            project.error(node, message)
    for line in film.lines.values():
        if _IMAGE_MARK in line.text:
            project.error_at(line.line, message)


def _check_generations(project: Document) -> None:
    """生成节点的 prompt 用哪种文字，下面挂的参考图写得对不对。"""

    for node in _generation_nodes(project):
        reference = node.reference("prompt")
        assert reference is not None
        prompt = project.nodes[reference]
        listed = references(project, node)
        if project.declared(node).output == ("image", IMAGE):
            if project.is_a(prompt, "Value"):
                if listed:
                    project.error(node, "prompt 是一段 text:Value 时原样发给模型，下面不能挂参考图")
                continue
            if not is_kit(project, prompt, PICTURE_KIT):
                project.error(
                    node,
                    f"生图的 prompt 要写画面模板（{PICTURE_KIT}）的 text:Render，或一段 text:Value",
                )
                continue
            filled = slot_values(project, prompt).values()
            where = "这个生成节点提示词的槽里"
        else:
            if not is_kit(project, prompt, VIDEO_KIT):
                project.error(
                    node, f"视频的 prompt 要写多镜头视频模板（{VIDEO_KIT}）的 text:Render"
                )
                continue
            values = slot_values(project, prompt)
            filled = [values[slot] for slot in VIDEO_ELEMENT_SLOTS]
            where = "这次视频提示词的人物、产品、场景槽里"
        allowed = {value.attrs["id"] for slot in filled for value in slot}
        seen: set[str] = set()
        for item in listed:
            image = item.reference("image")
            assert image is not None
            if image in seen:
                project.error(item, f"{{{image}}} 在这个生成节点下列了两次")
            seen.add(image)
            target = item.reference("for")
            if target is None:
                if not item.text:
                    project.error(item, "没写 for 的参考图要在正文里写一句用途")
                continue
            if item.has_text:
                project.error(item, "写了 for 的参考图不写正文")
            if not project.is_a(project.nodes[target], "Value"):
                project.error(item, f"for 要指一段 text:Value，{{{target}}} 不是")
            elif target not in allowed:
                project.error(item, f"{{{target}}} 要填在{where}")


def _check_shots(film: Film) -> None:
    """镜头的时间、正文里的台词和出场元素，以及剧本里每句台词正好引用一次、先后一致。"""

    project = film.project
    holders: dict[Node, list[Node]] = {}
    for render in project.find("Render"):
        if is_kit(project, render, VIDEO_KIT):
            for shots in slot_values(project, render)[VIDEO_SHOTS_SLOT]:
                holders.setdefault(shots, []).append(render)
    elements = sorted(element_names(project), key=len, reverse=True)
    said: list[str] = []
    for shots in project.find("Shots"):
        renders = holders.get(shots, [])
        if len(renders) != 1:
            project.error(
                shots,
                f"film:Shots {shots.attrs['id']} 要正好填进一个视频提示词的「{VIDEO_SHOTS_SLOT}」槽，"
                f"现在填进了 {len(renders)} 个",
            )
        cast = None
        if len(renders) == 1:
            filled = slot_values(project, renders[0])
            cast = {value.attrs["id"] for slot in VIDEO_ELEMENT_SLOTS for value in filled[slot]}
        cursor = 0.0
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
                elif name in said:
                    project.error(shot, f"台词 {name} 在前面的镜头里已经引用过")
                else:
                    said.append(name)
            if cast is None:
                continue
            # 长名字先查并从正文里拿掉：一个元素的名字包在另一个的名字里时，不把长的那个算成短的。
            for name in elements:
                if name in body:
                    if name not in cast:
                        project.error(
                            shot,
                            f"镜头正文里出现了「{name}」，它要填在这次视频提示词的人物、产品、场景槽里",
                        )
                    body = body.replace(name, " ")
    for name, line in film.lines.items():
        if name not in said:
            project.error_at(line.line, f"台词 {name} 没有被任何镜头引用")
    if not film.errors and said != list(film.lines):
        film.errors.append(f"{FILM_PATH}：镜头里台词的先后和剧本里的不一样")


def _check_videos(film: Film) -> None:
    """时长等于这组镜头的时长并在模型的范围内；机位图与视频同画幅；所有视频同画幅。"""

    project = film.project
    first: Node | None = None
    for video in _generation_nodes(project):
        if project.declared(video).output == ("image", IMAGE):
            continue
        shots = project.kids(video_shots(project, video), "Shot")
        seconds = math.ceil(float(shots[-1].attrs["end"]))
        _, shortest, longest = SEEDANCE_VARIANTS[video.attrs["model"]]
        duration = int(video.attrs["duration"])
        if duration != seconds:
            project.error(video, f"duration 写的是 {duration}，这组镜头是 {seconds} 秒")
        if not shortest <= duration <= longest:
            project.error(video, f"model {video.attrs['model']} 的时长是 {shortest}–{longest} 秒")
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


def _check_run(film: Film, source: str) -> None:
    """读运行文件，把登记和选用记到 ``film`` 上。"""

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
                if name not in image_nodes or path != "image":
                    run.error(
                        node,
                        f"output 要写 {FILM_PATH} 里生图节点的输出，如 "
                        f'"镜01机位图.image"；「{node.attrs["output"]}」不是',
                    )
                elif name in film.selected:
                    run.error(node, f"{name} 选用了两次")
                else:
                    chosen = node.reference("image")
                    assert chosen is not None
                    film.selected[name] = chosen
    film.errors += run.errors


def _check_limits(film: Film) -> None:
    """按「写了的图全部已生成」算：提示词字数和参考图张数不超过模型的上限。"""

    project = film.project
    for node in _generation_nodes(project):
        tag = project.declared(node)
        assert tag.generation is not None
        if tag.output == ("image", IMAGE):
            picture = render_picture(film, node, assume_generated=True)
            text, image_count = picture.text, len(picture.image_urls)
        else:
            group = render_video(film, node, assume_generated=True)
            text, image_count = format_shot_prompt(group), len(group.image_urls)
        limits = tag.generation
        if len(text) > limits.max_prompt_chars:
            project.error(node, f"拼出的提示词有 {len(text)} 字，超过 {limits.max_prompt_chars} 字")
        if image_count > limits.max_references:
            project.error(node, f"参考图有 {image_count} 张，超过 {limits.max_references} 张")


def _generation_nodes(project: Document) -> list[Node]:
    return [
        node
        for node in project.root.walk()
        if (tag := project.tags.get(node.tag)) is not None and tag.generation is not None
    ]


__all__ = ["check", "check_project_content", "check_run_content", "load_project", "load_run"]
