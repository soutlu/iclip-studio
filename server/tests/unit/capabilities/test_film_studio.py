"""验证制作页的工程读法：标签在原文里的位置、按视频请求分的组、改字写回与换图写回。"""

from __future__ import annotations

import difflib

import pytest

from iclip.capabilities.iclip_studio.film.checks import check, load_project
from iclip.capabilities.iclip_studio.film.film import FILM_PATH, RUN_PATH, Film
from iclip.capabilities.iclip_studio.film.markup import parse
from iclip.capabilities.iclip_studio.film.packages import PROMPT_MAX_CHARS
from iclip.capabilities.iclip_studio.film.prompts import for_video, render_storyboard
from iclip.capabilities.iclip_studio.film.studio import (
    FilmEditRejected,
    choose_image,
    edit_text,
    film_groups,
)
from iclip.common.film_view import FilmGroup, FilmLineEdit, FilmTextEdit
from tests.helpers.film import FILM, PERSON_FIRST, PERSON_FIXED, RUN, SHOE_PHOTO, VIEW_ONE

BODY_SENTENCE = (
    "She has a slim, well-proportioned figure, very broad shoulders and excellent "
    "head-to-shoulder proportions."
)
LATEST_PARK = "https://cdn.test/park-latest.png"
LIGHTER = FilmLineEdit("line:lighter", "短发女生", "It's lighter than it looks.")
REBOUND = FilmLineEdit(
    "line:rebound", "旁白", "Every step gives a little back, so you'll run longer."
)


def checked(project: str = FILM, run: str | None = RUN) -> Film:
    film = check(project, run)
    assert isinstance(film, Film) and not film.errors, film
    return film


def group(project: str = FILM, run: str | None = RUN) -> FilmGroup:
    (only,) = film_groups(checked(project, run), project)
    return only


def shot(number: int, parts: tuple[str, ...], *lines: FilmLineEdit) -> FilmTextEdit:
    return FilmTextEdit(f"shot:全片分镜:{number}", parts=parts, lines=lines)


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
        '  <Element id="短发女生" ref={名字}>东亚女性 &amp; 鞋</Element>\n'
        "  <Cast a={b}/>\n"
        "  <Shot></Shot>\n"
        "</icml>"
    )
    _, root = parse(source, using="x")
    element, cast, shot = root.children

    assert element.opening is not None and cast.opening is not None
    assert source[slice(*element.opening)] == '<Element id="短发女生" ref={名字}>'
    assert element.inner is not None and source[slice(*element.inner)] == "东亚女性 &amp; 鞋"
    assert source[slice(*cast.opening)] == "<Cast a={b}/>"
    assert cast.inner is None
    assert shot.inner is not None and source[slice(*shot.inner)] == ""


def test_a_group_lists_its_images_in_the_order_and_numbering_sent_to_the_video() -> None:
    film = checked()
    (made,) = film_groups(film, FILM)
    sent = render_storyboard(film, film.project.nodes["全片分镜"]).image_urls

    assert [(frame.node, frame.label, frame.kind, frame.number) for frame in made.frames] == [
        ("短发女生参考图", "短发女生", "generated", 1),
        ("跑鞋照片", "网面跑鞋", "photo", 2),
        ("公园跑道参考图", "公园跑道", "generated", None),
        ("镜01机位图", "镜头 1", "generated", 3),
        ("镜02机位图", "镜头 2", "generated", None),
    ]
    numbered = [frame for frame in made.frames if frame.number is not None]
    assert [frame.url for frame in numbered] == list(sent)
    assert (made.index, made.video, made.model, made.seconds, made.aspect_ratio) == (
        1,
        "全片",
        "mmt-seedance-2-5",
        15,
        "9:16",
    )


def test_a_generated_image_shows_its_latest_result_until_one_is_chosen() -> None:
    film = checked()
    film.generated["公园跑道参考图"] = LATEST_PARK
    (made,) = film_groups(film, FILM)

    park = next(frame for frame in made.frames if frame.node == "公园跑道参考图")
    assert (park.url, park.number) == (LATEST_PARK, 3)
    assert next(frame for frame in made.frames if frame.node == "镜01机位图").number == 4


def test_a_view_from_another_group_is_named_with_that_group() -> None:
    second = (
        '  <Storyboard id="后半分镜">\n'
        "    <Cast element={网面跑鞋} image={跑鞋照片}/>\n"
        "    <Reference image={镜01机位图.image}>同一场戏的上一个机位。</Reference>\n"
        '    <Block name="拍摄与剪辑" text={拍摄与剪辑}/>\n'
        '    <Shot start="0.0" end="5.0">硬切，固定机位，产品特写。网面跑鞋放在桌面上。</Shot>\n'
        "  </Storyboard>\n"
        '  <seedance:ReferenceVideo id="后半" model="sd2.5" prompt={后半分镜} duration="5" '
        'aspect-ratio="9:16"/>\n'
        "</icml>"
    )
    project = FILM.replace("</icml>", second)

    _, later = film_groups(checked(project), project)

    assert [(frame.label, frame.number) for frame in later.frames] == [
        ("网面跑鞋", 1),
        ("第 1 组镜头 1", 2),
    ]


def test_settings_and_shots_follow_the_video_prompt() -> None:
    made = group()

    assert [(item.kind, item.target, item.label, item.image) for item in made.settings] == [
        ("shooting", "value:拍摄与剪辑", None, None),
        ("element", "element:短发女生", "人物 短发女生", "短发女生参考图"),
        ("element", "element:网面跑鞋", "产品 网面跑鞋", "跑鞋照片"),
        ("element", "element:公园跑道", "场景 公园跑道", "公园跑道参考图"),
        ("voice", "voice:短发女生", "声音 短发女生", None),
        ("voice", "voice:旁白", "声音 旁白", None),
    ]
    person = made.settings[1].text
    assert BODY_SENTENCE not in person and person.startswith("东亚女性，二十出头；")
    first = made.shots[0]
    assert (first.target, first.start, first.end, first.view) == (
        "shot:全片分镜:1",
        0.0,
        2.5,
        "镜01机位图",
    )
    assert first.parts[0].endswith("她抬头看着镜头说：")
    assert first.parts[1] == " 音效：鞋底弹回时的一声轻响"
    assert [(line.target, line.role, line.text) for line in first.lines] == [
        ("line:lighter", "短发女生", "It's lighter than it looks.")
    ]
    assert made.shots[3].view is None
    assert made.speakers == ("短发女生", "旁白")


def test_a_body_with_a_comment_in_it_cannot_be_edited_on_the_page() -> None:
    project = FILM.replace(
        "左手腕戴一块白色运动手表</Element>", "左手腕戴一块白色运动手表<!-- 待定 --></Element>"
    )

    person = group(project).settings[1]

    assert (person.label, person.target) == ("人物 短发女生", None)
    with pytest.raises(FilmEditRejected, match="找不到了"):
        edit_text(project, checked(project), [FilmTextEdit("element:短发女生", text="东亚女性")])


def test_shot_text_is_written_in_place_and_nothing_else_moves() -> None:
    parts = ("开场，手持。她把 {鞋} 举到 <镜头> 前 & 笑：", " 音效：轻响")

    updated = edit_text(FILM, checked(), [shot(1, parts, LIGHTER)])

    (removed, added) = changed_lines(FILM, updated)
    assert removed.startswith(
        '-    <Shot start="0.0" end="2.5" view={镜01机位图.image}>开场，手持，'
    )
    assert added == (
        '+    <Shot start="0.0" end="2.5" view={镜01机位图.image}>'
        "开场，手持。她把 ｛鞋｝ 举到 &lt;镜头&gt; 前 &amp; 笑：{lighter} 音效：轻响</Shot>"
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


def test_a_single_line_written_on_its_own_line_stays_there() -> None:
    project = FILM.replace(
        '<Line id="miles" role="短发女生">Five miles, and my feet don\'t hurt.</Line>',
        '<Line id="miles" role="短发女生">\n      Five miles, and my feet don\'t hurt.\n    </Line>',
    )

    miles = FilmLineEdit("line:miles", "短发女生", "Six miles!")

    updated = edit_text(project, checked(project), [shot(3, parts_of(3, project), miles)])

    assert changed_lines(project, updated) == [
        "-      Five miles, and my feet don't hurt.",
        "+      Six miles!",
    ]


def test_the_english_body_sentence_stays_with_the_person() -> None:
    typed = "东亚女性，二十出头；黑色短发。上身穿浅灰色T恤"

    updated = edit_text(FILM, checked(), [FilmTextEdit("element:短发女生", text=typed)])

    person = load_project(updated).nodes["短发女生"].text
    assert person == f"东亚女性，二十出头；黑色短发。{BODY_SENTENCE} 上身穿浅灰色T恤"
    assert for_video(person) == typed
    assert group(updated).settings[1].text == typed


def test_a_line_and_a_voice_are_rewritten_where_they_are_written() -> None:
    lighter = FilmLineEdit("line:lighter", "短发女生", "Lighter than it looks!")

    updated = edit_text(
        FILM,
        checked(),
        [shot(1, parts_of(1), lighter), FilmTextEdit("voice:旁白", text="成熟男性的中低音。")],
    )

    assert changed_lines(FILM, updated) == [
        '-  <Voice role="旁白">成熟男性圆润厚实的中低音。清晰松弛的英式英语，不紧不慢，像坐在对面'
        "认真地跟你讲他的判断。</Voice>",
        '+  <Voice role="旁白">成熟男性的中低音。</Voice>',
        '-    <Line id="lighter" role="短发女生">It\'s lighter than it looks.</Line>',
        '+    <Line id="lighter" role="短发女生">Lighter than it looks!</Line>',
    ]


def test_a_line_left_out_of_a_shot_is_removed_from_the_script() -> None:
    before, after = parts_of(1)

    updated = edit_text(FILM, checked(), [shot(1, (before + "她笑了。" + after,))])

    removed = [line for line in changed_lines(FILM, updated) if line.startswith("-")]
    assert (
        removed[0] == '-    <Line id="lighter" role="短发女生">It\'s lighter than it looks.</Line>'
    )
    assert "lighter" not in load_project(updated).nodes
    assert group(updated).shots[0].lines == ()


def test_new_lines_take_their_place_in_the_script_by_shot_order() -> None:
    first = parts_of(1)
    second = parts_of(2)
    opener = FilmLineEdit(None, "旁白", "今天试一双新鞋。")
    extra = FilmLineEdit(None, "短发女生", "Feels like {nothing}!")

    updated = edit_text(
        FILM,
        checked(),
        [
            shot(1, ("开场。", first[0], first[1]), opener, LIGHTER),
            shot(2, (second[0], " 她笑了：", second[1]), REBOUND, extra),
        ],
    )

    script = [line.attrs["id"] for line in load_project(updated).find("Line")]
    assert script == ["台词1", "lighter", "rebound", "台词2", "miles", "shop"]
    assert '    <Line id="台词2" role="短发女生">Feels like ｛nothing｝!</Line>' in updated
    made = group(updated)
    assert [(line.target, line.role) for line in made.shots[1].lines] == [
        ("line:rebound", "旁白"),
        ("line:台词2", "短发女生"),
    ]
    assert "旁白" in made.speakers


def test_changing_the_speaker_rewrites_only_the_role() -> None:
    narrator = FilmLineEdit("line:lighter", "旁白", LIGHTER.text)

    updated = edit_text(FILM, checked(), [shot(1, parts_of(1), narrator)])

    assert changed_lines(FILM, updated) == [
        '-    <Line id="lighter" role="短发女生">It\'s lighter than it looks.</Line>',
        '+    <Line id="lighter" role="旁白">It\'s lighter than it looks.</Line>',
    ]


def test_the_script_goes_with_its_last_line_and_comes_back_with_a_new_one() -> None:
    made = group()
    silent = [shot(n, ("".join(item.parts),)) for n, item in enumerate(made.shots, start=1)]

    quiet = edit_text(FILM, checked(), silent)

    assert "<Script>" not in quiet and "<Line" not in quiet
    last = parts_of(4, quiet)
    spoken = edit_text(
        quiet, checked(quiet), [shot(4, (last[0], ""), FilmLineEdit(None, "旁白", "周末前下单。"))]
    )
    assert changed_lines(quiet, spoken)[:4] == [
        "+",
        "+  <Script>",
        '+    <Line id="台词1" role="旁白">周末前下单。</Line>',
        "+  </Script>",
    ]
    assert group(spoken).shots[3].lines[0].text == "周末前下单。"


def test_lines_keep_their_order() -> None:
    project = FILM.replace(
        "笑着对镜头说：{miles} 音效：连续的脚步声",
        "笑着对镜头说：{miles} 旁白：{shop} 音效：脚步声",
    ).replace("拿起左脚那只鞋。旁白：{shop}", "拿起左脚那只鞋。")
    miles, shop = (
        FilmLineEdit(line.target, line.role, line.text) for line in group(project).shots[2].lines
    )

    with pytest.raises(FilmEditRejected, match="台词的先后不能调"):
        edit_text(project, checked(project), [shot(3, ("a", "b", "c"), shop, miles)])


def test_a_shot_whose_line_cannot_be_rewritten_is_not_offered() -> None:
    project = FILM.replace(
        "It's lighter than it looks.</Line>", "It's lighter.<!-- 待定 --></Line>"
    )

    assert group(project).shots[0].target is None


@pytest.mark.parametrize(
    ("edits", "message"),
    [
        ([shot(1, ("只剩一段",), LIGHTER)], "文字和台词对不上"),
        ([FilmTextEdit("shot:全片分镜:1", parts=("x", "y"))], "文字和台词对不上"),
        ([shot(1, (" ", ""), LIGHTER)], "镜头的文字不能是空的"),
        ([shot(1, ("x", ""), FilmLineEdit("line:lighter", "短发女生", "  "))], "台词不能是空的"),
        ([shot(1, ("x", ""), FilmLineEdit(None, "公园跑道", "嗨"))], "「公园跑道」不能在这组"),
        ([shot(1, ("x", ""), FilmLineEdit("line:miles", "短发女生", "a"))], "这句台词找不到了"),
        ([shot(1, ("x", "", ""), LIGHTER, LIGHTER)], "这句台词找不到了"),
        ([FilmTextEdit("voice:旁白", text="")], "这段字不能是空的"),
        ([shot(1, ("看 @Image1", ""), LIGHTER)], "不能写 @Image"),
        ([shot(9, ("x", ""), LIGHTER)], "找不到了"),
        ([FilmTextEdit("line:lighter", text="x")], "找不到了"),
        ([FilmTextEdit("element:拍摄", text="x")], "找不到了"),
        (
            [FilmTextEdit("voice:旁白", text="a"), FilmTextEdit("voice:旁白", text="b")],
            "一次只改一处",
        ),
        ([], "没有要改的字"),
        (
            [FilmTextEdit("element:网面跑鞋", text="浅蓝色" * 1400)],
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


def test_clearing_a_choice_goes_back_to_the_latest_generation() -> None:
    change = choose_image(checked(), FILM, RUN, "短发女生参考图", None)

    assert change is not None
    assert changed_lines(RUN, change[1]) == [
        '-  <use output="短发女生参考图.image" image={短发女生修过手}/>'
    ]
    film = checked(FILM, change[1])
    film.generated["短发女生参考图"] = "https://cdn.test/latest.png"
    assert film.image_url("短发女生参考图.image") == "https://cdn.test/latest.png"


def test_nothing_is_written_when_the_image_is_already_the_one_in_use() -> None:
    film = checked()

    assert choose_image(film, FILM, RUN, "短发女生参考图", PERSON_FIXED) is None
    assert choose_image(film, FILM, RUN, "公园跑道参考图", None) is None
    assert choose_image(film, FILM, RUN, "跑鞋照片", SHOE_PHOTO) is None


def test_the_first_choice_creates_the_run_file() -> None:
    change = choose_image(checked(FILM, None), FILM, None, "镜01机位图", VIEW_ONE)

    assert change is not None and change[0] == RUN_PATH
    film = checked(FILM, change[1])
    assert film.selected == {"镜01机位图": "镜01机位图-1"}
    assert film.image_url("镜01机位图.image") == VIEW_ONE


def test_a_given_photo_gets_its_new_address_in_the_project_file() -> None:
    url = "https://cdn.test/new-shoe.jpg?size=2&crop=1"

    change = choose_image(checked(), FILM, RUN, "跑鞋照片", url)

    assert change is not None and change[0] == FILM_PATH
    assert changed_lines(FILM, change[1])[1] == (
        '+  <media:Image id="跑鞋照片" src="https://cdn.test/new-shoe.jpg?size=2&amp;crop=1"/>'
    )
    assert checked(change[1]).image_url("跑鞋照片") == url


@pytest.mark.parametrize(
    ("image", "url", "message"),
    [
        ("跑鞋照片", None, "不能清空"),
        ("短发女生", "https://cdn.test/x.png", "找不到这张图"),
        ("没有这个", "https://cdn.test/x.png", "找不到这张图"),
    ],
)
def test_a_choice_that_does_not_fit_the_image_is_refused(
    image: str, url: str | None, message: str
) -> None:
    with pytest.raises(FilmEditRejected, match=message):
        choose_image(checked(), FILM, RUN, image, url)
