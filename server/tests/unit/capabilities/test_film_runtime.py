"""验证工程文件与运行文件的运行时：检查规则、取图、拼提示词与导出分镜。"""

from __future__ import annotations

import json

import pytest

from iclip.capabilities.iclip_studio.film.checks import (
    check,
    check_project_content,
    check_run_content,
)
from iclip.capabilities.iclip_studio.film.export import NothingToExport, export_shots, image_status
from iclip.capabilities.iclip_studio.film.film import Film
from iclip.capabilities.iclip_studio.film.packages import (
    GPT_IMAGE_ASPECTS,
    GPT_IMAGE_MODEL,
    GPT_IMAGE_RESOLUTIONS,
    IMAGE_MAX_REFERENCES,
    PROMPT_MAX_CHARS,
    VIDEO_MAX_REFERENCES,
)
from iclip.capabilities.iclip_studio.film.prompts import render_picture, render_storyboard
from iclip.capabilities.shot_document import validate_shots_document
from iclip.common.shot_prompt import format_shot_prompt
from iclip.common.shot_rules import MAX_REFERENCE_IMAGES
from iclip.domains.generation import schemas as generation
from iclip.domains.generation.gpt_image import GPT_IMAGE_2_5
from tests.helpers.film import (
    FILM,
    PERSON_FIRST,
    PERSON_FIXED,
    RUN,
    SHOE_PHOTO,
    VIEW_ONE,
    two_requests,
)

FIRST_CAST = "<Cast element={网面跑鞋} image={跑鞋照片}/>"
STORYBOARD_CAST = (
    "    <Cast element={短发女生} image={短发女生参考图.image}/>\n"
    "    <Cast element={网面跑鞋} image={跑鞋照片}/>\n"
    "    <Cast element={公园跑道} image={公园跑道参考图.image}/>\n"
    '    <Block name="拍摄与剪辑"'
)
USE_PERSON = '<use output="短发女生参考图.image" image={短发女生修过手}/>'
BODY_SENTENCE = (
    "She has a slim, well-proportioned figure, very broad shoulders and excellent "
    "head-to-shoulder proportions. "
)


def checked(project: str = FILM, run: str | None = RUN) -> Film:
    film = check(project, run)
    assert isinstance(film, Film)
    return film


def problems(project: str = FILM, run: str | None = RUN) -> list[str]:
    film = check(project, run)
    return film if isinstance(film, list) else film.errors


def changed(source: str, old: str, new: str) -> str:
    assert old in source, old
    return source.replace(old, new, 1)


def test_the_sample_passes_with_and_without_a_run_file() -> None:
    assert problems() == []
    assert problems(run=None) == []


PROJECT_FAULTS = [
    pytest.param('<Element id="公园跑道"', '<Elemnt id="公园跑道"', "写法错误", id="标签没闭合对"),
    pytest.param(
        '  <import as="gpt" from="@iclip/gpt-image@1"/>\n',
        "",
        "不认识的标签 gpt:Image",
        id="没 import 的包",
    ),
    pytest.param(
        FIRST_CAST,
        "<Cast element={跑鞋照片} image={跑鞋照片}/>",
        "element 要「出场元素」，{跑鞋照片} 是「图」",
        id="类型不对",
    ),
    pytest.param(
        "view={镜02机位图.image}",
        "view={镜09机位图.image}",
        "{镜09机位图.image} 在这之前没有定义",
        id="引用不存在",
    ),
    pytest.param(
        "<Reference image={镜01机位图.image}>",
        "<Reference image={镜01机位图}>",
        "gpt:Image 的输出是 {镜01机位图.image}",
        id="输出路径写错",
    ),
    pytest.param(
        '<Block name="拍摄与剪辑" text={拍摄与剪辑}/>',
        '<Block name="拍摄与剪辑" text="{拍摄与剪辑}"/>',
        "text 要写引用",
        id="引用加了引号",
    ),
    pytest.param(
        "<Reference image={镜01机位图.image}>",
        "<Reference image={镜02机位图.image}>",
        "{镜02机位图.image} 在这之前没有定义",
        id="先用后定义",
    ),
    pytest.param(
        '<Line id="miles" role="短发女生">',
        '<Line id="miles" role="主播">',
        "说话人 主播 没有同名的 Voice",
        id="说话人没有声音",
    ),
    pytest.param(
        "笑着对镜头说：{miles}", "笑着看镜头。", "台词 miles 没有被任何镜头引用", id="台词没被引用"
    ),
    pytest.param(
        "旁白：{rebound}",
        "旁白：{lighter} {rebound}",
        "台词 lighter 被引用了不止一次",
        id="台词引用两次",
    ),
    pytest.param(
        "说：{lighter}",
        "说：{It's lighter than it looks.}",
        "不是台词的名字",
        id="花括号里写了台词原文",
    ),
    pytest.param(
        '<Shot start="2.5" end="6.0"',
        '<Shot start="2.6" end="6.0"',
        "镜头从 2.6 开始，没接上上一个的结束 2.5",
        id="镜头没接上",
    ),
    pytest.param(
        '<Shot start="0.0" end="2.5"',
        '<Shot start="1.0" end="2.5"',
        "每个 Storyboard 的第一个镜头从 0.0 开始",
        id="第一镜不从零开始",
    ),
    pytest.param(
        STORYBOARD_CAST,
        STORYBOARD_CAST.replace(
            "    <Cast element={公园跑道} image={公园跑道参考图.image}/>\n", ""
        ),
        "镜头正文里出现了「公园跑道」，但没有 Cast",
        id="镜头里的元素没 Cast",
    ),
    pytest.param(
        STORYBOARD_CAST,
        STORYBOARD_CAST.replace(
            "    <Cast element={短发女生} image={短发女生参考图.image}/>\n", ""
        ),
        "说话的 短发女生 没有 Cast",
        id="说话的人没 Cast",
    ),
    pytest.param(
        '<gpt:Image id="镜01机位图" prompt={镜01机位图提示词} aspect-ratio="9:16"',
        '<gpt:Image id="镜01机位图" prompt={镜01机位图提示词} aspect-ratio="16:9"',
        "机位图 镜01机位图 的画幅是 16:9，视频是 9:16",
        id="机位图画幅和视频不同",
    ),
    pytest.param('duration="15"', 'duration="14"', "这组镜头是 15 秒", id="时长对不上"),
    pytest.param(
        'aspect-ratio="3:4" resolution="2k"',
        'aspect-ratio="3:4" resolution="1k"',
        "resolution 只能是 2k",
        id="没开放的分辨率",
    ),
    pytest.param(
        'aspect-ratio="3:4" resolution="2k"',
        'aspect-ratio="9:21" resolution="2k"',
        "aspect-ratio 只能是",
        id="没有的画幅",
    ),
    pytest.param(
        '<Element id="网面跑鞋" type="产品">',
        '<Element id="网面跑鞋" kind="产品">',
        "Element 没有属性 kind",
        id="没有的属性",
    ),
    pytest.param(
        'aspect-ratio="3:4" resolution="2k"/>',
        'aspect-ratio="3:4" resolution="2k" use="2"/>',
        "gpt:Image 没有属性 use",
        id="把结果写进了工程文件",
    ),
    pytest.param(
        '<Picture id="镜02机位图提示词">',
        '<Picture id="镜02机位图提示词" template="画面-v1">',
        "Picture 没有属性 template",
        id="写了模板属性",
    ),
    pytest.param(
        '    <Block name="取景">全身入画。',
        '    <Block name="主体">一个女生。</Block>\n    <Block name="取景">全身入画。',
        "「主体」从 Cast 的出场元素取，不用写",
        id="写了主体块",
    ),
    pytest.param(BODY_SENTENCE, "身材匀称偏瘦；", "人物的身材要写成一句英文", id="身材没写成英文"),
    pytest.param("Light &amp; fast", "Light & fast", "写法错误", id="与号没转义"),
    pytest.param('<?icml using="@iclip/markup@1"?>\n', "", "第一行要写", id="没有文件头"),
    pytest.param(
        '    <Block name="取景">从跑道边平视过去，画面里没有人。</Block>\n',
        "",
        "缺「取景」一块",
        id="缺取景",
    ),
    pytest.param(
        '    <Block name="环境">摄影棚。她身后是一面浅灰色的墙，脚下是同色的地面。</Block>\n',
        "",
        "没有 Cast 场景时，要写「环境」一块",
        id="没有场景也没写环境",
    ),
    pytest.param(
        '<Block name="取景">从跑道边平视过去，画面里没有人。</Block>',
        '<Block name="构图">从跑道边平视过去，画面里没有人。</Block>',
        "Picture 没有「构图」这一块",
        id="没有的块",
    ),
    pytest.param(
        '<text:Value id="拍摄">', '<text:Value id="配乐">', "名字 配乐 重复", id="名字重复"
    ),
    pytest.param('model="sd2.5"', 'model="sd2.0"', "model 只能是 sd2.5", id="没开放的模型版本"),
    pytest.param(
        'aspect-ratio="3:4"', "aspect-ratio={拍摄}", "是普通值，要加引号", id="普通值写成引用"
    ),
    pytest.param(
        ">同一场戏的上一个机位，跑道和光线与它保持一致。</Reference>",
        "></Reference>",
        "Reference 的正文要写这张图用来做什么",
        id="Reference 没写用途",
    ),
    pytest.param(
        "左手腕戴一块白色运动手表</Element>",
        "左手腕戴一块白色运动手表（假设）</Element>",
        "「（假设）」不抄进来",
        id="把假设抄进来了",
    ),
    pytest.param(
        FIRST_CAST,
        FIRST_CAST + "<Cast element={网面跑鞋}/>",
        "同一个出场元素只 Cast 一次",
        id="同一元素 Cast 两次",
    ),
    pytest.param(
        "prompt={镜01机位图提示词} aspect-ratio",
        "prompt={全片分镜提示} aspect-ratio",
        "{全片分镜提示} 在这之前没有定义",
        id="生图节点引用了不存在的提示词",
    ),
]


@pytest.mark.parametrize(("old", "new", "expected"), PROJECT_FAULTS)
def test_one_fault_in_the_project_file_is_reported(old: str, new: str, expected: str) -> None:
    found = problems(changed(FILM, old, new))

    assert any(expected in problem for problem in found), found
    assert all(problem.startswith("film.icml") for problem in found)


def test_lines_must_be_spoken_in_script_order() -> None:
    swapped = (
        FILM.replace("说：{lighter}", "说：{TEMP}")
        .replace("旁白：{rebound}", "旁白：{lighter}")
        .replace("说：{TEMP}", "说：{rebound}")
    )

    assert any("顺序不一致" in problem for problem in problems(swapped))


def test_an_image_node_must_take_a_picture_and_a_video_node_a_storyboard() -> None:
    mixed = changed(
        FILM,
        '<seedance:ReferenceVideo id="全片" model="sd2.5" prompt={全片分镜}',
        '<seedance:ReferenceVideo id="全片" model="sd2.5" prompt={镜01机位图提示词}',
    )

    assert any("prompt 要写 Storyboard 的名字" in problem for problem in problems(mixed))


def test_a_problem_names_the_line_it_is_on() -> None:
    broken = changed(
        FILM, '<Element id="网面跑鞋" type="产品">', '<Element id="网面跑鞋" type="鞋">'
    )
    line = broken[: broken.index('type="鞋"')].count("\n") + 1

    assert problems(broken)[0].startswith(f"film.icml 第 {line} 行：type 只能是")


RUN_FAULTS = [
    pytest.param(
        'output="短发女生参考图.image"',
        'output="短发女生定妆图.image"',
        "output 要写 film.icml 里生图节点的输出",
        id="选用的节点不存在",
    ),
    pytest.param(
        'output="短发女生参考图.image"',
        'output="跑鞋照片"',
        "output 要写 film.icml 里生图节点的输出",
        id="选用到用户给的图上",
    ),
    pytest.param(
        'output="短发女生参考图.image"',
        'output="全片.video"',
        "output 要写 film.icml 里生图节点的输出",
        id="选用到视频上",
    ),
    pytest.param(
        "image={短发女生修过手}",
        "image={短发女生第三版}",
        "{短发女生第三版} 在这之前没有定义",
        id="引用的图没登记",
    ),
    pytest.param(
        "image={短发女生修过手}",
        f'image="{PERSON_FIXED}"',
        "image 要写引用",
        id="选用里直接写了地址",
    ),
    pytest.param(
        USE_PERSON,
        USE_PERSON + "\n  " + USE_PERSON.replace("修过手", "第一版"),
        "短发女生参考图 选用了两次",
        id="同一个节点选用两次",
    ),
    pytest.param(
        'id="短发女生修过手"', 'id="短发女生第一版"', "名字 短发女生第一版 重复", id="登记名重复"
    ),
    pytest.param(
        f'  <media:Image id="短发女生修过手" src="{PERSON_FIXED}"/>\n',
        "",
        "{短发女生修过手} 在这之前没有定义",
        id="先选用后登记",
    ),
    pytest.param('  <film source="./film.icml"/>\n', "", "第一个标签要写", id="缺 film 一行"),
    pytest.param(
        'source="./film.icml"', 'source="./other.icml"', "第一个标签要写", id="指到别的工程文件"
    ),
    pytest.param(
        "@iclip/run-markup@1",
        "@iclip/markup@1",
        "只认 @iclip/run-markup@1 的 <icrun>",
        id="文件头写成了工程文件的",
    ),
    pytest.param(
        '<import as="media" from="@iclip/media@1"/>',
        '<import as="media" from="@iclip/media@1"/><import as="gpt" from="@iclip/gpt-image@1"/>',
        "没有这个包：@iclip/gpt-image@1",
        id="引入了运行文件不能用的包",
    ),
    pytest.param(
        USE_PERSON, USE_PERSON.replace("/>", ' job="3f2a"/>'), "use 没有属性 job", id="没有的属性"
    ),
    pytest.param('<icrun version="1">', '<icrun version="2">', "根标签要写", id="版本不对"),
]


@pytest.mark.parametrize(("old", "new", "expected"), RUN_FAULTS)
def test_one_fault_in_the_run_file_is_reported(old: str, new: str, expected: str) -> None:
    found = problems(run=changed(RUN, old, new))

    assert any(expected in problem for problem in found), found
    assert all(problem.startswith("film.icrun") for problem in found)


def test_registered_images_that_are_not_selected_are_kept_as_alternatives() -> None:
    film = checked(run=changed(RUN, "  " + USE_PERSON + "\n", ""))

    assert film.errors == []
    assert [(item.name, item.url) for item in image_status(film)] == [
        ("短发女生参考图", None),
        ("公园跑道参考图", None),
        ("镜01机位图", VIEW_ONE),
        ("镜02机位图", None),
    ]


def test_a_node_without_a_selection_uses_its_latest_generated_image() -> None:
    film = checked(run=None)
    film.generated["镜01机位图"] = "https://cdn.test/generated-view.png"

    status = {item.name: (item.source, item.url) for item in image_status(film)}
    assert status["镜01机位图"] == ("最近一次生成", "https://cdn.test/generated-view.png")
    assert status["镜02机位图"] == ("还没有图", None)
    _, shots, images = storyboard(film)
    assert shots[0].startswith("@Image2 的机位。")
    assert images == (SHOE_PHOTO, "https://cdn.test/generated-view.png")


def test_a_selection_in_the_run_file_wins_over_the_latest_generated_image() -> None:
    film = checked()
    film.generated["短发女生参考图"] = "https://cdn.test/newer.png"

    assert image_status(film)[0].url == PERSON_FIXED


def test_a_node_uses_the_registered_image_selected_for_it() -> None:
    selected = image_status(checked())
    switched = image_status(
        checked(run=RUN.replace("image={短发女生修过手}", "image={短发女生第一版}"))
    )

    assert (selected[0].name, selected[0].url) == ("短发女生参考图", PERSON_FIXED)
    assert "短发女生修过手" in selected[0].source
    assert switched[0].url == PERSON_FIRST


def picture(film: Film, name: str) -> tuple[list[str], tuple[str, ...]]:
    prompt = render_picture(film, film.project.nodes[name])
    return prompt.text.split("\n\n"), prompt.image_urls


def test_a_picture_is_four_paragraphs_then_its_references() -> None:
    paragraphs, images = picture(checked(), "镜02机位图提示词")

    capture, subject, framing, setting, references = paragraphs
    assert capture.startswith("画面是用手机实拍的") and "光线是清晨的自然光" in capture
    assert subject.startswith("图1 的人物，东亚女性") and "图2 的产品，一双低帮跑步鞋" in subject
    assert "head-to-shoulder proportions." in subject
    assert framing.startswith("低机位，脚部特写")
    # 公园跑道参考图还没有图：这个元素只有描述，不占编号。
    assert setting.startswith("城市社区公园里的一条红色塑胶跑道")
    assert references == "图3：同一场戏的上一个机位，跑道和光线与它保持一致。"
    assert images == (PERSON_FIXED, SHOE_PHOTO, VIEW_ONE)


def test_an_image_that_does_not_exist_yet_counts_as_not_written() -> None:
    paragraphs, images = picture(checked(run=None), "镜02机位图提示词")

    assert len(paragraphs) == 4, "引用的机位图还没有图时，Reference 那一行不写"
    assert paragraphs[1].startswith("东亚女性") and "图1 的产品" in paragraphs[1]
    assert images == (SHOE_PHOTO,)


def test_a_picture_without_cast_people_has_no_subject_paragraph() -> None:
    paragraphs, images = picture(checked(), "公园跑道参考图提示词")

    assert [part[:6] for part in paragraphs] == ["画面是用手机", "从跑道边平视", "城市社区公园"]
    assert images == ()


def storyboard(film: Film) -> tuple[list[str], list[str], tuple[str, ...]]:
    group = render_storyboard(film, film.project.nodes["全片分镜"])
    return (
        group.global_settings.split("\n"),
        [cut.prompt for cut in group.timeline],
        group.image_urls,
    )


def test_the_video_prompt_defines_every_element_once_and_shots_only_use_names() -> None:
    settings, shots, images = storyboard(checked())

    assert settings[:3] == [
        "摄影：手机拍摄，手持跟拍，带轻微呼吸感；景别以中近景和鞋部特写为主。",
        "剪辑：全片硬切，快节奏，平均每镜三到四秒，在动作点上剪。",
        "影调：清晨自然光，低对比，不做风格化调色。",
    ]
    assert settings[3].startswith("人物 短发女生：@Image1，东亚女性")
    assert settings[4].startswith("产品 网面跑鞋：@Image2，一双低帮跑步鞋")
    assert settings[5].startswith("场景 公园跑道：城市社区公园里")
    assert [line.split("：")[0] for line in settings[6:]] == ["声音 短发女生", "声音 旁白"]
    assert shots[0].startswith("@Image3 的机位。开场，手持")
    assert "{It's lighter than it looks.}" in shots[0]
    assert shots[1].startswith("硬切，手持，低机位"), "镜02机位图还没有图，这一镜没有机位那句"
    assert "{Light & fast — grab yours before the weekend.}" in shots[3]
    assert images == (PERSON_FIXED, SHOE_PHOTO, VIEW_ONE)


def test_the_body_sentence_is_for_pictures_only() -> None:
    settings, _, _ = storyboard(checked())

    assert "head-to-shoulder" not in "\n".join(settings)
    assert "中分。上身穿浅灰色速干短袖T恤" in settings[3]


def test_without_images_the_video_prompt_falls_back_to_text() -> None:
    settings, shots, images = storyboard(checked(run=None))

    assert settings[3].startswith("人物 短发女生：东亚女性")
    assert settings[4].startswith("产品 网面跑鞋：@Image1，")
    assert shots[0].startswith("开场，手持")
    assert images == (SHOE_PHOTO,)


def test_export_copies_shot_times_and_carries_the_model() -> None:
    document = export_shots(checked())

    (row,) = document.shots
    assert document.aspect_ratio == "9:16"
    assert (row.index, row.model, row.seconds) == (1, "mmt-seedance-2-5", 15)
    assert [item.timestamps for item in row.prompt.timeline] == [
        [0.0, 2.5],
        [2.5, 6.0],
        [6.0, 10.0],
        [10.0, 15.0],
    ]
    assert [item.image_indexes for item in row.prompt.timeline] == [[3], [], [], []]
    assert row.image_urls == [PERSON_FIXED, SHOE_PHOTO, VIEW_ONE]
    validate_shots_document(document.file_text())
    assert json.loads(document.file_text())["shots"][0]["model"] == "mmt-seedance-2-5"


def test_a_long_film_is_split_in_the_project_file_and_each_request_starts_at_zero() -> None:
    document = export_shots(checked(two_requests()))

    first, second = document.shots
    assert (first.seconds, second.seconds) == (20, 16)
    assert second.prompt.timeline[0].timestamps == [0.0, 16.0]
    assert second.image_urls == [SHOE_PHOTO]
    validate_shots_document(document.file_text())


def test_a_second_request_written_in_film_time_is_rejected() -> None:
    in_film_time = two_requests().replace('start="0.0" end="16.0"', 'start="20.0" end="36.0"')

    assert any(
        "第一个镜头从 0.0 开始，写的是 20.0" in problem for problem in problems(in_film_time)
    )


def test_a_project_without_a_video_node_has_nothing_to_export() -> None:
    start = FILM.index("  <Storyboard")
    images_only = FILM[:start] + "</icml>\n"
    # 去掉了镜头，台词就没人说了：连脚本一起去掉。
    script = images_only[images_only.index("  <Script>") : images_only.index("</Script>") + 10]
    film = checked(images_only.replace(script, ""), None)

    assert film.errors == []
    with pytest.raises(NothingToExport):
        export_shots(film)


def test_limits_are_counted_as_if_every_written_image_existed() -> None:
    crowded = changed(
        FILM,
        "    <Reference image={镜01机位图.image}>",
        "".join(
            f"    <Reference image={{镜01机位图.image}}>第 {n} 张。</Reference>\n" for n in range(8)
        )
        + "    <Reference image={镜01机位图.image}>",
    )

    assert any("参考图有 12 张，超过 10 张" in problem for problem in problems(crowded, None))


def test_the_assembled_video_prompt_is_what_the_storyboard_page_sends() -> None:
    film = checked()
    group = render_storyboard(film, film.project.nodes["全片分镜"])

    text = format_shot_prompt(group)

    assert text.splitlines()[-1] == "不要生成字幕，不要生成背景音乐。"
    assert "[0–2.5秒｜镜头1] @Image3 的机位。" in text
    assert len(text) <= PROMPT_MAX_CHARS


def test_package_limits_match_the_generation_domain() -> None:
    assert IMAGE_MAX_REFERENCES == generation.IMAGE_MAX_REFERENCES
    assert PROMPT_MAX_CHARS == generation.MAX_PROMPT_CHARS
    assert VIDEO_MAX_REFERENCES == MAX_REFERENCE_IMAGES


def test_the_image_package_offers_exactly_what_the_image_model_declares() -> None:
    """文件里能写的画幅和分辨率照生成域里这家模型的声明；这里不能引它，所以用这条测试钉住。"""

    assert GPT_IMAGE_2_5.name == GPT_IMAGE_MODEL
    assert set(GPT_IMAGE_ASPECTS) == set(GPT_IMAGE_2_5.spec.aspect_ratios)
    assert GPT_IMAGE_2_5.spec.resolutions == GPT_IMAGE_RESOLUTIONS


def test_saving_the_project_file_checks_that_file_alone() -> None:
    assert check_project_content(FILM) == []
    assert (
        "Element 没有属性 kind"
        in check_project_content(
            changed(
                FILM, '<Element id="网面跑鞋" type="产品">', '<Element id="网面跑鞋" kind="产品">'
            )
        )[0]
    )
    assert "写法错误" in check_project_content('<?icml using="@iclip/markup@1"?>\n<icml>')[0]


def test_saving_the_run_file_checks_that_file_alone() -> None:
    assert check_run_content(RUN) == []
    # 选用的节点存不存在要对照工程文件，保存时不查。
    assert check_run_content(RUN.replace("短发女生参考图.image", "不存在的节点.image")) == []
    assert (
        "在这之前没有定义"
        in check_run_content(RUN.replace("image={短发女生修过手}", "image={没登记}"))[0]
    )
