"""检查工程文件和运行文件。

分四步，前一步有问题就不做后一步：按包声明读工程文件；内容规则；运行文件；按「写了的图全部
已生成」算提示词字数、参考图张数和时长。问题带文件名和行号，改对一处就少一条。"""

from __future__ import annotations

from iclip.capabilities.iclip_studio.film.document import Document, load
from iclip.capabilities.iclip_studio.film.film import FILM_PATH, RUN_PATH, Film
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
    SEEDANCE_VARIANTS,
)
from iclip.capabilities.iclip_studio.film.prompts import (
    BODY_PHRASE,
    LINE_REFERENCE,
    PICTURE_BLOCKS,
    STORYBOARD_BLOCK,
    render_picture,
    render_storyboard,
)
from iclip.common.shot_prompt import format_shot_prompt

_ASSUMED = "（假设）"


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
    _check_content(film)
    if run_source is not None and not film.errors:
        _check_run(film, run_source)
    if not film.errors:
        _check_limits(film)
        _hint_split_images(film)
    return film


def load_project(source: str) -> Document:
    """按包声明读工程文件；XML 读不通时抛 ``MarkupError``。"""

    return load(
        source,
        label=FILM_PATH,
        using=PROJECT_MARKUP,
        root_tag=PROJECT_ROOT,
        packages=PROJECT_PACKAGES,
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
    """只看工程文件自己：声明和内容规则。给人保存这个文件时用，那里拿不到另一个文件。"""

    try:
        project = load_project(source)
    except MarkupError as exc:
        return [f"{FILM_PATH} 第 {exc.line} 行：{exc.message}"]
    film = Film(project, errors=project.errors)
    if not film.errors:
        _check_content(film)
    if not film.errors:
        _check_limits(film)
    return film.errors


def check_run_content(source: str) -> list[str]:
    """只看运行文件自己。给人保存这个文件时用。"""

    try:
        return load_run(source).errors
    except MarkupError as exc:
        return [f"{RUN_PATH} 第 {exc.line} 行：{exc.message}"]


def _check_content(film: Film) -> None:
    project = film.project
    voices: dict[str, Node] = {}
    for voice in project.find("Voice"):
        role = voice.attrs["role"]
        if role in voices:
            project.error(voice, f"{role} 写了两个 Voice")
        voices[role] = voice
    lines = project.find("Line")
    for line in lines:
        if line.attrs["role"] not in voices:
            project.error(line, f"说话人 {line.attrs['role']} 没有同名的 Voice")
        if not line.text:
            project.error(line, "台词是空的")
    elements = {node.attrs["id"]: node for node in project.find("Element")}
    for element in elements.values():
        if element.text.endswith(_ASSUMED):
            project.error(element, f"辨识特征末尾的「{_ASSUMED}」不抄进来")
        if element.attrs["type"] == "人物" and BODY_PHRASE not in element.text:
            project.error(element, f"人物的身材要写成一句英文，后半句是 {BODY_PHRASE}")
    for holder in project.find("Picture") + project.find("Storyboard"):
        cast = [node.reference("element") for node in project.kids(holder, "Cast")]
        if len(set(cast)) != len(cast):
            project.error(holder, "同一个出场元素只 Cast 一次")
        for reference in project.kids(holder, "Reference"):
            if not reference.text:
                project.error(reference, "Reference 的正文要写这张图用来做什么")
    for picture in project.find("Picture"):
        _check_picture(film, picture, elements)
    line_ids = [line.attrs["id"] for line in lines]
    said: list[str] = []
    for storyboard in project.find("Storyboard"):
        said += _check_storyboard(film, storyboard, elements, line_ids)
    if not film.errors and said != line_ids:
        missing = [name for name in line_ids if name not in said]
        repeated = sorted({name for name in said if said.count(name) > 1})
        if missing:
            film.errors.append(f"{FILM_PATH}：台词 {'、'.join(missing)} 没有被任何镜头引用")
        elif repeated:
            film.errors.append(f"{FILM_PATH}：台词 {'、'.join(repeated)} 被引用了不止一次")
        else:
            film.errors.append(f"{FILM_PATH}：镜头里台词的先后和 Script 里的顺序不一致")


def _check_picture(film: Film, picture: Node, elements: dict[str, Node]) -> None:
    project = film.project
    blocks = [block.attrs["name"] for block in project.kids(picture, "Block")]
    for name in dict.fromkeys(blocks):
        if name == "主体":
            project.error(picture, "「主体」从 Cast 的出场元素取，不用写")
        elif name not in PICTURE_BLOCKS:
            project.error(picture, f"Picture 没有「{name}」这一块")
        elif blocks.count(name) > 1:
            project.error(picture, f"「{name}」一块只写一次")
    for required in ("拍摄", "取景"):
        if required not in blocks:
            project.error(picture, f"缺「{required}」一块")
    has_scene = any(
        elements[name].attrs["type"] == "场景"
        for cast in project.kids(picture, "Cast")
        if (name := cast.reference("element")) in elements
    )
    if "环境" not in blocks and not has_scene:
        project.error(picture, "没有 Cast 场景时，要写「环境」一块")


def _check_storyboard(
    film: Film, storyboard: Node, elements: dict[str, Node], line_ids: list[str]
) -> list[str]:
    """查一个 Storyboard，返回它的镜头按先后引用的台词名。"""

    project = film.project
    cast = [node.reference("element") for node in project.kids(storyboard, "Cast")]
    if [block.attrs["name"] for block in project.kids(storyboard, "Block")] != [STORYBOARD_BLOCK]:
        project.error(storyboard, f"Storyboard 只有「{STORYBOARD_BLOCK}」一块")
    said: list[str] = []
    cursor = 0.0
    for order, shot in enumerate(project.kids(storyboard, "Shot")):
        start, end = float(shot.attrs["start"]), float(shot.attrs["end"])
        if start != cursor and order == 0:
            project.error(shot, f"每个 Storyboard 的第一个镜头从 0.0 开始，写的是 {start:.1f}")
        elif start != cursor:
            project.error(shot, f"镜头从 {start:.1f} 开始，没接上上一个的结束 {cursor:.1f}")
        if end <= start:
            project.error(shot, "结束要晚于开始")
        cursor = end
        body = shot.text
        if not LINE_REFERENCE.sub("", body).strip():
            project.error(shot, "镜头正文是空的")
        if "@Image" in body:
            project.error(shot, "镜头正文里不写 @Image，编号由后端算")
        for name in LINE_REFERENCE.findall(body):
            if name not in line_ids:
                project.error(shot, f"花括号里要写台词的名字，「{name[:20]}」不是台词的名字")
                continue
            said.append(name)
            role = project.nodes[name].attrs["role"]
            if role in elements and role not in cast:
                project.error(shot, f"说话的 {role} 没有 Cast")
        # 长名字先查并从正文里拿掉：一个元素的名字包在另一个的名字里时，不把长的那个算成短的。
        for name in sorted(elements, key=len, reverse=True):
            if name in body:
                if name not in cast:
                    project.error(shot, f"镜头正文里出现了「{name}」，但没有 Cast")
                body = body.replace(name, " ")
    return said


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
    project = film.project
    aspects: set[str] = set()
    for node in project.root.walk():
        tag = project.tags.get(node.tag)
        if tag is None or tag.generation is None:
            continue
        reference = node.reference("prompt")
        assert reference is not None
        prompt = project.nodes[reference]
        is_image = tag.output == ("image", IMAGE)
        wanted = "Picture" if is_image else "Storyboard"
        if not project.is_a(prompt, wanted):
            project.error(node, f"{node.tag} 的 prompt 要写 {wanted} 的名字")
            continue
        if is_image:
            picture = render_picture(film, prompt, assume_generated=True)
            text, image_count = picture.text, len(picture.image_urls)
        else:
            group = render_storyboard(film, prompt, assume_generated=True)
            text, image_count = format_shot_prompt(group), len(group.image_urls)
            aspects.add(node.attrs["aspect-ratio"])
            _check_video(film, node, prompt, group.seconds)
        limits = tag.generation
        if len(text) > limits.max_prompt_chars:
            project.error(node, f"拼出的提示词有 {len(text)} 字，超过 {limits.max_prompt_chars} 字")
        if image_count > limits.max_references:
            project.error(node, f"参考图有 {image_count} 张，超过 {limits.max_references} 张")
    if len(aspects) > 1:
        film.errors.append(f"{FILM_PATH}：一个文件里所有视频的画幅要相同")


def _check_video(film: Film, video: Node, storyboard: Node, seconds: int) -> None:
    project = film.project
    _, shortest, longest = SEEDANCE_VARIANTS[video.attrs["model"]]
    duration = int(video.attrs["duration"])
    if duration != seconds:
        project.error(video, f"duration 写的是 {duration}，这组镜头是 {seconds} 秒")
    if not shortest <= duration <= longest:
        project.error(video, f"model {video.attrs['model']} 的时长是 {shortest}–{longest} 秒")
    aspect = video.attrs["aspect-ratio"]
    for shot in project.kids(storyboard, "Shot"):
        reference = shot.reference("view")
        if reference is None:
            continue
        view = project.nodes[reference.partition(".")[0]]
        view_aspect = view.attrs.get("aspect-ratio")
        if view_aspect is not None and view_aspect != aspect:
            project.error(
                shot, f"机位图 {view.attrs['id']} 的画幅是 {view_aspect}，视频是 {aspect}"
            )


def _hint_split_images(film: Film) -> None:
    """同一个出场元素在不同的提示词里挂了不同的图：不算错，提醒一下。"""

    project = film.project
    bound: dict[str, set[str]] = {}
    for holder in project.find("Picture") + project.find("Storyboard"):
        for cast in project.kids(holder, "Cast"):
            element, image = cast.reference("element"), cast.reference("image")
            if element is not None and image is not None:
                bound.setdefault(element, set()).add(image)
    for name, images in bound.items():
        if len(images) > 1:
            film.hints.append(f"{name} 在不同的提示词里挂了不同的图：{'、'.join(sorted(images))}")


__all__ = ["check", "check_project_content", "check_run_content", "load_project", "load_run"]
