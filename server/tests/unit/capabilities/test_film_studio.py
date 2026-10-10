"""验证制作页的工程读法：标签在原文里的位置、按视频请求分的组、改字写回与换图写回。"""

from __future__ import annotations

import difflib

import pytest

from iclip.capabilities.iclip_studio.film.checks import check
from iclip.capabilities.iclip_studio.film.film import FILM_PATH, RUN_PATH, Film
from iclip.capabilities.iclip_studio.film.markup import parse
from iclip.capabilities.iclip_studio.film.packages import PROMPT_MAX_CHARS
from iclip.capabilities.iclip_studio.film.prompts import render_picture, render_video
from iclip.capabilities.iclip_studio.film.studio import (
    FilmEditRejected,
    choose_image,
    edit_text,
    film_groups,
    missing_references,
)
from iclip.common.film_view import (
    FilmGroup,
    FilmLineEdit,
    FilmPromptImage,
    FilmPromptText,
    FilmTextEdit,
)
from iclip.common.shot_prompt import OUTPUT_CONSTRAINT, SHOTS_HEADING, format_seconds
from tests.helpers.film import (
    EXPECTED,
    FILM,
    FILM_NO_VIEW04,
    GENERATED,
    PHOTOS,
    RUN,
    RUN_NO_VIEW04,
    SHOE_FRONT,
    STATES,
    VIEW04,
    project_of,
    run_of,
)

HOOK = FilmLineEdit("line:hook", "这一双，走起来很轻。")
REPLY = FilmLineEdit("line:reply", "鞋底是软的吗？")

USE_VIEW01 = '  <use output="view01.image" image={view01-v1}/>\n'


def checked(project: str = FILM, run: str | None = RUN) -> Film:
    film = check(project, run)
    assert isinstance(film, Film) and not film.errors, film
    return film


def groups(project: str = FILM, run: str | None = RUN) -> tuple[FilmGroup, ...]:
    return film_groups(checked(project, run), project)


def first(project: str = FILM, run: str | None = RUN) -> FilmGroup:
    return groups(project, run)[0]


def written(edits: list[FilmTextEdit], project: str = FILM, run: str | None = RUN) -> str:
    """把 ``edits`` 写进 ``project``，返回改好的工程文件。"""

    return edit_text(project, run, checked(project, run), edits).source


def shot(number: int, parts: tuple[str, ...], *lines: FilmLineEdit) -> FilmTextEdit:
    return FilmTextEdit(f"shot:video01Shots:{number}", parts=parts, lines=lines)


def parts_of(number: int, project: str = FILM) -> tuple[str, ...]:
    return first(project).shots[number - 1].parts


def changed_lines(before: str, after: str) -> list[str]:
    return [
        line
        for line in difflib.unified_diff(before.splitlines(), after.splitlines(), lineterm="", n=0)
        if line[:1] in "+-" and not line.startswith(("+++", "---"))
    ]


def test_each_tag_knows_where_it_and_its_text_sit_in_the_source() -> None:
    source = (
        '<?icml using="x"?>\n<icml>\n'
        '  <text:Value id="短发女生" ref={名字}>东亚女性 &amp; 鞋</text:Value>\n'
        "  <a:Set a={b}/>\n"
        '  <script id="台词">\n    <lighter><短发女生>Light &amp; <b>fast</lighter>\n  </script>\n'
        "</icml>"
    )
    _, root = parse(source, using="x")
    value, setter, script = root.children

    assert value.opening is not None and setter.opening is not None
    assert source[slice(*value.opening)] == '<text:Value id="短发女生" ref={名字}>'
    assert value.inner is not None and source[slice(*value.inner)] == "东亚女性 &amp; 鞋"
    assert source[slice(*setter.opening)] == "<a:Set a={b}/>"
    assert setter.inner is None
    # 剧本正文不按 XML 读：没有子标签，读出来的字和原文一字不差。
    assert script.children == []
    assert script.inner is not None
    raw = "\n    <lighter><短发女生>Light &amp; <b>fast</lighter>\n  "
    assert source[slice(*script.inner)] == raw
    assert "".join(part for part in script.parts if isinstance(part, str)) == raw


def frames(made: FilmGroup) -> list[tuple[str, str, str, int | None, str | None]]:
    return [
        (frame.node, frame.label, frame.kind, frame.number, frame.aspect_ratio)
        for frame in made.frames
    ]


def test_a_group_lists_its_reference_list_as_it_is_numbered_by_position() -> None:
    film = checked()
    made, later = film_groups(film, FILM)

    assert frames(made) == [
        ("modelAPortraitPhoto", "modelAPortraitPhoto", "photo", 1, None),
        ("modelAFullBodyPhoto", "modelAFullBodyPhoto", "photo", 2, None),
        ("personB", "personB", "generated", 3, "3:4"),
        ("shoeSidePhoto", "shoeSidePhoto", "photo", 4, None),
        ("shoeFrontPhoto", "shoeFrontPhoto", "photo", 5, None),
        ("shoeSolePhoto", "shoeSolePhoto", "photo", 6, None),
        ("scene", "scene", "generated", 7, "16:9"),
        ("view01", "镜头 1", "generated", 8, "16:9"),
        ("view02", "镜头 2", "generated", 9, "16:9"),
        ("view03", "镜头 3", "generated", 10, "16:9"),
    ]
    assert [frame.url for frame in made.frames] == list(
        render_video(film, film.project.nodes["video01"]).image_urls
    )
    assert (made.index, made.video, made.model, made.seconds, made.aspect_ratio) == (
        1,
        "video01",
        "mmt-seedance-2-5",
        18,
        "16:9",
    )
    assert (later.index, later.video, later.seconds) == (2, "video02", 15)


def golden_prompt(state: str, video: str) -> str:
    """样例里这组发给视频模型的正文：全局设定、空一行、「镜头：」、每镜一行「起–止秒 正文」、末尾约束。"""

    shot = EXPECTED["states"][state][video]["shot"]
    lines = [
        f"{format_seconds(start)}–{format_seconds(end)}秒 {cut['prompt']}"
        for cut in shot["timeline"]
        for start, end in [cut["timestamps"]]
    ]
    return "\n".join([shot["global_settings"], "", SHOTS_HEADING, *lines, OUTPUT_CONSTRAINT])


@pytest.mark.parametrize(
    ("state", "video"),
    [
        pytest.param(state, video, id=f"{state}-{video}")
        for state in STATES
        for video in ("video01", "video02")
        if not EXPECTED["states"][state][video]["blocked"]
    ],
)
def test_a_group_carries_the_prompt_it_sends(state: str, video: str) -> None:
    made = {group.video: group for group in groups(project_of(state), run_of(state))}

    assert made[video].prompt == golden_prompt(state, video)


def test_a_group_that_cannot_be_sent_still_shows_its_prompt_with_the_number_in_place() -> None:
    made = first(project_of("no-personB"), run_of("no-personB"))

    assert made.prompt == golden_prompt("both", "video01")


def test_an_image_without_a_picture_keeps_its_number_and_has_no_url() -> None:
    made = first(project_of("no-personB"), run_of("no-personB"))

    assert [(frame.node, frame.number, frame.url) for frame in made.frames[:4]] == [
        ("modelAPortraitPhoto", 1, PHOTOS["modelAPortraitPhoto"]),
        ("modelAFullBodyPhoto", 2, PHOTOS["modelAFullBodyPhoto"]),
        ("personB", 3, None),
        ("shoeSidePhoto", 4, PHOTOS["shoeSidePhoto"]),
    ]


def test_a_view_that_is_not_chosen_follows_the_list_without_a_number() -> None:
    _, later = groups(FILM_NO_VIEW04, RUN_NO_VIEW04)

    assert [(frame.node, frame.label, frame.number, frame.url) for frame in later.frames[5:]] == [
        ("scene", "scene", 6, GENERATED["scene"]),
        ("view05", "镜头 2", 7, GENERATED["view05"]),
        ("view06", "镜头 3", 8, GENERATED["view06"]),
        ("view04", "镜头 1", None, None),
    ]
    # 没进列表的机位图照样带着它的描述，能生成。
    view04 = later.frames[-1]
    assert view04.kind == "generated" and view04.prompt is not None and view04.missing == ()


def test_views_not_chosen_follow_the_list_in_shot_order() -> None:
    film = checked(FILM_NO_VIEW04, RUN_NO_VIEW04)
    written = dict(choose_image(film, FILM_NO_VIEW04, RUN_NO_VIEW04, "view05", None))
    _, later = groups(written[FILM_PATH], written[RUN_PATH])

    assert [(frame.node, frame.number) for frame in later.frames[5:]] == [
        ("scene", 6),
        ("view06", 7),
        ("view04", None),
        ("view05", None),
    ]


def test_a_generated_image_carries_its_prompt_with_the_references_in_place() -> None:
    film = checked()
    made = film_groups(film, FILM)[0]
    by_node = {frame.node: frame for frame in made.frames}

    runs = by_node["view02"].prompt
    assert runs is not None
    images = [run for run in runs if isinstance(run, FilmPromptImage)]
    assert [(run.node, run.label) for run in images] == [
        ("modelAFullBodyPhoto", "modelAFullBodyPhoto"),
        ("shoeSidePhoto", "shoeSidePhoto"),
        ("shoeSolePhoto", "shoeSolePhoto"),
        ("scene", "scene"),
        ("view01", "镜头 1"),
    ]
    assert [run.url for run in images] == EXPECTED["images"]["view02"]["input_str_list"]
    # 图片段带着它在这张图自己的参考图列表里的编号，按它写回 @ImageN 就是发给模型的那段描述。
    assert [run.number for run in images] == [1, 2, 3, 4, 5]
    joined = "".join(
        run.text if isinstance(run, FilmPromptText) else f"@Image{run.number}" for run in runs
    )
    assert joined == EXPECTED["images"]["view02"]["prompt"]
    assert by_node["shoeFrontPhoto"].prompt is None


def test_a_reference_without_a_picture_is_split_out_without_a_url_and_named_as_missing() -> None:
    made = first(project_of("no-personB"), run_of("no-personB"))
    by_node = {frame.node: frame for frame in made.frames}

    runs = by_node["view01"].prompt
    assert runs is not None
    assert [
        (run.node, run.number, run.url is None) for run in runs if isinstance(run, FilmPromptImage)
    ] == [
        ("modelAPortraitPhoto", 1, False),
        ("modelAFullBodyPhoto", 2, False),
        ("personB", 3, True),
        ("shoeSidePhoto", 4, False),
        ("shoeFrontPhoto", 5, False),
        ("scene", 6, False),
    ]
    assert "@Image" not in "".join(run.text for run in runs if isinstance(run, FilmPromptText))
    assert {node: frame.missing for node, frame in by_node.items()} == {
        **{node: () for node in by_node},
        "view01": ("personB",),
        "view03": ("personB",),
    }


def test_missing_views_are_named_by_the_group_that_asks() -> None:
    project, run = FILM, RUN.replace(USE_VIEW01, "")
    made, later = groups(project, run)
    film = checked(project, run)

    assert {frame.node: frame.missing for frame in made.frames}["view02"] == ("镜头 1",)
    assert {frame.node: frame.missing for frame in later.frames}["view04"] == ("第 1 组镜头 1",)
    assert missing_references(film, "video01") == ("镜头 1",)
    assert missing_references(film, "view02") == ("镜头 1",)
    assert missing_references(film, "view04") == ("第 1 组镜头 1",)
    assert missing_references(film, "video02") == ()


def test_given_photos_are_never_missing() -> None:
    made = first(FILM, None)

    assert {frame.node: frame.missing for frame in made.frames if frame.kind == "photo"} == (
        dict.fromkeys(PHOTOS, ())
    )
    assert [frame.url for frame in made.frames if frame.kind == "generated"] == [None] * 5


def test_settings_follow_the_video_prompt_and_are_named_by_the_slot() -> None:
    made, later = groups()

    assert [(item.kind, item.target, item.label, item.images) for item in made.settings] == [
        ("shooting", "value:videoCapture", "拍摄与剪辑", ()),
        ("element", "value:video01ModelA", "人物", ()),
        ("element", "value:video01ModelB", "人物", ()),
        ("element", "value:video01Shoe", "产品", ()),
        ("element", "value:video01Setting", "场景", ()),
        ("voice", "value:模特A声音", "声音", ()),
        ("voice", "value:模特B声音", "声音", ()),
    ]
    assert [item.text for item in made.settings] == [
        "摄影：手机拍摄，手持跟拍；景别以中景和脚部特写为主。\n"
        "剪辑：全片硬切，在迈步的动作点上剪。\n"
        "影调：清晨自然光，低对比，不做风格化调色。",
        "模特A，长相和发型参考 @Image1，身材和服装参考 @Image2。",
        "模特B，长相、发型和服装参考 @Image3。",
        "SOLE_STRETCHY 鞋款，外观参考 @Image4（侧面）、@Image5（鞋头）、@Image6（鞋底）。",
        "纽约红砖街区参考 @Image7。",
        "模特A：年轻女声，语气轻快，像随口跟朋友分享。",
        "模特B：略低的女声，带点好奇。",
    ]
    assert [item.label for item in later.settings] == ["拍摄与剪辑", "人物", "产品", "场景", "声音"]


def test_shots_carry_their_lines_with_the_speaker_from_the_script() -> None:
    made = first()

    opening = made.shots[0]
    assert (opening.target, opening.start, opening.end, opening.view) == (
        "shot:video01Shots:1",
        0.0,
        6.0,
        "view01",
    )
    assert opening.parts == (
        "参考@Image8，中景，平视，手持跟拍。模特A和模特B在红砖街区的人行道上并肩走向镜头。"
        "模特A低头看鞋说：",
        " 模特B侧头问：",
        " 音效：两人的脚步声与街道环境声。",
    )
    assert [(line.target, line.role, line.text) for line in opening.lines] == [
        ("line:hook", "模特A", "这一双，走起来很轻。"),
        ("line:reply", "模特B", "鞋底是软的吗？"),
    ]


def test_a_body_with_a_comment_in_it_cannot_be_edited_on_the_page() -> None:
    project = FILM.replace(
        "服装参考 @Image3。</text:Value>", "服装参考 @Image3。<!-- 待定 --></text:Value>", 1
    )

    person = first(project).settings[2]

    assert (person.label, person.target) == ("人物", None)
    with pytest.raises(FilmEditRejected, match="找不到了"):
        written([FilmTextEdit("value:video01ModelB", text="x")], project)


def test_a_value_with_image_numbers_is_rewritten_in_place_and_nothing_else_moves() -> None:
    typed = "清晨的纽约红砖街区，参考 @Image7。"

    updated = written([FilmTextEdit("value:video01Setting", text=typed)])

    assert changed_lines(FILM, updated) == [
        '-  <text:Value id="video01Setting">纽约红砖街区参考 @Image7。</text:Value>',
        f'+  <text:Value id="video01Setting">{typed}</text:Value>',
    ]
    assert first(updated).settings[4].text == typed


def test_shot_text_is_written_in_place_and_nothing_else_moves() -> None:
    parts = ("参考@Image8，开场。她把 {鞋} 举到 <镜头> 前 & 说：", " 她问：", " 音效：轻响")

    updated = written([shot(1, parts, HOOK, REPLY)])

    (removed, added) = changed_lines(FILM, updated)
    assert removed.startswith(
        '-    <film:Shot start="0.0" end="6.0" view={view01.image}>参考@Image8，中景'
    )
    assert added == (
        '+    <film:Shot start="0.0" end="6.0" view={view01.image}>'
        "参考@Image8，开场。她把 ｛鞋｝ 举到 &lt;镜头&gt; 前 &amp; 说：{hook} 她问：{reply} 音效：轻响"
        "</film:Shot>"
    )
    assert first(updated).shots[0].parts == (
        "参考@Image8，开场。她把 ｛鞋｝ 举到 <镜头> 前 & 说：",
        " 她问：",
        " 音效：轻响",
    )


def test_multiline_text_keeps_its_indentation() -> None:
    updated = written([FilmTextEdit("value:videoCapture", text="摄影：手机拍摄。\n\n剪辑：硬切。")])

    assert changed_lines(FILM, updated)[3:] == [
        "+    摄影：手机拍摄。",
        "+",
        "+    剪辑：硬切。",
    ]
    assert first(updated).settings[0].text == "摄影：手机拍摄。\n\n剪辑：硬切。"


def test_a_line_and_a_voice_are_rewritten_where_they_are_written() -> None:
    hook = FilmLineEdit("line:hook", "这一双  &  <很轻>！")

    updated = written(
        [
            shot(1, parts_of(1), hook, REPLY),
            FilmTextEdit("value:模特B声音", text="模特B：略低的女声。"),
        ]
    )

    assert changed_lines(FILM, updated) == [
        "-    <hook><模特A>这一双，走起来很轻。</hook>",
        "+    <hook><模特A>这一双 &amp; &lt;很轻&gt;！</hook>",
        '-  <text:Value id="模特B声音">模特B：略低的女声，带点好奇。</text:Value>',
        '+  <text:Value id="模特B声音">模特B：略低的女声。</text:Value>',
    ]
    assert first(updated).shots[0].lines[0].text == "这一双 & <很轻>！"


def test_a_line_written_on_its_own_line_stays_there() -> None:
    project = FILM.replace(
        "<answer><模特A>软，还回弹。</answer>",
        "<answer><模特A>\n      软，还回弹。\n    </answer>",
    )
    answer = FilmLineEdit("line:answer", "软，而且回弹。")

    updated = written([shot(2, parts_of(2, project), answer)], project)

    assert changed_lines(project, updated) == ["-      软，还回弹。", "+      软，而且回弹。"]


def test_lines_can_only_be_reworded() -> None:
    for lines in ((REPLY, HOOK), (HOOK,), (HOOK, REPLY, FilmLineEdit("line:answer", "x"))):
        parts = ("a",) * (len(lines) + 1)
        with pytest.raises(FilmEditRejected, match="台词只能改字"):
            written([shot(1, parts, *lines)])


def test_a_shot_whose_line_has_a_comment_is_not_offered() -> None:
    project = FILM.replace("这一双，走起来很轻。</hook>", "这一双。<!-- 待定 --></hook>")

    made = first(project)

    assert made.shots[0].target is None
    assert made.shots[0].lines[0].text == "这一双。"


@pytest.mark.parametrize(
    ("edits", "message"),
    [
        ([shot(1, ("只剩一段",), HOOK, REPLY)], "文字和台词对不上"),
        ([FilmTextEdit("shot:video01Shots:1", parts=("x", "y"))], "文字和台词对不上"),
        ([shot(1, (" ", "", ""), HOOK, REPLY)], "镜头的文字不能是空的"),
        ([shot(1, ("x", "", ""), FilmLineEdit("line:hook", "  "), REPLY)], "台词不能是空的"),
        ([shot(1, ("x", "", ""), FilmLineEdit("line:answer", "a"), REPLY)], "台词只能改字"),
        ([shot(1, ("x",))], "台词只能改字"),
        ([FilmTextEdit("value:模特B声音", text="")], "这段字不能是空的"),
        ([shot(9, ("x", ""), HOOK)], "找不到了"),
        ([FilmTextEdit("line:hook", text="x")], "找不到了"),
        ([FilmTextEdit("value:video01Shots", text="x")], "找不到了"),
        ([FilmTextEdit("element:video01ModelA", text="x")], "找不到了"),
        (
            [FilmTextEdit("value:模特B声音", text="a"), FilmTextEdit("value:模特B声音", text="b")],
            "一次只改一处",
        ),
        ([], "没有要改的字"),
        (
            [shot(1, ("参考@Image8，x", "", ""), FilmLineEdit("line:hook", "a | b"), REPLY)],
            "分镜有问题",
        ),
        # 列表里没有、也不是新插入的图号不写；写错的图号过不了保存检查。
        (
            [FilmTextEdit("value:video01Setting", text="街区参考 @Image11。")],
            "@Image11 没有对应的图",
        ),
        ([FilmTextEdit("value:video01Setting", text="街区参考 @image7。")], "分镜有问题"),
        (
            [shot(1, ("参考@Image8，x", "", ""), FilmLineEdit("line:hook", "看 @Image1"), REPLY)],
            "分镜有问题",
        ),
        (
            [FilmTextEdit("value:view01Framing", text="浅灰色" * 1400)],
            f"超过 {PROMPT_MAX_CHARS} 字",
        ),
    ],
)
def test_an_edit_that_would_break_the_film_is_not_written(
    edits: list[FilmTextEdit], message: str
) -> None:
    with pytest.raises(FilmEditRejected, match=message):
        written(edits)


NEW_PHOTO = "https://cdn.test/uploads/corner.jpg"
SETTING_LINE = '  <text:Value id="video01Setting">纽约红砖街区参考 @Image7。</text:Value>\n'
FIRST_VIEW = "    <seedance:Reference image={view01.image}/>\n"


def setting(text: str, *images: str, video: str = "video01") -> FilmTextEdit:
    return FilmTextEdit(f"value:{video}Setting", text=text, images=images)


def numbered(group: FilmGroup) -> list[tuple[str, int | None]]:
    return [(frame.node, frame.number) for frame in group.frames]


def test_inserting_an_image_already_in_the_list_uses_its_number() -> None:
    edited = edit_text(
        FILM, RUN, checked(), [setting("纽约红砖街区参考 @Image7，鞋头参考 @Image11。", SHOE_FRONT)]
    )

    assert changed_lines(FILM, edited.source) == [
        f"-{SETTING_LINE.rstrip()}",
        '+  <text:Value id="video01Setting">纽约红砖街区参考 @Image7，鞋头参考 @Image5。</text:Value>',
    ]
    assert edited.inserted == ()


def test_inserting_a_new_photo_puts_it_before_the_views_and_moves_their_numbers() -> None:
    edited = edit_text(
        FILM, RUN, checked(), [setting("纽约红砖街区参考 @Image7，街角参考 @Image11。", NEW_PHOTO)]
    )

    expected = (
        FILM.replace(
            '  <media:Image id="shoeSolePhoto" src="https://preview.invalid/uploads/shoeSolePhoto.jpg"/>\n',
            '  <media:Image id="shoeSolePhoto" src="https://preview.invalid/uploads/shoeSolePhoto.jpg"/>\n'
            f'  <media:Image id="素材照片1" src="{NEW_PHOTO}"/>\n',
        )
        .replace(
            SETTING_LINE,
            '  <text:Value id="video01Setting">纽约红砖街区参考 @Image7，街角参考 @Image8。</text:Value>\n',
        )
        .replace(">参考@Image10，硬切，近景", ">参考@Image11，硬切，近景")
        .replace(">参考@Image9，硬切，侧面", ">参考@Image10，硬切，侧面")
        .replace(">参考@Image8，中景", ">参考@Image9，中景")
        .replace(FIRST_VIEW, "    <seedance:Reference image={素材照片1}/>\n" + FIRST_VIEW)
    )
    assert edited.source == expected
    assert edited.inserted == (NEW_PHOTO,)
    made, later = groups(edited.source)
    assert numbered(made)[6:] == [
        ("scene", 7),
        ("素材照片1", 8),
        ("view01", 9),
        ("view02", 10),
        ("view03", 11),
    ]
    assert made.frames[7].url == NEW_PHOTO
    # 另一组不动。
    assert numbered(later) == numbered(groups()[1])


def test_a_photo_already_in_the_materials_is_reused_for_another_group() -> None:
    once = written([setting("纽约红砖街区参考 @Image7，街角参考 @Image11。", NEW_PHOTO)])

    edited = edit_text(
        once,
        RUN,
        checked(once),
        [setting("纽约红砖街区参考 @Image6，街角参考 @Image10。", NEW_PHOTO, video="video02")],
    )

    # 「素材」里已经有这张照片：不再加，第 2 组的列表引用它。
    expected = (
        once.replace(
            '  <text:Value id="video02Setting">纽约红砖街区参考 @Image6。</text:Value>',
            '  <text:Value id="video02Setting">纽约红砖街区参考 @Image6，街角参考 @Image7。</text:Value>',
        )
        .replace(">参考@Image9，硬切，全景", ">参考@Image10，硬切，全景")
        .replace(">参考@Image8，硬切，中景，手持跟拍", ">参考@Image9，硬切，中景，手持跟拍")
        .replace(">参考@Image7，低机位", ">参考@Image8，低机位")
        .replace(
            "    <seedance:Reference image={view04.image}/>\n",
            "    <seedance:Reference image={素材照片1}/>\n"
            "    <seedance:Reference image={view04.image}/>\n",
        )
    )
    assert edited.source == expected
    assert edited.inserted == (NEW_PHOTO,)
    assert numbered(groups(edited.source)[1])[5:7] == [("scene", 6), ("素材照片1", 7)]


def test_one_new_photo_inserted_into_two_groups_is_added_once() -> None:
    edited = edit_text(
        FILM,
        RUN,
        checked(),
        [
            setting("纽约红砖街区参考 @Image7，街角参考 @Image11。", NEW_PHOTO),
            setting("纽约红砖街区参考 @Image6，街角参考 @Image10。", NEW_PHOTO, video="video02"),
        ],
    )

    assert edited.source.count(f'src="{NEW_PHOTO}"') == 1
    assert edited.inserted == (NEW_PHOTO,)
    made, later = groups(edited.source)
    assert (made.frames[7].node, later.frames[6].node) == ("素材照片1", "素材照片1")


def test_removing_the_only_reference_to_an_image_takes_it_out_of_the_list() -> None:
    edited = edit_text(
        FILM, RUN, checked(), [FilmTextEdit("value:video01ModelB", text="模特B，短发。")]
    )

    expected = (
        FILM.replace(
            '  <text:Value id="video01ModelB">模特B，长相、发型和服装参考 @Image3。</text:Value>',
            '  <text:Value id="video01ModelB">模特B，短发。</text:Value>',
        )
        .replace(
            "外观参考 @Image4（侧面）、@Image5（鞋头）、@Image6（鞋底）。</text:Value>\n"
            '  <text:Value id="video01Setting">纽约红砖街区参考 @Image7。',
            "外观参考 @Image3（侧面）、@Image4（鞋头）、@Image5（鞋底）。</text:Value>\n"
            '  <text:Value id="video01Setting">纽约红砖街区参考 @Image6。',
        )
        .replace(">参考@Image8，中景", ">参考@Image7，中景")
        .replace(">参考@Image9，硬切，侧面", ">参考@Image8，硬切，侧面")
        .replace(">参考@Image10，硬切，近景", ">参考@Image9，硬切，近景")
        .replace(
            "    <seedance:Reference image={modelAFullBodyPhoto}/>\n"
            "    <seedance:Reference image={personB.image}/>\n",
            "    <seedance:Reference image={modelAFullBodyPhoto}/>\n",
            1,
        )
    )
    assert edited.source == expected
    assert [node for node, _ in numbered(first(edited.source))] == [
        "modelAPortraitPhoto",
        "modelAFullBodyPhoto",
        "shoeSidePhoto",
        "shoeFrontPhoto",
        "shoeSolePhoto",
        "scene",
        "view01",
        "view02",
        "view03",
    ]
    # personB 仍是第 2 组的设定图，只是不在第 1 组的列表里了。
    assert "personB" in checked(edited.source).project.nodes


def test_removing_one_of_two_references_keeps_the_list() -> None:
    project = FILM.replace(
        SETTING_LINE, SETTING_LINE.replace("@Image7。", "@Image7，人行道参考 @Image4。")
    )

    updated = written([setting("纽约红砖街区参考 @Image7。")], project)

    assert changed_lines(project, updated) == [
        '-  <text:Value id="video01Setting">纽约红砖街区参考 @Image7，人行道参考 @Image4。</text:Value>',
        f"+{SETTING_LINE.rstrip()}",
    ]


def test_inserting_and_removing_in_one_edit_renumbers_once() -> None:
    # 删掉 personB（@3）的唯一一处，同时在场景里插入新照片：personB 出列表，新照片排在 scene 之后、机位图之前。
    edited = edit_text(
        FILM,
        RUN,
        checked(),
        [
            FilmTextEdit("value:video01ModelB", text="模特B，短发。"),
            setting("纽约红砖街区参考 @Image7，街角参考 @Image11。", NEW_PHOTO),
        ],
    )

    made = first(edited.source)
    assert numbered(made)[5:] == [
        ("scene", 6),
        ("素材照片1", 7),
        ("view01", 8),
        ("view02", 9),
        ("view03", 10),
    ]
    assert made.settings[4].text == "纽约红砖街区参考 @Image6，街角参考 @Image7。"
    assert [shot.parts[0].partition("，")[0] for shot in made.shots] == [
        "参考@Image8",
        "参考@Image9",
        "参考@Image10",
    ]


@pytest.mark.parametrize(
    "edit",
    [
        # 删掉镜头开头的机位图引用。
        shot(1, ("中景，平视。", " ", ""), HOOK, REPLY),
        # 挪到别处。
        shot(1, ("中景，参考@Image8，平视。", " ", ""), HOOK, REPLY),
        # 在别的字里再写一次机位图的图号。
        setting("纽约红砖街区参考 @Image7，与 @Image8 一致。"),
        # 新插入的图就是机位图那张。
        setting("纽约红砖街区参考 @Image7，与 @Image11 一致。", GENERATED["view01"]),
    ],
)
def test_view_references_only_follow_the_choice(edit: FilmTextEdit) -> None:
    with pytest.raises(FilmEditRejected, match="机位图的引用随选用增删；请在镜头上取消选用"):
        written([edit])


@pytest.mark.parametrize(
    "edit",
    [
        FilmTextEdit(
            "value:videoCapture", text="摄影：手机拍摄，参考 @Image11。", images=(NEW_PHOTO,)
        ),
        FilmTextEdit("value:模特A声音", text="模特A：年轻女声，参考 @Image1。"),
    ],
)
def test_text_shared_by_several_nodes_takes_no_images(edit: FilmTextEdit) -> None:
    with pytest.raises(FilmEditRejected, match="用在几个地方，无法插入图片"):
        written([edit])


@pytest.mark.parametrize(
    ("edit", "message"),
    [
        (setting("纽约红砖街区参考 @Image7。", NEW_PHOTO), "插入的图和字对不上"),
        (setting("纽约红砖街区参考 @Image7，@Image12。", NEW_PHOTO), "@Image12 没有对应的图"),
        (
            FilmTextEdit(
                "value:view01Setting", text="街区参考 @Image6，@Image7。", images=(NEW_PHOTO,)
            ),
            "只能在视频的文字里插入图片",
        ),
    ],
)
def test_inserted_images_must_match_the_text(edit: FilmTextEdit, message: str) -> None:
    with pytest.raises(FilmEditRejected, match=message):
        written([edit])


def test_choosing_an_image_for_a_generated_node_registers_and_selects_it() -> None:
    url = 'https://cdn.test/person & "x".png'
    run = run_of("no-personB")

    changes = choose_image(checked(FILM, run), FILM, run, "personB", url)

    ((path, content),) = changes
    assert path == RUN_PATH
    assert changed_lines(run, content) == [
        '+  <media:Image id="personB-1" src="https://cdn.test/person &amp; &quot;x&quot;.png"/>',
        '+  <use output="personB.image" image={personB-1}/>',
    ]
    assert checked(FILM, content).image_url("personB.image") == url


def test_an_image_already_registered_is_reused() -> None:
    ((_, content),) = choose_image(checked(), FILM, RUN, "personB", GENERATED["scene"])

    assert changed_lines(RUN, content) == [
        '-  <use output="personB.image" image={personB-v1}/>',
        '+  <use output="personB.image" image={scene-v1}/>',
    ]


def test_clearing_a_choice_removes_its_use_and_leaves_the_image_empty() -> None:
    ((path, content),) = choose_image(checked(), FILM, RUN, "personB", None)

    assert path == RUN_PATH
    assert content == run_of("no-personB")
    film = checked(FILM, content)
    assert film.image_url("personB.image") is None
    # 登记的图留着，可以再选用。
    assert film.registered["personB-v1"] == GENERATED["personB"]


def test_nothing_is_written_when_the_image_is_already_the_one_in_use() -> None:
    film = checked()
    unchosen = run_of("no-personB")

    assert choose_image(film, FILM, RUN, "personB", GENERATED["personB"]) == []
    assert choose_image(checked(FILM, unchosen), FILM, unchosen, "personB", None) == []
    assert choose_image(film, FILM, RUN, "shoeFrontPhoto", SHOE_FRONT) == []


def test_the_first_choice_creates_the_run_file() -> None:
    ((path, content),) = choose_image(
        checked(FILM, None), FILM, None, "personB", GENERATED["personB"]
    )

    assert path == RUN_PATH
    film = checked(FILM, content)
    assert film.selected == {"personB": "personB-1"}
    assert film.image_url("personB.image") == GENERATED["personB"]


def test_a_given_photo_gets_its_new_address_in_the_project_file() -> None:
    url = "https://cdn.test/new-shoe.jpg?size=2&crop=1"

    ((path, content),) = choose_image(checked(), FILM, RUN, "shoeFrontPhoto", url)

    assert path == FILM_PATH
    assert changed_lines(FILM, content)[1] == (
        '+  <media:Image id="shoeFrontPhoto" src="https://cdn.test/new-shoe.jpg?size=2&amp;crop=1"/>'
    )
    assert checked(content).image_url("shoeFrontPhoto") == url


@pytest.mark.parametrize(
    ("image", "url", "message"),
    [
        ("shoeFrontPhoto", None, "不能清空"),
        ("capture", "https://cdn.test/x.png", "找不到这张图"),
        ("没有这个", "https://cdn.test/x.png", "找不到这张图"),
    ],
)
def test_a_choice_that_does_not_fit_the_image_is_refused(
    image: str, url: str | None, message: str
) -> None:
    with pytest.raises(FilmEditRejected, match=message):
        choose_image(checked(), FILM, RUN, image, url)


def test_choosing_a_view_for_the_first_time_writes_it_into_its_group() -> None:
    film = checked(FILM_NO_VIEW04, RUN_NO_VIEW04)

    changes = choose_image(film, FILM_NO_VIEW04, RUN_NO_VIEW04, "view04", VIEW04)

    # 先写工程文件：插在 video02 元素图之后、镜头 2 的机位图之前，镜头 1 开头写引用，后面的图号各加 1。
    assert [path for path, _ in changes] == [FILM_PATH, RUN_PATH]
    project, run = (content for _, content in changes)
    assert project == FILM
    assert checked(project, run).image_url("view04.image") == VIEW04


def test_clearing_a_view_takes_it_out_of_its_group() -> None:
    changes = choose_image(checked(), FILM, RUN, "view04", None)

    # 先写运行文件：删掉选用，再删掉列表里的这一行和镜头 1 开头的引用，后面的图号各减 1。
    assert changes == [(RUN_PATH, RUN_NO_VIEW04), (FILM_PATH, FILM_NO_VIEW04)]


def test_switching_a_view_to_another_version_only_writes_the_run_file() -> None:
    ((path, content),) = choose_image(
        checked(), FILM, RUN, "view04", "https://cdn.test/view04-v2.png"
    )

    assert path == RUN_PATH
    assert changed_lines(RUN, content)[-2:] == [
        '-  <use output="view04.image" image={view04-v1}/>',
        '+  <use output="view04.image" image={view04-1}/>',
    ]


def test_a_view_in_the_middle_moves_the_later_numbers() -> None:
    expected = (
        FILM.replace("    <seedance:Reference image={view05.image}/>\n", "")
        .replace(">参考@Image8，硬切，中景，手持跟拍。", ">硬切，中景，手持跟拍。")
        .replace(">参考@Image9，硬切，全景", ">参考@Image8，硬切，全景")
    )
    without = RUN.replace('  <use output="view05.image" image={view05-v1}/>\n', "")

    cleared = choose_image(checked(), FILM, RUN, "view05", None)
    chosen = choose_image(
        checked(expected, without), expected, without, "view05", GENERATED["view05"]
    )

    assert cleared == [(RUN_PATH, without), (FILM_PATH, expected)]
    assert chosen[0] == (FILM_PATH, FILM)


def test_a_half_written_choice_still_passes_and_blocks_its_group_until_it_is_repeated() -> None:
    # 两种写法中途失败都会停在这里：列表里有 view04，运行文件里没有选用它。
    film = checked(FILM, RUN_NO_VIEW04)

    assert missing_references(film, "video02") == ("镜头 1",)
    assert choose_image(film, FILM, RUN_NO_VIEW04, "view04", VIEW04)[0][0] == RUN_PATH
    assert choose_image(film, FILM, RUN_NO_VIEW04, "view04", None) == [(FILM_PATH, FILM_NO_VIEW04)]


def test_a_view_whose_shot_cannot_be_rewritten_in_place_is_refused() -> None:
    project = FILM_NO_VIEW04.replace("她说：{stride} 音效", "她说：{stride}<!-- 待定 --> 音效")

    with pytest.raises(FilmEditRejected, match="跟 AI 导演说"):
        choose_image(checked(project, RUN_NO_VIEW04), project, RUN_NO_VIEW04, "view04", VIEW04)


def test_images_are_assembled_from_the_film_as_it_stands() -> None:
    film = checked()

    picture = render_picture(film, film.project.nodes["personB"])

    assert picture.text == EXPECTED["images"]["personB"]["prompt"]
    assert picture.image_urls == ()
