"""验证工程文件与运行文件的运行时：检查规则、取图、拼提示词与出片请求。"""

from __future__ import annotations

import pytest

from iclip.capabilities.iclip_studio.film.checks import (
    check,
    check_project_content,
    check_run_content,
)
from iclip.capabilities.iclip_studio.film.film import Film, image_status
from iclip.capabilities.iclip_studio.film.packages import (
    GPT_IMAGE_ASPECTS,
    GPT_IMAGE_MODEL,
    GPT_IMAGE_RESOLUTIONS,
    IMAGE_MAX_REFERENCES,
    PROMPT_MAX_CHARS,
    VIDEO_MAX_REFERENCES,
)
from iclip.capabilities.iclip_studio.film.prompts import (
    render_picture,
    render_video,
    video_row,
)
from iclip.capabilities.shot_document import VideoShotDocumentRow
from iclip.common.shot_prompt import format_shot_prompt
from iclip.common.shot_rules import MAX_REFERENCE_IMAGES
from iclip.domains.generation import schemas as generation
from iclip.domains.generation.gpt_image import GPT_IMAGE_2_5
from tests.helpers.film import (
    FILM,
    IMAGE_NODES,
    PERSON_FIRST,
    PERSON_FIXED,
    RUN,
    SHOE_FRONT,
    SHOE_SOLE,
    VIEW_ONE,
    expected_prompt,
    two_requests,
)

USE_PERSON = '<use output="短发女生参考图.image" image={短发女生修过手}/>'
MISSING = ("短发女生参考图", "镜02机位图")
"""规格第 13.3 节的情况：这两张还没有图。"""

_SCRIPT_BLOCK = FILM[
    FILM.index('  <script id="原版台词">') : FILM.index("  </script>\n") + len("  </script>\n")
]
"""示例里的整份剧本，连同缩进和末尾的换行。"""


def checked(project: str = FILM, run: str | None = RUN) -> Film:
    film = check(project, run)
    assert isinstance(film, Film) and film.errors == [], film
    return film


def problems(project: str = FILM, run: str | None = RUN) -> list[str]:
    film = check(project, run)
    return film if isinstance(film, list) else film.errors


def changed(source: str, old: str, new: str) -> str:
    assert old in source, old
    return source.replace(old, new, 1)


def line_of(source: str, anchor: str) -> int:
    return source.count("\n", 0, source.index(anchor)) + 1


def test_the_sample_passes_with_and_without_a_run_file() -> None:
    assert problems() == []
    assert problems(run=None) == []


def fault(
    old: str,
    new: str,
    message: str,
    *,
    anchor: str | None = None,
    also: tuple[tuple[str, str], ...] = (),
    id: str,
) -> object:
    """一处错：把 ``old`` 换成 ``new``（``also`` 里的几处一起换），``anchor`` 所在的那一行报出
    ``message``；不给 ``anchor`` 时就是 ``new`` 所在的那一行。"""

    return pytest.param((old, new), also, anchor or new, message, id=id)


SYNTAX_FAULTS = [
    fault(
        '<?icml using="@iclip/markup@1"?>\n',
        "",
        '第一行要写 <?icml using="@iclip/markup@1"?>',
        anchor="<icml>",
        id="没有文件头",
    ),
    fault(
        "<icml>\n",
        "<film>\n",
        "只认 @iclip/markup@1 的 <icml>",
        anchor="<?icml",
        also=(("</icml>", "</film>"),),
        id="根标签不对",
    ),
    fault(
        "\n\n  <!-- 出场元素",
        '\n  <import as="m2" from="@iclip/media@1"/>\n\n  <!-- 出场元素',
        "import 要写在最前面",
        anchor='<import as="m2"',
        id="import 没写在最前面",
    ),
    fault(
        "@iclip/director@2",
        "@iclip/director@1",
        "没有这个包：@iclip/director@1",
        anchor='<import as="film"',
        id="旧写法的包",
    ),
    fault(
        'source="@iclip/film-kits"',
        'source="@iclip/film-kit"',
        "没有这个模板包：@iclip/film-kit",
        anchor='<import as="kit"',
        id="没有的模板包",
    ),
    fault(
        '<import as="kit" source="@iclip/film-kits"/>',
        '<import as="kit" source="@iclip/film-kits" from="@iclip/text@1"/>',
        "import 里 from 和 source 只写一个",
        id="from 和 source 都写了",
    ),
    fault(
        '<import as="kit" source=',
        "<import source=",
        "用 source 引入的模板包要写 as",
        id="模板包没写 as",
    ),
    fault(
        '<import from="@iclip/script@1"/>',
        '<import as="s" from="@iclip/script@1"/>',
        "@iclip/script@1 不写 as",
        id="剧本包写了 as",
    ),
    fault(
        '<import as="media" from="@iclip/media@1"/>',
        '<import from="@iclip/media@1"/>',
        "@iclip/media@1 要写 as，给它的标签起前缀",
        id="标签包没写 as",
    ),
    fault(
        '<import as="seedance" from="@iclip/seedance@1"/>',
        '<import as="gpt" from="@iclip/seedance@1"/>',
        "标签 gpt:Reference 和前面引入的包重名",
        id="引入的标签重名",
    ),
    fault(
        '<text:Set name="场景" text={短发女生参考图场景}/>',
        '<text:Put name="场景" text={短发女生参考图场景}/>',
        "不认识的标签 text:Put（没有 import 它的包，或包里没有这个标签）",
        id="不认识的标签",
    ),
    fault(
        "<gpt:Reference image={跑鞋正面} for={网面跑鞋}/>",
        "<seedance:Reference image={跑鞋正面} for={网面跑鞋}/>",
        "seedance:Reference 不能写在这里",
        id="写错了位置",
    ),
    fault(
        'aspect-ratio="3:4" resolution="2k"/>',
        'aspect-ratio="3:4" resolution="2k" use="2"/>',
        "gpt:Image 没有属性 use",
        id="没有的属性",
    ),
    fault(
        ' aspect-ratio="3:4" resolution="2k"/>',
        ' aspect-ratio="3:4"/>',
        "gpt:Image 缺属性 resolution",
        anchor='<gpt:Image id="短发女生参考图"',
        id="缺必填属性",
    ),
    fault(
        '  <film:Shots id="全片镜头">\n',
        '  <film:Shots id="全片镜头"/>\n  <film:Shots id="别的镜头">\n',
        "film:Shots 下的 Shot 要 1–任意 个，写了 0 个",
        anchor='<film:Shots id="全片镜头"/>',
        id="子标签个数不够",
    ),
    fault(
        "<seedance:Reference image={跑鞋正面} for={网面跑鞋}/>",
        "<seedance:Reference image={跑鞋正面} for={网面跑鞋}>正面</seedance:Reference>",
        "seedance:Reference 不收正文",
        id="不收正文的写了正文",
    ),
    fault(
        '<text:Value id="镜04拍摄">',
        '<text:Value id="镜03拍摄">',
        "名字 镜03拍摄 重复",
        anchor='<text:Value id="镜03拍摄">鞋清楚',
        id="名字重复",
    ),
    fault(
        '<text:Value id="配乐">',
        '<text:Value id="配 乐">',
        "名字 配 乐 里有不能用的字符",
        id="名字里有空格",
    ),
    fault(
        '<text:Set name="拍摄" text={拍摄}/>',
        '<text:Set name="拍摄" text="{拍摄}"/>',
        "text 要写引用，如 text={名字}，不加引号",
        id="引用加了引号",
    ),
    fault(
        'aspect-ratio="3:4"',
        "aspect-ratio={拍摄}",
        "aspect-ratio 是普通值，要加引号，不能写引用",
        id="普通值写成引用",
    ),
    fault(
        'aspect-ratio="3:4" resolution="2k"',
        'aspect-ratio="3:4" resolution="1k"',
        "resolution 只能是 2k，写的是 1k",
        id="没开放的分辨率",
    ),
    fault('duration="15"', 'duration="15.0"', "duration 要写整数，写的是 15.0", id="时长不是整数"),
    fault(
        'start="2.5" end="6.0"',
        'start="2.50" end="6.0"',
        "start 要写秒数，带一位小数，写的是 2.50",
        id="秒数格式不对",
    ),
    fault(
        "<gpt:Reference image={镜01机位图.image}>跑道和光线",
        "<gpt:Reference image={镜03机位图.image}>跑道和光线",
        "{镜03机位图.image} 在这之前没有定义",
        id="先用后定义",
    ),
    fault(
        "<gpt:Reference image={镜01机位图.image}>跑道和光线",
        "<gpt:Reference image={镜01机位图}>跑道和光线",
        "{镜01机位图} 写法不对，gpt:Image 的输出是 {镜01机位图.image}",
        id="输出路径写错",
    ),
    fault(
        "<gpt:Reference image={短发女生参考图.image} for={短发女生}/>",
        "<gpt:Reference image={短发女生参考图.image} for={跑鞋正面}/>",
        "for 要「文字」，{跑鞋正面} 是「图」",
        id="类型不对",
    ),
    fault(
        '<text:Render id="镜04机位图提示词" template={kit.画面-v1}>',
        '<text:Render id="镜04机位图提示词" template={kit.画面-v2}>',
        "{kit.画面-v2} 不是模板包里的模板，可以写 {kit.画面-v1}、{kit.多镜头视频-v1}",
        id="没有的模板",
    ),
]

SCRIPT_FAULTS = [
    fault(
        "  <!-- 声音：一个说话人一段 -->",
        '  <script id="另一版">\n    <again><旁白>Again.</again>\n  </script>\n'
        "  <!-- 声音：一个说话人一段 -->",
        "一个文件最多写一份剧本",
        anchor='<script id="另一版">',
        id="两份剧本",
    ),
    fault(
        "<miles><短发女生>Five miles, and my feet don't hurt.</miles>",
        "<Miles><短发女生>Five miles, and my feet don't hurt.</Miles>",
        "段名 Miles 不对：小写英文字母开头，后面是小写英文字母、数字、- 和 _，最长 64 个字符",
        id="段名格式不对",
    ),
    fault(
        "<miles><短发女生>Five miles, and my feet don't hurt.</miles>",
        "<lighter><短发女生>Five miles, and my feet don't hurt.</lighter>",
        "段名 lighter 重复",
        id="段名重复",
    ),
    fault(
        "    <rebound>",
        "    旁白：\n    <rebound>",
        "剧本里段与段之间只能有空白和注释，一段写成 <段名>……</段名>",
        anchor="    旁白：\n",
        id="段外写了字",
    ),
    fault(
        "<lighter><短发女生>It's",
        "<lighter>It's",
        "段 lighter 开头要写说话人，如 <短发女生>",
        id="没写说话人",
    ),
    fault(
        "<lighter><短发女生>It's lighter than it looks.</lighter>",
        "<lighter><短发女生> </lighter>",
        "段 lighter 的台词是空的",
        id="台词是空的",
    ),
    fault(
        "Light &amp; fast",
        "Light & fast",
        "台词里的 & 要写成 &amp;",
        anchor="<shop>",
        id="与号没转义",
    ),
    fault(
        "It's lighter than it looks.</lighter>",
        "It's <旁白>lighter than it looks.</lighter>",
        "剧本里不支持一段里写第二个说话人",
        anchor="<lighter>",
        id="第二个说话人",
    ),
    fault(
        "It's lighter than it looks.</lighter>",
        "It's <lighter|莱特> than it looks.</lighter>",
        "剧本里不支持 <显示|读法> 的写法",
        anchor="<lighter>",
        id="显示和读法",
    ),
    fault(
        "It's lighter than it looks.</lighter>",
        "It's lighter | than it looks.</lighter>",
        "剧本里不支持单独的 |",
        anchor="<lighter>",
        id="单独的竖线",
    ),
    fault(
        "It's lighter than it looks.</lighter>",
        "It's lighter || than it looks.</lighter>",
        "剧本里不支持 ||",
        anchor="<lighter>",
        id="两条竖线",
    ),
    fault(
        "It's lighter than it looks.</lighter>",
        "It's @{weight} lighter than it looks.</lighter>",
        "剧本里不支持 @{…}",
        anchor="<lighter>",
        id="at 花括号",
    ),
    fault(
        "It's lighter than it looks.</lighter>",
        "It's {lighter} than it looks.</lighter>",
        "剧本里不支持花括号",
        anchor="<lighter>",
        id="花括号",
    ),
    fault(
        "<lighter><短发女生>It's lighter than it looks.</lighter>",
        "<lighter></lighter>",
        "剧本里不支持空的段",
        id="空的段",
    ),
]

TEMPLATE_FAULTS = [
    fault(
        '<text:Set name="取景" text={镜04取景}/>',
        '<text:Set name="构图" text={镜04取景}/>',
        "模板 画面-v1 没有「构图」这个槽，可以写 拍摄、主体、取景、场景",
        id="没有的槽",
    ),
    fault(
        '<text:Append name="主体" text={网面跑鞋}/>',
        '<text:Set name="主体" text={网面跑鞋}/>',
        "「主体」槽只 Set 一次，后面的用 Append",
        id="一个槽 Set 两次",
    ),
    fault(
        '    <text:Set name="取景" text={公园跑道参考图取景}/>\n',
        "",
        "模板 画面-v1 的「取景」槽必填，没有填",
        anchor='<text:Render id="公园跑道参考图提示词"',
        id="必填的槽没填",
    ),
    fault(
        '<text:Set name="场景" text={公园跑道}/>\n  </text:Render>\n  <gpt:Image id="镜04机位图"',
        '<text:Set name="场景" text={镜01机位图提示词}/>\n  </text:Render>\n'
        '  <gpt:Image id="镜04机位图"',
        "「场景」槽里填 text:Value，{镜01机位图提示词} 不是",
        anchor='<text:Set name="场景" text={镜01机位图提示词}/>',
        id="槽里填了 Render",
    ),
    fault(
        '<text:Set name="镜头" text={全片镜头}/>',
        '<text:Set name="镜头" text={拍摄}/>',
        "「镜头」槽要 Set 一个 film:Shots，{拍摄} 不是",
        id="镜头槽填了文字",
    ),
    fault(
        '<text:Set name="镜头" text={全片镜头}/>',
        '<text:Set name="镜头" text={全片镜头}/>\n    <text:Append name="镜头" text={全片镜头}/>',
        "「镜头」槽只 Set 一个 film:Shots，不 Append",
        anchor='<text:Append name="镜头"',
        id="镜头槽 Append",
    ),
    fault(
        '<text:Append name="主体" text={网面跑鞋}/>',
        '<text:Append name="主体" text={短发女生}/>',
        "{短发女生} 在这个 Render 里填了两次",
        id="同一段文字填两次",
    ),
]

GENERATION_FAULTS = [
    fault(
        '  <text:Render id="全片提示词"',
        '  <gpt:Image id="多余" prompt={全片镜头} aspect-ratio="9:16" resolution="2k"/>\n'
        '  <text:Render id="全片提示词"',
        "生图的 prompt 要写画面模板（画面-v1）的 text:Render，或一段 text:Value",
        anchor='<gpt:Image id="多余"',
        id="生图的提示词是镜头",
    ),
    fault(
        "prompt={全片提示词}",
        "prompt={镜04机位图提示词}",
        "视频的 prompt 要写多镜头视频模板（多镜头视频-v1）的 text:Render",
        anchor="<seedance:ReferenceVideo",
        id="视频的提示词是画面模板",
    ),
    fault(
        '<gpt:Image id="镜04机位图" prompt={镜04机位图提示词}',
        '<gpt:Image id="镜04机位图" prompt={镜04取景}',
        "prompt 是一段 text:Value 时原样发给模型，下面不能挂参考图",
        id="原样发的提示词挂了参考图",
    ),
    fault(
        "<gpt:Reference image={短发女生参考图.image} for={短发女生}/>",
        "<gpt:Reference image={短发女生参考图.image} for={短发女生参考图提示词}/>",
        "for 要指一段 text:Value，{短发女生参考图提示词} 不是",
        id="for 指了 Render",
    ),
    fault(
        '<gpt:Image id="镜04机位图" prompt={镜04机位图提示词} aspect-ratio="9:16" resolution="2k">\n',
        '<gpt:Image id="镜04机位图" prompt={镜04机位图提示词} aspect-ratio="9:16" resolution="2k">\n'
        "    <gpt:Reference for={短发女生} image={短发女生参考图.image}/>\n",
        "{短发女生} 要填在这个生成节点提示词的槽里",
        anchor="<gpt:Reference for={短发女生}",
        id="生图的 for 没填进槽",
    ),
    fault(
        "<seedance:Reference image={公园跑道参考图.image} for={公园跑道}/>",
        "<seedance:Reference image={公园跑道参考图.image} for={公园跑道}/>\n"
        "    <seedance:Reference image={镜01机位图.image} for={拍摄与剪辑}/>",
        "{拍摄与剪辑} 要填在这次视频提示词的人物、产品、场景槽里",
        anchor="<seedance:Reference image={镜01机位图.image}",
        id="视频的 for 不是元素槽",
    ),
    fault(
        "<gpt:Reference image={镜01机位图.image}>木长椅和光线与同一场戏的第一个机位保持一致"
        "</gpt:Reference>",
        "<gpt:Reference image={镜01机位图.image}/>",
        "没写 for 的参考图要在正文里写一句用途",
        id="用途图没写用途",
    ),
    fault(
        "    <gpt:Reference image={跑鞋鞋底} for={网面跑鞋}/>\n"
        "    <gpt:Reference image={公园跑道参考图.image} for={公园跑道}/>\n"
        "    <gpt:Reference image={镜01机位图.image}>木长椅",
        "    <gpt:Reference image={跑鞋鞋底} for={网面跑鞋}>鞋底</gpt:Reference>\n"
        "    <gpt:Reference image={公园跑道参考图.image} for={公园跑道}/>\n"
        "    <gpt:Reference image={镜01机位图.image}>木长椅",
        "写了 for 的参考图不写正文",
        anchor=">鞋底</gpt:Reference>",
        id="元素的图写了正文",
    ),
    fault(
        "<seedance:Reference image={跑鞋正面} for={网面跑鞋}/>",
        "<seedance:Reference image={跑鞋正面}/>",
        "seedance:Reference 缺属性 for",
        id="视频的参考图没写 for",
    ),
    fault(
        "<gpt:Reference image={镜01机位图.image}>木长椅",
        "<gpt:Reference image={跑鞋正面}>再看一眼正面</gpt:Reference>\n"
        "    <gpt:Reference image={镜01机位图.image}>木长椅",
        "{跑鞋正面} 在这个生成节点下列了两次",
        anchor="<gpt:Reference image={跑鞋正面}>再看",
        id="同一张图列两次",
    ),
    fault(
        "胸部以上近景，平视。她站在跑道边",
        "胸部以上近景，平视，参考@Image1。她站在跑道边",
        "文字里不写 @Image，图的编号由后端算",
        anchor='<text:Value id="镜01取景">',
        id="文字里写了图号",
    ),
]

SHOT_FAULTS = [
    fault(
        '<film:Shot start="0.0" end="2.5"',
        '<film:Shot start="1.0" end="2.5"',
        "每组镜头的第一个从 0.0 开始，写的是 1.0",
        id="第一镜不从零开始",
    ),
    fault(
        'start="2.5" end="6.0"',
        'start="2.6" end="6.0"',
        "镜头从 2.6 开始，没接上上一个的结束 2.5",
        id="镜头没接上",
    ),
    fault(
        '<film:Shot start="10.0" end="15.0"',
        '<film:Shot start="10.0" end="10.0"',
        "结束要晚于开始",
        id="结束不晚于开始",
    ),
    fault(
        ">硬切，固定机位，产品特写。网面跑鞋摆在跑道边的木长椅上，鞋头朝向镜头。"
        "短发女生的右手从画面右侧伸进来，拿起左脚那只鞋。旁白：{shop}<",
        ">{shop}<",
        "镜头正文是空的",
        anchor='<film:Shot start="10.0"',
        id="正文只有台词",
    ),
    fault(
        '<text:Set name="镜头" text={全片镜头}/>\n  </text:Render>',
        '<text:Set name="镜头" text={全片镜头}/>\n  </text:Render>\n'
        '  <text:Render id="备用提示词" template={kit.多镜头视频-v1}>\n'
        '    <text:Set name="拍摄与剪辑" text={拍摄与剪辑}/>\n'
        '    <text:Set name="镜头" text={全片镜头}/>\n'
        "  </text:Render>",
        "film:Shots 全片镜头 要正好填进一个视频提示词的「镜头」槽，现在填进了 2 个",
        anchor='<film:Shots id="全片镜头">',
        id="一组镜头填进两个提示词",
    ),
    fault(
        "说：{lighter}",
        "说：{It's lighter than it looks.}",
        "花括号里要写剧本里的段名，「It's lighter than it」不是",
        anchor='<film:Shot start="0.0"',
        id="花括号里写了台词原文",
    ),
    fault(
        "笑着对镜头说：{miles}",
        "笑着对镜头说：好开心。",
        "台词 miles 没有被任何镜头引用",
        anchor="<miles>",
        id="台词没被引用",
    ),
    fault(
        "旁白：{rebound}",
        "旁白：{lighter} {rebound}",
        "台词 lighter 在前面的镜头里已经引用过",
        anchor='<film:Shot start="2.5"',
        id="台词引用两次",
    ),
    fault(
        '    <text:Set name="场景" text={公园跑道}/>\n    <text:Set name="声音"',
        '    <text:Set name="声音"',
        "镜头正文里出现了「公园跑道」，它要填在这次视频提示词的人物、产品、场景槽里",
        anchor='<film:Shot start="2.5"',
        also=(("    <seedance:Reference image={公园跑道参考图.image} for={公园跑道}/>\n", ""),),
        id="镜头里的元素没填进视频提示词",
    ),
    fault(
        _SCRIPT_BLOCK,
        "",
        "剧本 原版台词 要写在引用它台词的 film:Shots 之前",
        anchor='<film:Shots id="全片镜头">',
        also=(("  </film:Shots>\n", "  </film:Shots>\n" + _SCRIPT_BLOCK),),
        id="剧本写在镜头之后",
    ),
]

VIDEO_FAULTS = [
    fault(
        'duration="15"',
        'duration="14"',
        "duration 写的是 14，这组镜头是 15 秒",
        anchor="<seedance:ReferenceVideo",
        id="时长对不上",
    ),
    fault(
        '<gpt:Image id="镜01机位图" prompt={镜01机位图提示词} aspect-ratio="9:16"',
        '<gpt:Image id="镜01机位图" prompt={镜01机位图提示词} aspect-ratio="16:9"',
        "机位图 镜01机位图 的画幅是 16:9，视频是 9:16",
        anchor='<film:Shot start="0.0"',
        id="机位图画幅和视频不同",
    ),
]


@pytest.mark.parametrize(
    ("edit", "also", "anchor", "message"),
    SYNTAX_FAULTS
    + SCRIPT_FAULTS
    + TEMPLATE_FAULTS
    + GENERATION_FAULTS
    + SHOT_FAULTS
    + VIDEO_FAULTS,
)
def test_one_fault_in_the_project_file_is_reported_on_its_line(
    edit: tuple[str, str], also: tuple[tuple[str, str], ...], anchor: str, message: str
) -> None:
    broken = changed(FILM, *edit)
    for old, new in also:
        broken = changed(broken, old, new)

    found = problems(broken, None)

    assert f"film.icml 第 {line_of(broken, anchor)} 行：{message}" in found, found


def test_an_append_written_before_its_set_is_one_problem() -> None:
    swapped = changed(
        FILM,
        '    <text:Set name="拍摄" text={拍摄}/>\n'
        '    <text:Append name="拍摄" text={短发女生参考图拍摄}/>',
        '    <text:Append name="拍摄" text={短发女生参考图拍摄}/>\n'
        '    <text:Set name="拍摄" text={拍摄}/>',
    )
    line = line_of(swapped, '<text:Append name="拍摄" text={短发女生参考图拍摄}/>')

    assert problems(swapped) == [f"film.icml 第 {line} 行：「拍摄」槽要先 Set 再 Append"]


def test_lines_must_be_spoken_in_script_order() -> None:
    swapped = (
        FILM.replace("说：{lighter}", "说：{TEMP}")
        .replace("旁白：{rebound}", "旁白：{lighter}")
        .replace("说：{TEMP}", "说：{rebound}")
    )

    assert problems(swapped) == ["film.icml：镜头里台词的先后和剧本里的不一样"]


def test_a_longer_element_name_is_matched_before_a_shorter_one_inside_it() -> None:
    # 「公园」也是元素，但没填进视频提示词；镜头里的「公园跑道」不能被当成「公园」。
    park = (
        '  <text:Value id="公园">一座城市社区公园</text:Value>\n'
        '  <text:Value id="公园图取景">只拍公园的大门。</text:Value>\n'
        '  <text:Render id="公园图提示词" template={kit.画面-v1}>\n'
        '    <text:Set name="拍摄" text={拍摄}/>\n'
        '    <text:Set name="取景" text={公园图取景}/>\n'
        '    <text:Set name="场景" text={公园}/>\n'
        "  </text:Render>\n"
        '  <gpt:Image id="公园图" prompt={公园图提示词} aspect-ratio="9:16" resolution="2k">\n'
        "    <gpt:Reference image={跑鞋正面} for={公园}/>\n"
        "  </gpt:Image>\n\n"
        "  <!-- 三、视频 -->"
    )
    with_park = changed(FILM, "  <!-- 三、视频 -->", park)

    assert problems(with_park) == []
    assert problems(changed(with_park, "跑道边，双手", "公园的跑道边，双手")) == [
        f"film.icml 第 {line_of(with_park, '<film:Shot start="0.0"')} 行："
        "镜头正文里出现了「公园」，它要填在这次视频提示词的人物、产品、场景槽里"
    ]


def test_comments_between_script_segments_are_allowed() -> None:
    commented = changed(FILM, "    <rebound>", "    <!-- 第二句 -->\n    <rebound>")

    assert problems(commented) == []


def test_a_model_takes_only_the_durations_it_offers() -> None:
    long = (
        two_requests()
        .replace('<film:Shot start="0.0" end="16.0"', '<film:Shot start="0.0" end="31.0"')
        .replace('duration="16"', 'duration="31"')
    )

    assert f"film.icml 第 {line_of(long, '<seedance:ReferenceVideo id="后半"')} 行：" + (
        "model sd2.5 的时长是 4–30 秒"
    ) in problems(long)


def test_every_video_in_a_file_has_the_same_aspect_ratio() -> None:
    wide = two_requests().replace(
        'duration="16" aspect-ratio="9:16"', 'duration="16" aspect-ratio="16:9"'
    )
    wide = wide.replace(
        '<film:Shot start="0.0" end="16.0" view={镜01机位图.image}>',
        '<film:Shot start="0.0" end="16.0">',
    )
    line = line_of(wide, '<seedance:ReferenceVideo id="后半"')

    assert problems(wide) == [
        f"film.icml 第 {line} 行：画幅是 16:9，前面的视频 全片 是 9:16；"
        "一个文件里所有视频的画幅要相同"
    ]


def test_limits_are_counted_as_if_every_written_image_existed() -> None:
    photos = "".join(
        f'  <media:Image id="多图{n}" src="https://cdn.test/more-{n}.png"/>\n' for n in range(8)
    )
    listed = "".join(
        f"    <gpt:Reference image={{多图{n}}}>第 {n} 张的光线</gpt:Reference>\n" for n in range(8)
    )
    crowded = changed(
        changed(FILM, "\n  <!-- 台词", f"\n{photos}\n  <!-- 台词"),
        "    <gpt:Reference image={镜01机位图.image}>跑道和光线",
        listed + "    <gpt:Reference image={镜01机位图.image}>跑道和光线",
    )
    line = line_of(crowded, '<gpt:Image id="镜02机位图"')

    # 短发女生参考图、公园跑道参考图、镜01机位图都还没有图，也按有图算：5 + 8 = 13 张。
    assert problems(crowded, None) == [f"film.icml 第 {line} 行：参考图有 13 张，超过 10 张"]


def test_a_prompt_longer_than_the_model_takes_is_reported() -> None:
    long = changed(
        FILM, "侧面有一道银灰色反光条<", "侧面有一道银灰色反光条" + "。浅蓝色" * 1000 + "<"
    )

    found = problems(long, None)

    assert found, "网面跑鞋的描述填在几张图和视频里，都超了"
    line = line_of(long, '<gpt:Image id="镜01机位图"')
    assert found[0].startswith(f"film.icml 第 {line} 行：拼出的提示词有 ")
    assert found[0].endswith(f"字，超过 {PROMPT_MAX_CHARS} 字")


RUN_FAULTS = [
    pytest.param(
        'output="短发女生参考图.image"',
        'output="短发女生定妆图.image"',
        "output 要写 film.icml 里生图节点的输出",
        id="选用的节点不存在",
    ),
    pytest.param(
        'output="短发女生参考图.image"',
        'output="跑鞋正面"',
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

    assert [(item.name, item.url) for item in image_status(film)] == [
        ("短发女生参考图", None),
        ("公园跑道参考图", None),
        ("镜01机位图", VIEW_ONE),
        ("镜02机位图", None),
        ("镜03机位图", None),
        ("镜04机位图", None),
    ]


def test_a_node_without_a_selection_uses_its_latest_generated_image() -> None:
    film = checked(run=None)
    film.generated["镜01机位图"] = "https://cdn.test/generated-view.png"

    status = {item.name: (item.source, item.url) for item in image_status(film)}
    assert status["镜01机位图"] == ("最近一次生成", "https://cdn.test/generated-view.png")
    assert status["镜02机位图"] == ("还没有图", None)


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


def generated(*missing: str) -> Film:
    """每个生图节点都有一张最近生成的图，``missing`` 里的除外。"""

    film = checked(run=None)
    film.generated = {node: url_of(node) for node in IMAGE_NODES if node not in missing}
    return film


def url_of(node: str) -> str:
    return {"跑鞋正面": SHOE_FRONT, "跑鞋鞋底": SHOE_SOLE}.get(node, f"https://cdn.test/{node}.png")


def assembled(film: Film, title: str) -> tuple[str, tuple[str, ...]]:
    """按小标题（如「生图：镜02机位图」）拼出发给模型的全文与参考图。"""

    node = film.project.nodes[title.split("：")[1]]
    if title.startswith("生视频"):
        group = render_video(film, node)
        return format_shot_prompt(group), group.image_urls
    picture = render_picture(film, node)
    return picture.text, picture.image_urls


PROMPT_CASES = [
    *(
        pytest.param("一", title, (), id=f"图都有-{title}")
        for title in (
            "生图：短发女生参考图",
            "生图：公园跑道参考图",
            "生图：镜01机位图",
            "生图：镜02机位图",
            "生图：镜03机位图",
            "生图：镜04机位图",
            "生视频：全片",
        )
    ),
    pytest.param("二", "生图：镜02机位图", MISSING, id="缺两张-生图：镜02机位图"),
    pytest.param("二", "生视频：全片", MISSING, id="缺两张-生视频：全片"),
]


@pytest.mark.parametrize(("case", "title", "missing"), PROMPT_CASES)
def test_prompts_are_assembled_exactly_as_written_in_the_spec(
    case: str, title: str, missing: tuple[str, ...]
) -> None:
    text, names = expected_prompt(case, title)

    got, images = assembled(generated(*missing), title)

    assert got == text
    assert images == tuple(url_of(name) for name in names)


@pytest.mark.parametrize(
    "title", ["生图：短发女生参考图", "生图：公园跑道参考图", "生图：镜04机位图"]
)
def test_images_that_do_not_use_the_missing_ones_are_unaffected(title: str) -> None:
    assert assembled(generated(*MISSING), title) == assembled(generated(), title)


@pytest.mark.parametrize("title", ["生图：镜01机位图", "生图：镜03机位图"])
def test_a_missing_person_image_drops_its_number_and_the_rest_move_up(title: str) -> None:
    text, images = assembled(generated(), title)
    renumbered = (
        text.replace("参考@Image1。", "")
        .replace("@Image2", "@Image1")
        .replace("@Image3", "@Image2")
        .replace("@Image4", "@Image3")
        .replace("@Image5", "@Image4")
    )

    assert assembled(generated(*MISSING), title) == (renumbered, images[1:])


def test_a_purpose_image_that_does_not_exist_yet_leaves_out_its_sentence() -> None:
    text, images = assembled(generated(*MISSING, "镜01机位图"), "生图：镜02机位图")

    assert text.endswith("远处是一排梧桐树和几栋浅色公寓楼，参考@Image3。")
    assert images == (SHOE_FRONT, SHOE_SOLE, url_of("公园跑道参考图"))


def test_a_prompt_written_as_one_text_is_sent_as_it_is() -> None:
    plain = changed(
        FILM,
        '<gpt:Image id="短发女生参考图" prompt={短发女生参考图提示词}',
        '<gpt:Image id="短发女生参考图" prompt={短发女生}',
    )

    text, images = assembled(checked(plain, None), "生图：短发女生参考图")

    assert text.startswith("东亚女性，二十出头；") and text.endswith("左手腕戴一块白色运动手表")
    assert images == ()


def video_rows(film: Film) -> list[VideoShotDocumentRow]:
    videos = film.project.find("ReferenceVideo")
    return [video_row(film, video, index) for index, video in enumerate(videos, start=1)]


def test_a_video_request_copies_the_shot_times_and_numbers_the_views() -> None:
    (row,) = video_rows(generated(*MISSING))

    assert (row.index, row.seconds) == (1, 15)
    assert [item.timestamps for item in row.prompt.timeline] == [
        [0.0, 2.5],
        [2.5, 6.0],
        [6.0, 10.0],
        [10.0, 15.0],
    ]
    assert [item.image_indexes for item in row.prompt.timeline] == [[4], [], [5], [6]]
    assert row.image_urls == [
        SHOE_FRONT,
        SHOE_SOLE,
        url_of("公园跑道参考图"),
        url_of("镜01机位图"),
        url_of("镜03机位图"),
        url_of("镜04机位图"),
    ]


def test_a_long_film_is_split_in_the_project_file_and_each_request_starts_at_zero() -> None:
    film = checked(two_requests())
    first, second = video_rows(film)

    assert (first.index, second.index) == (1, 2)
    assert (first.seconds, second.seconds) == (20, 16)
    assert second.prompt.timeline[0].timestamps == [0.0, 16.0]
    # 第二组借用第一组的镜01机位图当机位图，按发给它自己的先后编号。
    assert second.image_urls == [SHOE_FRONT, VIEW_ONE]
    assert second.prompt.timeline[0].prompt.startswith("参考@Image2，硬切")


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
    assert check_project_content(changed(FILM, 'duration="15"', 'duration="14"')) == [
        f"film.icml 第 {line_of(FILM, '<seedance:ReferenceVideo')} 行："
        "duration 写的是 14，这组镜头是 15 秒"
    ]
    assert "写法错误" in check_project_content('<?icml using="@iclip/markup@1"?>\n<icml>')[0]


def test_saving_the_run_file_checks_that_file_alone() -> None:
    assert check_run_content(RUN) == []
    # 选用的节点存不存在要对照工程文件，保存时不查。
    assert check_run_content(RUN.replace("短发女生参考图.image", "不存在的节点.image")) == []
    assert (
        "在这之前没有定义"
        in check_run_content(RUN.replace("image={短发女生修过手}", "image={没登记}"))[0]
    )
