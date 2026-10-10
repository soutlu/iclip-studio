"""验证工程文件与运行文件的运行时：检查规则、取图、拼提示词与出片请求。"""

from __future__ import annotations

import pytest

from iclip.capabilities.iclip_studio.film.checks import (
    check,
    check_project_content,
    check_run_content,
)
from iclip.capabilities.iclip_studio.film.film import Film
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
from iclip.common.shot_rules import MAX_REFERENCE_IMAGES
from iclip.domains.generation import schemas as generation
from iclip.domains.generation.gpt_image import GPT_IMAGE_2_5
from tests.helpers.film import (
    EXPECTED,
    FILM,
    GENERATED,
    IMAGE_NODES,
    RUN,
    STATES,
    project_of,
    run_of,
)

USE_PERSON = '<use output="personB.image" image={personB-v1}/>'

BLOCKED_IMAGES = {"no-personB": ("view01", "view03"), "none": ("view01", "view03")}
"""这两种状态取消了 personB，挂着它的两张机位图生成时被拦住。"""

_SCRIPT_BLOCK = FILM[
    FILM.index('  <script id="lines">') : FILM.index("  </script>\n") + len("  </script>\n")
]
"""示例里的整份剧本，连同缩进和末尾的换行。"""

_VIEW01_BLOCK = FILM[
    FILM.index('  <gpt:Image id="view01"') : FILM.index("  </gpt:Image>\n")
    + len("  </gpt:Image>\n")
]
"""示例里 view01 这个生图节点，连同它的参考图列表。"""


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


def at(source: str, anchor: str, message: str) -> str:
    """``anchor`` 所在那一行报出的一条问题。"""

    return f"film.icml 第 {line_of(source, anchor)} 行：{message}"


@pytest.mark.parametrize("state", STATES)
def test_every_state_of_the_example_passes_with_and_without_its_run_file(state: str) -> None:
    assert problems(project_of(state), run_of(state)) == []
    assert problems(project_of(state), None) == []


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
        "\n\n  <!-- 二、全片设定 -->",
        '\n  <import as="m2" from="@iclip/media@1"/>\n\n  <!-- 二、全片设定 -->',
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
        '<text:Set name="setting" text={studioSetting}/>',
        '<text:Put name="setting" text={studioSetting}/>',
        "不认识的标签 text:Put（没有 import 它的包，或包里没有这个标签）",
        id="不认识的标签",
    ),
    fault(
        "<gpt:Reference image={modelAPortraitPhoto}/>",
        "<seedance:Reference image={modelAPortraitPhoto}/>",
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
        anchor='<gpt:Image id="personB"',
        id="缺必填属性",
    ),
    fault(
        '  <film:Shots id="video01Shots">\n',
        '  <film:Shots id="video01Shots"/>\n  <film:Shots id="别的镜头">\n',
        "film:Shots 下的 Shot 要 1–任意 个，写了 0 个",
        anchor='<film:Shots id="video01Shots"/>',
        id="子标签个数不够",
    ),
    fault(
        "<gpt:Reference image={modelAPortraitPhoto}/>",
        "<gpt:Reference image={modelAPortraitPhoto} for={capture}/>",
        "gpt:Reference 没有属性 for",
        id="生图的参考图写了 for",
    ),
    fault(
        "<seedance:Reference image={modelAPortraitPhoto}/>",
        "<seedance:Reference image={modelAPortraitPhoto} for={video01ModelA}/>",
        "seedance:Reference 没有属性 for",
        id="视频的参考图写了 for",
    ),
    fault(
        "<gpt:Reference image={modelAPortraitPhoto}/>",
        "<gpt:Reference image={modelAPortraitPhoto}>半身照</gpt:Reference>",
        "gpt:Reference 不收正文",
        id="生图的参考图写了正文",
    ),
    fault(
        "<seedance:Reference image={modelAPortraitPhoto}/>",
        "<seedance:Reference image={modelAPortraitPhoto}>半身照</seedance:Reference>",
        "seedance:Reference 不收正文",
        id="视频的参考图写了正文",
    ),
    fault(
        '<text:Value id="view04Framing">',
        '<text:Value id="view03Framing">',
        "名字 view03Framing 重复",
        anchor='<text:Value id="view03Framing">低机位',
        id="名字重复",
    ),
    fault(
        '<text:Value id="配乐">',
        '<text:Value id="配 乐">',
        "名字 配 乐 里有不能用的字符",
        id="名字里有空格",
    ),
    fault(
        '<text:Set name="capture" text={capture}/>',
        '<text:Set name="capture" text="{capture}"/>',
        "text 要写引用，如 text={名字}，不加引号",
        id="引用加了引号",
    ),
    fault(
        'aspect-ratio="3:4"',
        "aspect-ratio={capture}",
        "aspect-ratio 是普通值，要加引号，不能写引用",
        id="普通值写成引用",
    ),
    fault(
        'aspect-ratio="3:4" resolution="2k"',
        'aspect-ratio="3:4" resolution="1k"',
        "resolution 只能是 2k，写的是 1k",
        id="没开放的分辨率",
    ),
    fault('duration="18"', 'duration="18.0"', "duration 要写整数，写的是 18.0", id="时长不是整数"),
    fault(
        'start="6.0" end="12.0"',
        'start="6.00" end="12.0"',
        "start 要写秒数，带一位小数，写的是 6.00",
        id="秒数格式不对",
    ),
    fault(
        "<gpt:Reference image={view01.image}/>",
        "<gpt:Reference image={view03.image}/>",
        "{view03.image} 在这之前没有定义",
        id="先用后定义",
    ),
    fault(
        "<gpt:Reference image={view01.image}/>",
        "<gpt:Reference image={view01}/>",
        "{view01} 写法不对，gpt:Image 的输出是 {view01.image}",
        id="输出路径写错",
    ),
    fault(
        "<gpt:Reference image={modelAPortraitPhoto}/>",
        "<gpt:Reference image={capture}/>",
        "image 要「图」，{capture} 是「文字」",
        id="类型不对",
    ),
    fault(
        '<text:Render id="view04Prompt" template={kit.picture-v1}>',
        '<text:Render id="view04Prompt" template={kit.picture-v2}>',
        "{kit.picture-v2} 不是模板包里的模板，可以写 {kit.picture-v1}、{kit.multi-shot-video-v1}",
        id="没有的模板",
    ),
]

SCRIPT_FAULTS = [
    fault(
        '  <text:Value id="模特A声音">',
        '  <script id="另一版">\n    <again><模特A>再来一次。</again>\n  </script>\n'
        '  <text:Value id="模特A声音">',
        "一个文件最多写一份剧本",
        anchor='<script id="另一版">',
        id="两份剧本",
    ),
    fault(
        "<match><模特B>看着也挺百搭。</match>",
        "<Match><模特B>看着也挺百搭。</Match>",
        "段名 Match 不对：小写英文字母开头，后面是小写英文字母、数字、- 和 _，最长 64 个字符",
        id="段名格式不对",
    ),
    fault(
        "<match><模特B>看着也挺百搭。</match>",
        "<hook><模特B>看着也挺百搭。</hook>",
        "段名 hook 重复",
        id="段名重复",
    ),
    fault(
        "    <reply>",
        "    模特B：\n    <reply>",
        "剧本里段与段之间只能有空白和注释，一段写成 <段名>……</段名>",
        anchor="    模特B：\n",
        id="段外写了字",
    ),
    fault(
        "<hook><模特A>这一双",
        "<hook>这一双",
        "段 hook 开头要写说话人，如 <短发女生>",
        id="没写说话人",
    ),
    fault(
        "<hook><模特A>这一双，走起来很轻。</hook>",
        "<hook><模特A> </hook>",
        "段 hook 的台词是空的",
        id="台词是空的",
    ),
    fault(
        "看着也挺百搭。</match>",
        "看着也挺百搭 & 好看。</match>",
        "台词里的 & 要写成 &amp;",
        anchor="<match>",
        id="与号没转义",
    ),
    fault(
        "这一双，走起来很轻。</hook>",
        "这一双，<模特B>走起来很轻。</hook>",
        "剧本里不支持一段里写第二个说话人",
        anchor="<hook>",
        id="第二个说话人",
    ),
    fault(
        "这一双，走起来很轻。</hook>",
        "这一双，<走|zou>起来很轻。</hook>",
        "剧本里不支持 <显示|读法> 的写法",
        anchor="<hook>",
        id="显示和读法",
    ),
    fault(
        "这一双，走起来很轻。</hook>",
        "这一双 | 走起来很轻。</hook>",
        "剧本里不支持单独的 |",
        anchor="<hook>",
        id="单独的竖线",
    ),
    fault(
        "这一双，走起来很轻。</hook>",
        "这一双 || 走起来很轻。</hook>",
        "剧本里不支持 ||",
        anchor="<hook>",
        id="两条竖线",
    ),
    fault(
        "这一双，走起来很轻。</hook>",
        "这一双 @{weight} 走起来很轻。</hook>",
        "剧本里不支持 @{…}",
        anchor="<hook>",
        id="at 花括号",
    ),
    fault(
        "这一双，走起来很轻。</hook>",
        "这一双 {hook} 走起来很轻。</hook>",
        "剧本里不支持花括号",
        anchor="<hook>",
        id="花括号",
    ),
    fault(
        "<hook><模特A>这一双，走起来很轻。</hook>",
        "<hook></hook>",
        "剧本里不支持空的段",
        id="空的段",
    ),
    fault(
        "这一双，走起来很轻。</hook>",
        "这一双参考@Image1，走起来很轻。</hook>",
        "台词 hook 里不能写 @Image",
        anchor="<hook>",
        id="台词里写了图号",
    ),
    fault(
        "这一双，走起来很轻。</hook>",
        "这一双 @image，走起来很轻。</hook>",
        "台词 hook 里不能写 @Image",
        anchor="<hook>",
        id="台词里写了小写的图号",
    ),
]

TEMPLATE_FAULTS = [
    fault(
        '<text:Set name="framing" text={view04Framing}/>',
        '<text:Set name="构图" text={view04Framing}/>',
        "模板 picture-v1 没有「构图」这个槽，可以写 capture、subject、framing、setting",
        id="没有的槽",
    ),
    fault(
        '<text:Append name="subject" text={模特B身材}/>',
        '<text:Set name="subject" text={模特B身材}/>',
        "「subject」槽只 Set 一次，后面的用 Append",
        id="一个槽 Set 两次",
    ),
    fault(
        '    <text:Set name="framing" text={sceneFraming}/>\n',
        "",
        "模板 picture-v1 的「framing」槽必填，没有填",
        anchor='<text:Render id="scenePrompt"',
        id="必填的槽没填",
    ),
    fault(
        '<text:Set name="setting" text={sceneSetting}/>',
        '<text:Set name="setting" text={personBPrompt}/>',
        "「setting」槽里填 text:Value，{personBPrompt} 不是",
        id="槽里填了 Render",
    ),
    fault(
        '<text:Set name="shots" text={video01Shots}/>',
        '<text:Set name="shots" text={view01Framing}/>',
        "「shots」槽要 Set 一个 film:Shots，{view01Framing} 不是",
        id="镜头槽填了文字",
    ),
    fault(
        '<text:Set name="shots" text={video01Shots}/>',
        '<text:Set name="shots" text={video01Shots}/>\n'
        '    <text:Append name="shots" text={video01Shots}/>',
        "「shots」槽只 Set 一个 film:Shots，不 Append",
        anchor='<text:Append name="shots"',
        id="镜头槽 Append",
    ),
    fault(
        '<text:Append name="subject" text={模特B身材}/>',
        '<text:Append name="subject" text={personBSubject}/>',
        "{personBSubject} 在这个 Render 里填了两次",
        id="同一段文字填两次",
    ),
]

GENERATION_FAULTS = [
    fault(
        '  <text:Render id="video01Prompt"',
        '  <gpt:Image id="多余" prompt={video01Shots} aspect-ratio="16:9" resolution="2k"/>\n'
        '  <text:Render id="video01Prompt"',
        "生图的 prompt 要写 picture-v1 模板的 text:Render",
        anchor='<gpt:Image id="多余"',
        id="生图的提示词是镜头",
    ),
    fault(
        '<gpt:Image id="personB" prompt={personBPrompt}',
        '<gpt:Image id="personB" prompt={personBSubject}',
        "生图的 prompt 要写 picture-v1 模板的 text:Render",
        id="生图的提示词直接写文字",
    ),
    fault(
        "prompt={video01Prompt}",
        "prompt={view03Prompt}",
        "视频的 prompt 要写 multi-shot-video-v1 模板的 text:Render",
        anchor='<seedance:ReferenceVideo id="video01"',
        id="视频的提示词是画面模板",
    ),
    fault(
        "    <gpt:Reference image={shoeSolePhoto}/>\n",
        "    <gpt:Reference image={shoeSidePhoto}/><!-- 又一张 -->\n",
        "{shoeSidePhoto} 在这个生成节点下列了两次",
        anchor="<gpt:Reference image={shoeSidePhoto}/><!-- 又一张 -->",
        id="同一张图列两次",
    ),
]

_MARK_ADVICE = "写错了；要写成 @Image 后面直接跟从 1 起的数字，如 @Image1"

NUMBER_FAULTS = [
    *(
        fault(
            "纽约红砖街区参考 @Image6。</text:Value>",
            f"纽约红砖街区参考 {wrong}。</text:Value>",
            f"图号 {wrong} {_MARK_ADVICE}",
            anchor='<text:Value id="view01Setting">',
            id=f"图号写成 {wrong}",
        )
        for wrong in ("@Image", "@Image0", "@Image06", "@Image 6", "@image6", "@IMAGE6")
    ),
    fault(
        ">参考@Image8，中景",
        ">参考@image8，中景",
        f"图号 @image8 {_MARK_ADVICE}",
        anchor='<film:Shot start="0.0" end="6.0"',
        id="镜头正文里的图号写成小写",
    ),
    fault(
        "纽约红砖街区参考 @Image6。</text:Value>",
        "纽约红砖街区。</text:Value>",
        "view01 挂了 6 张参考图，用到的文字里的图号要正好是 @Image1–@Image6；没有写 @Image6",
        anchor='<gpt:Image id="view01"',
        id="少写了一个图号",
    ),
    fault(
        "纽约红砖街区参考 @Image6。</text:Value>",
        "纽约红砖街区参考 @Image7。</text:Value>",
        "view01 挂了 6 张参考图，用到的文字里的图号要正好是 @Image1–@Image6；没有写 @Image6；"
        "@Image7 没有对应的参考图",
        anchor='<gpt:Image id="view01"',
        id="图号超出了列表",
    ),
    fault(
        "神情轻松。</text:Value>",
        "神情轻松，参考 @Image1。</text:Value>",
        "personB 没有挂参考图，用到的文字里不能写图号，写了 @Image1",
        anchor='<gpt:Image id="personB"',
        id="没挂参考图却写了图号",
    ),
    fault(
        ">参考@Image10，硬切",
        ">参考@Image11，硬切",
        "video01 挂了 10 张参考图，用到的文字里的图号要正好是 @Image1–@Image10；没有写 @Image10；"
        "@Image11 没有对应的参考图",
        anchor='<seedance:ReferenceVideo id="video01"',
        id="视频的镜头正文也算",
    ),
    fault(
        '<text:Set name="person" text={video02ModelA}/>',
        '<text:Set name="person" text={video01ModelA}/>',
        "video01ModelA 里写了图号，要正好用在一个生成节点里，现在用在了 2 个：video01、video02",
        anchor='<text:Value id="video01ModelA">',
        id="带图号的文字给两个节点用",
    ),
    fault(
        '<text:Set name="person" text={video02ModelA}/>',
        '<text:Set name="person" text={video01ModelA}/>',
        "video02ModelA 里写了图号，要正好用在一个生成节点里，现在用在了 0 个",
        anchor='<text:Value id="video02ModelA">',
        id="带图号的文字没用上",
    ),
    fault(
        "  <!-- view02：",
        _VIEW01_BLOCK.replace('id="view01"', 'id="view01Copy"') + "\n  <!-- view02：",
        "view01Subject 里写了图号，要正好用在一个生成节点里，现在用在了 2 个：view01、view01Copy",
        anchor='<text:Value id="view01Subject">',
        id="一个 Render 给两个节点用",
    ),
    fault(
        'end="12.0" view={view02.image}>',
        'end="12.0" view={view01.image}>',
        "{view01.image} 已经是 video01Shots 第 1 镜的机位图；一张机位图只给一个镜头用",
        anchor='<film:Shot start="6.0" end="12.0"',
        id="一张机位图给两个镜头用",
    ),
    fault(
        ">参考@Image8，中景，平视，",
        ">中景，平视，参考@Image8，",
        "{view01.image} 在视频 video01 的参考图里排第 8，这一镜正文要以「参考@Image8，」开头",
        anchor='<film:Shot start="0.0" end="6.0"',
        id="机位图的引用没写在开头",
    ),
    fault(
        "纽约红砖街区参考 @Image7。</text:Value>",
        "纽约红砖街区参考 @Image7，光线与 @Image8 一致。</text:Value>",
        "@Image8 是第 1 镜的机位图，只在那一镜开头写一次，现在写了 2 次",
        anchor='<seedance:ReferenceVideo id="video01"',
        id="机位图的图号写在别处",
    ),
]

SHOT_FAULTS = [
    fault(
        '<film:Shot start="0.0" end="6.0"',
        '<film:Shot start="1.0" end="6.0"',
        "每组镜头的第一个从 0.0 开始，写的是 1.0",
        id="第一镜不从零开始",
    ),
    fault(
        'start="6.0" end="12.0"',
        'start="6.1" end="12.0"',
        "镜头从 6.1 开始，没接上上一个的结束 6.0",
        id="镜头没接上",
    ),
    fault(
        '<film:Shot start="12.0" end="18.0"',
        '<film:Shot start="12.0" end="12.0"',
        "结束要晚于开始",
        id="结束不晚于开始",
    ),
    fault(
        ">参考@Image10，硬切，近景，平视。模特B低头看了看模特A的鞋，抬头对着镜头笑。她说：{match}<",
        ">{match}<",
        "镜头正文是空的",
        anchor='<film:Shot start="12.0"',
        id="正文只有台词",
    ),
    fault(
        '  <seedance:ReferenceVideo id="video01"',
        '  <text:Render id="备用提示词" template={kit.multi-shot-video-v1}>\n'
        '    <text:Set name="capture" text={videoCapture}/>\n'
        '    <text:Set name="shots" text={video01Shots}/>\n'
        "  </text:Render>\n"
        '  <seedance:ReferenceVideo id="备用" model="sd2.5" prompt={备用提示词} duration="18"'
        ' aspect-ratio="16:9"/>\n'
        '  <seedance:ReferenceVideo id="video01"',
        "film:Shots video01Shots 要正好用在一个视频里，现在用在了 2 个",
        anchor='<film:Shots id="video01Shots">',
        id="一组镜头用在两个视频里",
    ),
    fault(
        '  <text:Render id="video01Prompt"',
        '  <film:Shots id="备用镜头">\n'
        '    <film:Shot start="0.0" end="4.0">空镜。</film:Shot>\n'
        "  </film:Shots>\n"
        '  <text:Render id="video01Prompt"',
        "film:Shots 备用镜头 要正好用在一个视频里，现在用在了 0 个",
        anchor='<film:Shots id="备用镜头">',
        id="一组镜头没用在视频里",
    ),
    fault(
        "看鞋说：{hook}",
        "看鞋说：{这一双，走起来很轻。}",
        "花括号里要写剧本里的段名，「这一双，走起来很轻。」不是",
        anchor='<film:Shot start="0.0"',
        id="花括号里写了台词原文",
    ),
    fault(
        "她笑着说：{close}",
        "她笑着说：好。",
        "台词 close 没有被任何镜头引用",
        anchor="<close>",
        id="台词没被引用",
    ),
    fault(
        "她说：{answer}",
        "她说：{hook} {answer}",
        "台词 hook 在前面的镜头里已经引用过",
        anchor='<film:Shot start="6.0"',
        id="台词引用两次",
    ),
    fault(
        _SCRIPT_BLOCK,
        "",
        "剧本 lines 要写在引用它台词的 film:Shots 之前",
        anchor='<film:Shots id="video01Shots">',
        also=(("  </film:Shots>\n", "  </film:Shots>\n" + _SCRIPT_BLOCK),),
        id="剧本写在镜头之后",
    ),
]

VIDEO_FAULTS = [
    fault(
        'duration="18"',
        'duration="17"',
        "duration 写的是 17，这组镜头是 18 秒",
        anchor='<seedance:ReferenceVideo id="video01"',
        id="时长对不上",
    ),
    fault(
        '<gpt:Image id="view01" prompt={view01Prompt} aspect-ratio="16:9"',
        '<gpt:Image id="view01" prompt={view01Prompt} aspect-ratio="9:16"',
        "机位图 view01 的画幅是 9:16，视频是 16:9",
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
    + NUMBER_FAULTS
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

    assert at(broken, anchor, message) in found, found


def test_a_listed_view_must_belong_to_a_shot_of_that_video() -> None:
    # video02 的列表里换上 video01 第 3 镜的机位图；那一镜不在 video02 里。
    moved = changed(
        FILM,
        "    <seedance:Reference image={view06.image}/>\n  </seedance:ReferenceVideo>\n</icml>",
        "    <seedance:Reference image={view03.image}/>\n  </seedance:ReferenceVideo>\n</icml>",
    )
    line = moved.count("\n", 0, moved.rindex("<seedance:Reference image={view03.image}/>")) + 1

    assert problems(moved, None) == [
        f"film.icml 第 {line} 行：{{view03.image}} 是 video01Shots 第 3 镜的机位图，"
        "那一镜不在视频 video02 里"
    ]


def test_an_append_written_before_its_set_is_one_problem() -> None:
    swapped = changed(
        FILM,
        '    <text:Set name="subject" text={personBSubject}/>\n'
        '    <text:Append name="subject" text={模特B身材}/>',
        '    <text:Append name="subject" text={模特B身材}/>\n'
        '    <text:Set name="subject" text={personBSubject}/>',
    )

    assert problems(swapped) == [
        at(
            swapped,
            '<text:Append name="subject" text={模特B身材}/>',
            "「subject」槽要先 Set 再 Append",
        )
    ]


def test_lines_must_be_spoken_in_script_order() -> None:
    swapped = (
        FILM.replace("看鞋说：{hook}", "看鞋说：{TEMP}")
        .replace("侧头问：{reply}", "侧头问：{hook}")
        .replace("看鞋说：{TEMP}", "看鞋说：{reply}")
    )

    assert problems(swapped) == ["film.icml：镜头里台词的先后和剧本里的不一样"]


def test_comments_between_script_segments_are_allowed() -> None:
    commented = changed(FILM, "    <reply>", "    <!-- 第二句 -->\n    <reply>")

    assert problems(commented) == []


def test_a_model_takes_only_the_durations_it_offers() -> None:
    long = changed(
        changed(FILM, '<film:Shot start="10.0" end="15.0"', '<film:Shot start="10.0" end="31.0"'),
        'duration="15"',
        'duration="31"',
    )

    assert at(long, '<seedance:ReferenceVideo id="video02"', "model sd2.5 的时长是 4–30 秒") in (
        problems(long)
    )


def test_every_video_in_a_file_has_the_same_aspect_ratio() -> None:
    tall = changed(FILM, 'duration="15" aspect-ratio="16:9"', 'duration="15" aspect-ratio="9:16"')
    for view in ("view04", "view05", "view06"):
        tall = changed(
            tall,
            f'<gpt:Image id="{view}" prompt={{{view}Prompt}} aspect-ratio="16:9"',
            f'<gpt:Image id="{view}" prompt={{{view}Prompt}} aspect-ratio="9:16"',
        )

    assert problems(tall) == [
        at(
            tall,
            '<seedance:ReferenceVideo id="video02"',
            "画幅是 9:16，前面的视频 video01 是 16:9；一个文件里所有视频的画幅要相同",
        )
    ]


def more_photos(source: str, count: int, tag: str) -> tuple[str, str]:
    """在素材里多写 ``count`` 张照片，返回 (新的原文, 挂这几张的 ``tag`` 参考图，一张一行)。"""

    photos = "".join(
        f'  <media:Image id="多图{n}" src="https://cdn.test/more-{n}.png"/>\n' for n in range(count)
    )
    return (
        changed(source, "\n  <!-- 二、全片设定 -->", f"\n{photos}\n  <!-- 二、全片设定 -->"),
        "".join(f"    <{tag} image={{多图{n}}}/>\n" for n in range(count)),
    )


def test_an_image_takes_at_most_ten_references_whether_or_not_they_have_images() -> None:
    crowded, listed = more_photos(FILM, 5, "gpt:Reference")
    crowded = changed(
        crowded,
        "    <gpt:Reference image={scene.image}/>\n  </gpt:Image>\n\n  <!-- view02",
        "    <gpt:Reference image={scene.image}/>\n" + listed + "  </gpt:Image>\n\n  <!-- view02",
    )
    crowded = changed(
        crowded,
        "纽约红砖街区参考 @Image6。",
        "纽约红砖街区参考 @Image6；另参考 @Image7、@Image8、@Image9、@Image10、@Image11。",
    )

    # 没有运行文件，personB、scene 都没有图，也按文件里列的算：6 + 5 = 11 张。
    assert problems(crowded, None) == [
        at(crowded, '<gpt:Image id="view01"', "参考图有 11 张，超过 10 张")
    ]


def test_a_video_takes_at_most_thirty_references() -> None:
    crowded, listed = more_photos(FILM, 21, "seedance:Reference")
    crowded = changed(
        crowded,
        "    <seedance:Reference image={view03.image}/>\n",
        "    <seedance:Reference image={view03.image}/>\n" + listed,
    )
    marks = "、".join(f"@Image{n}" for n in range(11, 32))
    crowded = changed(
        crowded, "纽约红砖街区参考 @Image7。", f"纽约红砖街区参考 @Image7；另参考 {marks}。"
    )

    assert problems(crowded, None) == [
        at(crowded, '<seedance:ReferenceVideo id="video01"', "参考图有 31 张，超过 30 张")
    ]


def test_a_picture_prompt_longer_than_the_model_takes_is_reported() -> None:
    long = changed(FILM, "双臂自然下垂。<", "双臂自然下垂" + "。浅灰色" * 1000 + "<")

    found = problems(long, None)

    (only,) = found
    assert only.startswith(at(long, '<gpt:Image id="view01"', "拼出的提示词有 "))
    assert only.endswith(f"字，超过 {PROMPT_MAX_CHARS} 字")


def test_a_video_prompt_is_counted_with_its_shots_and_reported_per_request() -> None:
    long = changed(FILM, "不做风格化调色。\n", "不做风格化调色" + "。低对比" * 1000 + "\n")

    found = problems(long, None)

    assert [problem.split("：", 1)[0] for problem in found] == [
        f"film.icml 第 {line_of(long, '<seedance:ReferenceVideo id="video01"')} 行",
        f"film.icml 第 {line_of(long, '<seedance:ReferenceVideo id="video02"')} 行",
    ]
    assert all("拼出的提示词有 " in problem for problem in found)


RUN_FAULTS = [
    pytest.param(
        'output="personB.image"',
        'output="personC.image"',
        "output 要写 film.icml 里生图节点的输出",
        id="选用的节点不存在",
    ),
    pytest.param(
        'output="personB.image"',
        'output="shoeFrontPhoto"',
        "output 要写 film.icml 里生图节点的输出",
        id="选用到用户给的图上",
    ),
    pytest.param(
        'output="personB.image"',
        'output="video01.video"',
        "output 要写 film.icml 里生图节点的输出",
        id="选用到视频上",
    ),
    pytest.param(
        "image={personB-v1}",
        "image={personB-v3}",
        "{personB-v3} 在这之前没有定义",
        id="引用的图没登记",
    ),
    pytest.param(
        "image={personB-v1}",
        f'image="{GENERATED["personB"]}"',
        "image 要写引用",
        id="选用里直接写了地址",
    ),
    pytest.param(
        USE_PERSON,
        USE_PERSON + "\n  " + USE_PERSON.replace("personB-v1", "scene-v1"),
        "personB 选用了两次",
        id="同一个节点选用两次",
    ),
    pytest.param('id="scene-v1"', 'id="personB-v1"', "名字 personB-v1 重复", id="登记名重复"),
    pytest.param(
        f'  <media:Image id="personB-v1" src="{GENERATED["personB"]}"/>\n',
        "",
        "{personB-v1} 在这之前没有定义",
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


def node_images(film: Film) -> dict[str, str | None]:
    """每个生图节点现在用的图片地址。"""

    return {
        node.attrs["id"]: film.image_url(f"{node.attrs['id']}.image") for node in film.image_nodes()
    }


def test_registered_images_that_are_not_selected_are_kept_as_alternatives() -> None:
    film = checked(run=changed(RUN, "  " + USE_PERSON + "\n", ""))

    assert film.registered["personB-v1"] == GENERATED["personB"]
    assert node_images(film) == {**GENERATED, "personB": None}


def test_without_a_run_file_no_generated_node_has_an_image() -> None:
    film = checked(run=None)

    assert node_images(film) == dict.fromkeys(IMAGE_NODES)


def test_a_node_uses_the_registered_image_selected_for_it() -> None:
    switched = checked(run=RUN.replace("image={personB-v1}", "image={scene-v1}"))

    assert checked().image_url("personB.image") == GENERATED["personB"]
    assert switched.image_url("personB.image") == GENERATED["scene"]


@pytest.mark.parametrize("state", STATES)
@pytest.mark.parametrize("node", IMAGE_NODES)
def test_each_image_is_assembled_exactly_as_the_example(state: str, node: str) -> None:
    film = checked(project_of(state), run_of(state))
    expected = EXPECTED["images"][node]

    picture = render_picture(film, film.project.nodes[node])

    assert picture.text == expected["prompt"]
    if node in BLOCKED_IMAGES.get(state, ()):
        assert picture.missing == ("personB",)
    else:
        assert picture.missing == ()
        assert list(picture.image_urls) == expected["input_str_list"]


SENT_VIDEOS = [
    pytest.param(state, video, id=f"{state}-{video}")
    for state in STATES
    for video in ("video01", "video02")
    if not EXPECTED["states"][state][video]["blocked"]
]
"""示例里能出片的组；被缺图拦住的两组见下一条测试。"""


@pytest.mark.parametrize(("state", "video"), SENT_VIDEOS)
def test_each_video_is_assembled_exactly_as_the_example(state: str, video: str) -> None:
    expected = EXPECTED["states"][state][video]
    film = checked(project_of(state), run_of(state))

    group = render_video(film, film.project.nodes[video])

    assert group.missing == ()
    assert group.global_settings == expected["shot"]["global_settings"]
    assert [
        {"timestamps": list(cut.timestamps), "prompt": cut.prompt} for cut in group.timeline
    ] == expected["shot"]["timeline"]
    assert list(group.image_urls) == expected["images"]


@pytest.mark.parametrize("state", ["no-personB", "none"])
def test_a_video_whose_list_has_an_image_without_a_picture_cannot_be_sent(state: str) -> None:
    film = checked(project_of(state), run_of(state))

    group = render_video(film, film.project.nodes["video01"])

    assert list(group.missing) == EXPECTED["states"][state]["video01"]["missing"] == ["personB"]
    with pytest.raises(RuntimeError, match="personB"):
        _ = group.image_urls


def test_a_missing_reference_stays_written_in_the_text_and_is_not_split_out() -> None:
    film = checked(project_of("no-personB"), run_of("no-personB"))

    picture = render_picture(film, film.project.nodes["view01"])

    assert picture.text == EXPECTED["images"]["view01"]["prompt"]
    assert [run.number for run in picture.runs if not isinstance(run, str)] == [1, 2, 4, 5, 6]
    assert any(isinstance(run, str) and "@Image3" in run for run in picture.runs)


def test_a_video_request_copies_the_shot_times_and_the_list_as_it_is() -> None:
    film = checked()
    videos = film.project.find("ReferenceVideo")
    first, second = (video_row(film, video, index) for index, video in enumerate(videos, start=1))

    assert (first.index, first.seconds, second.index, second.seconds) == (1, 18, 2, 15)
    assert [item.timestamps for item in second.prompt.timeline] == [
        [0.0, 5.0],
        [5.0, 10.0],
        [10.0, 15.0],
    ]
    assert [item.image_indexes for item in first.prompt.timeline] == [[8], [9], [10]]
    assert first.image_urls == EXPECTED["states"]["both"]["video01"]["images"]


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
    assert check_project_content(changed(FILM, 'duration="18"', 'duration="17"')) == [
        at(FILM, '<seedance:ReferenceVideo id="video01"', "duration 写的是 17，这组镜头是 18 秒")
    ]
    assert "写法错误" in check_project_content('<?icml using="@iclip/markup@1"?>\n<icml>')[0]


def test_saving_the_run_file_checks_that_file_alone() -> None:
    assert check_run_content(RUN) == []
    # 选用的节点存不存在要对照工程文件，保存时不查。
    assert check_run_content(RUN.replace("personB.image", "不存在的节点.image")) == []
    assert (
        "在这之前没有定义"
        in check_run_content(RUN.replace("image={personB-v1}", "image={没登记}"))[0]
    )
