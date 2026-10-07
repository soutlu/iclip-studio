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
)
from iclip.common.film_view import (
    FilmGroup,
    FilmLineEdit,
    FilmPromptImage,
    FilmPromptText,
    FilmTextEdit,
)
from tests.helpers.film import (
    FILM,
    IMAGE_NODES,
    PERSON_FIRST,
    PERSON_FIXED,
    RUN,
    SHOE_FRONT,
    VIEW_ONE,
    expected_prompt,
    two_requests,
)

LIGHTER = FilmLineEdit("line:lighter", "It's lighter than it looks.")
MISSING = ("短发女生参考图", "镜02机位图")


def checked(project: str = FILM, run: str | None = RUN) -> Film:
    film = check(project, run)
    assert isinstance(film, Film) and not film.errors, film
    return film


def generated(*missing: str) -> Film:
    """每个生图节点都在运行文件里选用了一张图，``missing`` 里的除外。"""

    film = checked(run=None)
    for node in IMAGE_NODES:
        if node not in missing:
            film.registered[f"{node}-1"] = f"https://cdn.test/{node}.png"
            film.selected[node] = f"{node}-1"
    return film


def group(project: str = FILM, run: str | None = RUN) -> FilmGroup:
    (only,) = film_groups(checked(project, run), project)
    return only


def shot(number: int, parts: tuple[str, ...], *lines: FilmLineEdit) -> FilmTextEdit:
    return FilmTextEdit(f"shot:全片镜头:{number}", parts=parts, lines=lines)


def parts_of(number: int, project: str = FILM) -> tuple[str, ...]:
    return group(project).shots[number - 1].parts


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


def test_a_group_lists_its_images_in_the_order_and_numbering_sent_to_the_video() -> None:
    film = generated()
    (made,) = film_groups(film, FILM)
    sent = render_video(film, film.project.nodes["全片"]).image_urls

    assert frames(made) == [
        ("短发女生参考图", "短发女生", "generated", 1, "3:4"),
        ("跑鞋正面", "网面跑鞋", "photo", 2, None),
        ("跑鞋鞋底", "网面跑鞋", "photo", 3, None),
        ("公园跑道参考图", "公园跑道", "generated", 4, "9:16"),
        ("镜01机位图", "镜头 1", "generated", 5, "9:16"),
        ("镜02机位图", "镜头 2", "generated", 6, "9:16"),
        ("镜03机位图", "镜头 3", "generated", 7, "9:16"),
        ("镜04机位图", "镜头 4", "generated", 8, "9:16"),
    ]
    assert [frame.url for frame in made.frames] == list(sent)
    assert (made.index, made.video, made.model, made.seconds, made.aspect_ratio) == (
        1,
        "全片",
        "mmt-seedance-2-5",
        15,
        "9:16",
    )


def test_only_images_that_exist_are_numbered() -> None:
    (made,) = film_groups(generated(*MISSING), FILM)

    assert [(frame.node, frame.number) for frame in made.frames] == [
        ("短发女生参考图", None),
        ("跑鞋正面", 1),
        ("跑鞋鞋底", 2),
        ("公园跑道参考图", 3),
        ("镜01机位图", 4),
        ("镜02机位图", None),
        ("镜03机位图", 5),
        ("镜04机位图", 6),
    ]


def test_a_generated_image_carries_its_prompt_with_the_references_in_place() -> None:
    film = generated()
    (made,) = film_groups(film, FILM)
    by_node = {frame.node: frame for frame in made.frames}

    runs = by_node["镜02机位图"].prompt
    assert runs is not None
    images = [run for run in runs if isinstance(run, FilmPromptImage)]
    assert [(run.node, run.label) for run in images] == [
        ("短发女生参考图", "短发女生"),
        ("跑鞋正面", "网面跑鞋"),
        ("跑鞋鞋底", "网面跑鞋"),
        ("公园跑道参考图", "公园跑道"),
        ("镜01机位图", "镜头 1"),
    ]
    assert [run.url for run in images] == list(
        render_picture(film, film.project.nodes["镜02机位图"]).image_urls
    )
    # 参考图按在描述里第一次出现的先后编号，写回 @ImageN，就是发给模型的那段描述。
    numbers = {run.node: n for n, run in enumerate(images, start=1)}
    joined = "".join(
        run.text if isinstance(run, FilmPromptText) else f"@Image{numbers[run.node]}"
        for run in runs
    )
    assert joined == expected_prompt("一", "生图：镜02机位图")[0]
    assert by_node["跑鞋正面"].prompt is None


def test_a_reference_without_an_image_is_written_as_text_only() -> None:
    (made,) = film_groups(generated(*MISSING), FILM)

    runs = next(frame.prompt for frame in made.frames if frame.node == "镜03机位图")
    assert runs is not None
    images = [run.node for run in runs if isinstance(run, FilmPromptImage)]
    assert images == ["跑鞋正面", "跑鞋鞋底", "公园跑道参考图", "镜01机位图"]
    assert "东亚女性" in "".join(run.text for run in runs if isinstance(run, FilmPromptText))


def missing_of(made: FilmGroup) -> dict[str, tuple[str, ...]]:
    return {frame.node: frame.missing for frame in made.frames}


def test_a_generated_image_names_the_references_that_have_no_image_yet() -> None:
    (made,) = film_groups(generated(*MISSING, "镜01机位图"), FILM)

    assert missing_of(made) == {
        "短发女生参考图": (),
        "跑鞋正面": (),
        "跑鞋鞋底": (),
        "公园跑道参考图": (),
        "镜01机位图": ("短发女生",),
        "镜02机位图": ("短发女生", "镜头 1"),
        "镜03机位图": ("短发女生", "镜头 1"),
        "镜04机位图": ("镜头 1",),
    }


def test_nothing_is_missing_when_every_reference_has_an_image() -> None:
    (made,) = film_groups(generated(), FILM)

    assert all(frame.missing == () for frame in made.frames)


def test_given_photos_are_never_missing() -> None:
    # 镜04 只挂两张用户给的照片；一张图都没选用，它也不缺。
    project = FILM.replace(
        "    <gpt:Reference image={公园跑道参考图.image} for={公园跑道}/>\n"
        "    <gpt:Reference image={镜01机位图.image}>木长椅和光线与同一场戏的第一个机位保持一致"
        "</gpt:Reference>\n  </gpt:Image>",
        "  </gpt:Image>",
    )
    assert project != FILM

    made = group(project, None)

    assert missing_of(made)["镜04机位图"] == ()
    assert [frame.url for frame in made.frames if frame.kind == "generated"] == [None] * 6


def test_a_view_from_another_group_is_named_with_that_group() -> None:
    project = two_requests()

    _, later = film_groups(checked(project), project)

    assert [(frame.label, frame.number) for frame in later.frames] == [
        ("网面跑鞋", 1),
        ("第 1 组镜头 1", 2),
    ]


def test_settings_follow_the_video_prompt() -> None:
    made = group()

    assert [(item.kind, item.target, item.label, item.images) for item in made.settings] == [
        ("shooting", "value:拍摄与剪辑", None, ()),
        ("element", "value:短发女生", "人物 短发女生", ("短发女生参考图",)),
        ("element", "value:网面跑鞋", "产品 网面跑鞋", ("跑鞋正面", "跑鞋鞋底")),
        ("element", "value:公园跑道", "场景 公园跑道", ("公园跑道参考图",)),
        ("voice", "value:短发女生声音", "声音", ()),
        ("voice", "value:旁白声音", "声音", ()),
    ]
    texts = [item.text for item in made.settings]
    assert (
        texts[0].splitlines()[0]
        == "摄影：手机拍摄，手持跟拍，带轻微呼吸感；景别以中近景和鞋部特写为主。"
    )
    assert texts[1].endswith("左手腕戴一块白色运动手表"), "人物的身材句只在生图里，不在设定里"
    assert "head-to-shoulder" not in "\n".join(texts)
    assert texts[4].startswith("短发女生：年轻女性")


def test_shots_carry_their_lines_with_the_speaker_from_the_script() -> None:
    made = group()

    first = made.shots[0]
    assert (first.target, first.start, first.end, first.view) == (
        "shot:全片镜头:1",
        0.0,
        2.5,
        "镜01机位图",
    )
    assert first.parts[0].endswith("她抬头看着镜头说：")
    assert first.parts[1] == " 音效：鞋底弹回时的一声轻响"
    assert [(line.target, line.role, line.text) for line in first.lines] == [
        ("line:lighter", "短发女生", "It's lighter than it looks.")
    ]
    last = made.shots[3]
    assert [(line.target, line.role, line.text) for line in last.lines] == [
        ("line:shop", "旁白", "Light & fast — grab yours before the weekend.")
    ]


def test_a_body_with_a_comment_in_it_cannot_be_edited_on_the_page() -> None:
    project = FILM.replace(
        "左手腕戴一块白色运动手表</text:Value>",
        "左手腕戴一块白色运动手表<!-- 待定 --></text:Value>",
    )

    person = group(project).settings[1]

    assert (person.label, person.target) == ("人物 短发女生", None)
    with pytest.raises(FilmEditRejected, match="找不到了"):
        edit_text(project, checked(project), [FilmTextEdit("value:短发女生", text="东亚女性")])


def test_a_value_is_rewritten_in_place_and_nothing_else_moves() -> None:
    typed = "东亚女性，二十出头；黑色短发。上身穿浅灰色T恤"

    updated = edit_text(FILM, checked(), [FilmTextEdit("value:短发女生", text=typed)])

    assert changed_lines(FILM, updated) == [
        '-  <text:Value id="短发女生">东亚女性，二十出头；鹅蛋脸，单眼皮，细长眉，淡妆；黑色齐耳短发，'
        "中分。上身穿浅灰色速干短袖T恤，下身穿黑色及膝运动短裤，左手腕戴一块白色运动手表</text:Value>",
        f'+  <text:Value id="短发女生">{typed}</text:Value>',
    ]
    assert group(updated).settings[1].text == typed


def test_shot_text_is_written_in_place_and_nothing_else_moves() -> None:
    parts = ("开场，手持。她把 {鞋} 举到 <镜头> 前 & 笑：", " 音效：轻响")

    updated = edit_text(FILM, checked(), [shot(1, parts, LIGHTER)])

    (removed, added) = changed_lines(FILM, updated)
    assert removed.startswith(
        '-    <film:Shot start="0.0" end="2.5" view={镜01机位图.image}>开场，手持，'
    )
    assert added == (
        '+    <film:Shot start="0.0" end="2.5" view={镜01机位图.image}>'
        "开场，手持。她把 ｛鞋｝ 举到 &lt;镜头&gt; 前 &amp; 笑：{lighter} 音效：轻响</film:Shot>"
    )
    assert group(updated).shots[0].parts == (
        "开场，手持。她把 ｛鞋｝ 举到 <镜头> 前 & 笑：",
        " 音效：轻响",
    )


def test_multiline_text_keeps_its_indentation() -> None:
    updated = edit_text(
        FILM, checked(), [FilmTextEdit("value:拍摄与剪辑", text="摄影：手机拍摄。\n\n剪辑：硬切。")]
    )

    assert changed_lines(FILM, updated)[3:] == [
        "+    摄影：手机拍摄。",
        "+",
        "+    剪辑：硬切。",
    ]
    assert group(updated).settings[0].text == "摄影：手机拍摄。\n\n剪辑：硬切。"


def test_a_line_and_a_voice_are_rewritten_where_they_are_written() -> None:
    lighter = FilmLineEdit("line:lighter", "Lighter  &  <brighter>!")

    updated = edit_text(
        FILM,
        checked(),
        [
            shot(1, parts_of(1), lighter),
            FilmTextEdit("value:旁白声音", text="旁白：成熟男性的中低音。"),
        ],
    )

    assert changed_lines(FILM, updated) == [
        "-    <lighter><短发女生>It's lighter than it looks.</lighter>",
        "+    <lighter><短发女生>Lighter &amp; &lt;brighter&gt;!</lighter>",
        '-  <text:Value id="旁白声音">旁白：成熟男性圆润厚实的中低音。清晰松弛的英式英语，不紧不慢，'
        "像坐在对面认真地跟你讲他的判断。</text:Value>",
        '+  <text:Value id="旁白声音">旁白：成熟男性的中低音。</text:Value>',
    ]
    assert group(updated).shots[0].lines[0].text == "Lighter & <brighter>!"


def test_a_line_written_on_its_own_line_stays_there() -> None:
    project = FILM.replace(
        "<miles><短发女生>Five miles, and my feet don't hurt.</miles>",
        "<miles><短发女生>\n      Five miles, and my feet don't hurt.\n    </miles>",
    )
    miles = FilmLineEdit("line:miles", "Six miles!")

    updated = edit_text(project, checked(project), [shot(3, parts_of(3, project), miles)])

    assert changed_lines(project, updated) == [
        "-      Five miles, and my feet don't hurt.",
        "+      Six miles!",
    ]


def test_lines_can_only_be_reworded() -> None:
    project = FILM.replace(
        "笑着对镜头说：{miles} 音效：连续的脚步声",
        "笑着对镜头说：{miles} 旁白：{shop} 音效：脚步声",
    ).replace("拿起左脚那只鞋。旁白：{shop}", "拿起左脚那只鞋。")
    miles, shop = (FilmLineEdit(line.target, line.text) for line in group(project).shots[2].lines)
    film = checked(project)

    for lines in ((shop, miles), (miles,), (miles, shop, FilmLineEdit("line:lighter", "x"))):
        parts = ("a",) * (len(lines) + 1)
        with pytest.raises(FilmEditRejected, match="台词只能改字"):
            edit_text(project, film, [shot(3, parts, *lines)])


def test_a_shot_whose_line_has_a_comment_is_not_offered() -> None:
    project = FILM.replace(
        "It's lighter than it looks.</lighter>", "It's lighter.<!-- 待定 --></lighter>"
    )

    made = group(project)

    assert made.shots[0].target is None
    assert made.shots[0].lines[0].text == "It's lighter."


@pytest.mark.parametrize(
    ("edits", "message"),
    [
        ([shot(1, ("只剩一段",), LIGHTER)], "文字和台词对不上"),
        ([FilmTextEdit("shot:全片镜头:1", parts=("x", "y"))], "文字和台词对不上"),
        ([shot(1, (" ", ""), LIGHTER)], "镜头的文字不能是空的"),
        ([shot(1, ("x", ""), FilmLineEdit("line:lighter", "  "))], "台词不能是空的"),
        ([shot(1, ("x", ""), FilmLineEdit("line:miles", "a"))], "台词只能改字"),
        ([shot(1, ("x",))], "台词只能改字"),
        ([FilmTextEdit("value:旁白声音", text="")], "这段字不能是空的"),
        ([shot(1, ("看 @Image1", ""), LIGHTER)], "不能写 @Image"),
        ([shot(9, ("x", ""), LIGHTER)], "找不到了"),
        ([FilmTextEdit("line:lighter", text="x")], "找不到了"),
        ([FilmTextEdit("value:全片镜头", text="x")], "找不到了"),
        ([FilmTextEdit("element:短发女生", text="x")], "找不到了"),
        (
            [FilmTextEdit("value:旁白声音", text="a"), FilmTextEdit("value:旁白声音", text="b")],
            "一次只改一处",
        ),
        ([], "没有要改的字"),
        ([shot(1, ("x", ""), FilmLineEdit("line:lighter", "a | b"))], "分镜有问题"),
        (
            [FilmTextEdit("value:网面跑鞋", text="浅蓝色" * 1400)],
            f"超过 {PROMPT_MAX_CHARS} 字",
        ),
    ],
)
def test_an_edit_that_would_break_the_film_is_not_written(
    edits: list[FilmTextEdit], message: str
) -> None:
    with pytest.raises(FilmEditRejected, match=message):
        edit_text(FILM, checked(), edits)


def test_choosing_an_image_for_a_generated_node_registers_and_selects_it() -> None:
    url = 'https://cdn.test/park & "x".png'

    change = choose_image(checked(), FILM, RUN, "公园跑道参考图", url)

    assert change is not None and change[0] == RUN_PATH
    assert changed_lines(RUN, change[1]) == [
        '+  <media:Image id="公园跑道参考图-1" src="https://cdn.test/park &amp; &quot;x&quot;.png"/>',
        '+  <use output="公园跑道参考图.image" image={公园跑道参考图-1}/>',
    ]
    assert checked(FILM, change[1]).image_url("公园跑道参考图.image") == url


def test_an_image_already_registered_is_reused() -> None:
    change = choose_image(checked(), FILM, RUN, "短发女生参考图", PERSON_FIRST)

    assert change is not None
    assert changed_lines(RUN, change[1]) == [
        '-  <use output="短发女生参考图.image" image={短发女生修过手}/>',
        '+  <use output="短发女生参考图.image" image={短发女生第一版}/>',
    ]


def test_clearing_a_choice_removes_its_use_and_leaves_the_image_empty() -> None:
    change = choose_image(checked(), FILM, RUN, "短发女生参考图", None)

    assert change is not None
    assert changed_lines(RUN, change[1]) == [
        '-  <use output="短发女生参考图.image" image={短发女生修过手}/>'
    ]
    film = checked(FILM, change[1])
    assert film.image_url("短发女生参考图.image") is None
    # 登记的图留着，可以再选用。
    assert film.registered["短发女生修过手"] == PERSON_FIXED


def test_nothing_is_written_when_the_image_is_already_the_one_in_use() -> None:
    film = checked()

    assert choose_image(film, FILM, RUN, "短发女生参考图", PERSON_FIXED) is None
    assert choose_image(film, FILM, RUN, "公园跑道参考图", None) is None
    assert choose_image(film, FILM, RUN, "跑鞋正面", SHOE_FRONT) is None


def test_the_first_choice_creates_the_run_file() -> None:
    change = choose_image(checked(FILM, None), FILM, None, "镜01机位图", VIEW_ONE)

    assert change is not None and change[0] == RUN_PATH
    film = checked(FILM, change[1])
    assert film.selected == {"镜01机位图": "镜01机位图-1"}
    assert film.image_url("镜01机位图.image") == VIEW_ONE


def test_a_given_photo_gets_its_new_address_in_the_project_file() -> None:
    url = "https://cdn.test/new-shoe.jpg?size=2&crop=1"

    change = choose_image(checked(), FILM, RUN, "跑鞋正面", url)

    assert change is not None and change[0] == FILM_PATH
    assert changed_lines(FILM, change[1])[1] == (
        '+  <media:Image id="跑鞋正面" src="https://cdn.test/new-shoe.jpg?size=2&amp;crop=1"/>'
    )
    assert checked(change[1]).image_url("跑鞋正面") == url


@pytest.mark.parametrize(
    ("image", "url", "message"),
    [
        ("跑鞋正面", None, "不能清空"),
        ("短发女生", "https://cdn.test/x.png", "找不到这张图"),
        ("没有这个", "https://cdn.test/x.png", "找不到这张图"),
    ],
)
def test_a_choice_that_does_not_fit_the_image_is_refused(
    image: str, url: str | None, message: str
) -> None:
    with pytest.raises(FilmEditRejected, match=message):
        choose_image(checked(), FILM, RUN, image, url)
