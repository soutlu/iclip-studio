"""工程文件与运行文件的样例：一条 15 秒的跑鞋片，供运行时和工具的测试共用。

工程文件里有四个生图节点和一次视频请求；运行文件登记了三张图，给「短发女生参考图」和
「镜01机位图」各选用一张，「公园跑道参考图」和「镜02机位图」还没有图。"""

from __future__ import annotations

from typing import Final

SHOE_PHOTO: Final = "https://mmt-aigc-sz-public.oss-cn-shenzhen.aliyuncs.com/iclip/agent/uploads/1f0c2a9e-6b1d-4c55-9a77-3e8f0d2b7c41.jpg"
PERSON_FIRST: Final = "https://cdn.test/a.png"
PERSON_FIXED: Final = "https://cdn.test/b-fixed.png"
VIEW_ONE: Final = "https://cdn.test/view01.png"

GIVEN_IMAGES: Final = (SHOE_PHOTO, PERSON_FIRST, PERSON_FIXED, VIEW_ONE)
"""两个文件里写了地址的图，工具测试把它们登记成对话素材。"""

FILM: Final = """<?icml using="@iclip/markup@1"?>
<icml>
  <import from="@iclip/director@1"/>
  <import as="text" from="@iclip/text@1"/>
  <import as="media" from="@iclip/media@1"/>
  <import as="gpt" from="@iclip/gpt-image@1"/>
  <import as="seedance" from="@iclip/seedance@1"/>

  <!-- 一、内容：照抄执行方案 -->
  <text:Value id="拍摄与剪辑">
    摄影：手机拍摄，手持跟拍，带轻微呼吸感；景别以中近景和鞋部特写为主。
    剪辑：全片硬切，快节奏，平均每镜三到四秒，在动作点上剪。
    影调：清晨自然光，低对比，不做风格化调色。
  </text:Value>
  <text:Value id="配乐">纯音乐，二十秒，轻快放克，拨弦贝斯与电吉他切音，轻快节奏，松弛有活力，适合跑鞋种草短视频的背景音乐，录音室品质，真实乐器演奏，混音干净，低频扎实，高频通透，立体声饱满</text:Value>
  <media:Image id="跑鞋照片" src="https://mmt-aigc-sz-public.oss-cn-shenzhen.aliyuncs.com/iclip/agent/uploads/1f0c2a9e-6b1d-4c55-9a77-3e8f0d2b7c41.jpg"/>

  <Element id="短发女生" type="人物">东亚女性，二十出头；鹅蛋脸，单眼皮，细长眉，淡妆；黑色齐耳短发，中分。She has a slim, well-proportioned figure, very broad shoulders and excellent head-to-shoulder proportions. 上身穿浅灰色速干短袖T恤，下身穿黑色及膝运动短裤，左手腕戴一块白色运动手表</Element>
  <Element id="网面跑鞋" type="产品">一双低帮跑步鞋，鞋头圆润，鞋面是透气网布，中底加厚，外底有横向防滑纹；鞋面浅蓝色，中底白色，鞋带白色；鞋舌上印一行小字「AIRLITE」，侧面有一道银灰色反光条</Element>
  <Element id="公园跑道" type="场景">城市社区公园里的一条红色塑胶跑道。跑道边有一排木长椅和垃圾桶，跑道外侧是修剪整齐的草坪，远处是一排梧桐树和几栋浅色公寓楼</Element>

  <Voice role="短发女生">年轻女性甜而清亮的声音，高音区明亮。口语化的美式英语，灵巧俏皮，像朋友兴奋地告诉你一个新发现。</Voice>
  <Voice role="旁白">成熟男性圆润厚实的中低音。清晰松弛的英式英语，不紧不慢，像坐在对面认真地跟你讲他的判断。</Voice>

  <Script>
    <Line id="lighter" role="短发女生">It's lighter than it looks.</Line>
    <Line id="rebound" role="旁白">Every step gives a little back, so you'll run longer.</Line>
    <Line id="miles" role="短发女生">Five miles, and my feet don't hurt.</Line>
    <Line id="shop" role="旁白">Light &amp; fast — grab yours before the weekend.</Line>
  </Script>

  <!-- 二、图：先拼提示词，再生成。生不生成由用户定 -->
  <text:Value id="拍摄">画面是用手机实拍的，真实自然，没有过度美颜。</text:Value>

  <!-- 参考图：没有素材的人物和场景各一张 -->
  <Picture id="短发女生参考图提示词">
    <Cast element={短发女生}/>
    <Block name="拍摄" text={拍摄}>人物清楚。光线是柔和均匀的室内光。</Block>
    <Block name="取景">全身入画。她站在画面正中，脸正对镜头，双手自然下垂。</Block>
    <Block name="环境">摄影棚。她身后是一面浅灰色的墙，脚下是同色的地面。</Block>
  </Picture>
  <gpt:Image id="短发女生参考图" prompt={短发女生参考图提示词} aspect-ratio="3:4" resolution="2k"/>

  <Picture id="公园跑道参考图提示词">
    <Cast element={公园跑道}/>
    <Block name="拍摄" text={拍摄}>背景清楚。光线是清晨的自然光。</Block>
    <Block name="取景">从跑道边平视过去，画面里没有人。</Block>
  </Picture>
  <gpt:Image id="公园跑道参考图" prompt={公园跑道参考图提示词} aspect-ratio="9:16" resolution="2k"/>

  <!-- 机位图：一个镜头一张（这里只列前两镜） -->
  <Picture id="镜01机位图提示词">
    <Cast element={短发女生} image={短发女生参考图.image}/>
    <Cast element={网面跑鞋} image={跑鞋照片}/>
    <Cast element={公园跑道} image={公园跑道参考图.image}/>
    <Block name="拍摄" text={拍摄}>人物清楚，背景略微虚化。光线是清晨的自然光。</Block>
    <Block name="取景">胸部以上近景，平视。她站在画面正中，脸正对镜头，双手分别握住一只鞋的鞋头和鞋跟，把鞋横举在胸前。</Block>
    <Block name="环境">她站在跑道边，身后是那排木长椅。</Block>
  </Picture>
  <gpt:Image id="镜01机位图" prompt={镜01机位图提示词} aspect-ratio="9:16" resolution="2k"/>

  <Picture id="镜02机位图提示词">
    <Cast element={短发女生} image={短发女生参考图.image}/>
    <Cast element={网面跑鞋} image={跑鞋照片}/>
    <Cast element={公园跑道} image={公园跑道参考图.image}/>
    <Reference image={镜01机位图.image}>同一场戏的上一个机位，跑道和光线与它保持一致。</Reference>
    <Block name="拍摄" text={拍摄}>鞋清楚，背景略微虚化。光线是清晨的自然光。</Block>
    <Block name="取景">低机位，脚部特写，只拍到她膝盖以下。她穿着这双鞋在跑道上从画面左侧跑向右侧，右脚刚落地。</Block>
  </Picture>
  <gpt:Image id="镜02机位图" prompt={镜02机位图提示词} aspect-ratio="9:16" resolution="2k"/>

  <!-- 三、视频：镜头里只写名字 -->
  <Storyboard id="全片分镜">
    <Cast element={短发女生} image={短发女生参考图.image}/>
    <Cast element={网面跑鞋} image={跑鞋照片}/>
    <Cast element={公园跑道} image={公园跑道参考图.image}/>
    <Block name="拍摄与剪辑" text={拍摄与剪辑}/>
    <Shot start="0.0" end="2.5" view={镜01机位图.image}>开场，手持，胸部以上近景，平视。短发女生站在跑道边，双手分别握住网面跑鞋的鞋头和鞋跟，向内对折到两端相碰，停了一下后松开右手，鞋底立刻弹回平直。她抬头看着镜头说：{lighter} 音效：鞋底弹回时的一声轻响</Shot>
    <Shot start="2.5" end="6.0" view={镜02机位图.image}>硬切，手持，低机位，脚部特写，跟拍向前。短发女生穿着网面跑鞋在公园跑道上慢跑，每一步落地时中底先压扁一点再弹起。旁白：{rebound} 音效：鞋底踩在塑胶跑道上的轻响</Shot>
    <Shot start="6.0" end="10.0">硬切，手持，全景，平视。短发女生沿着跑道向镜头跑来，跑到镜头前停下，双手叉腰喘了口气，低头看了一眼左手腕的手表，笑着对镜头说：{miles} 音效：连续的脚步声</Shot>
    <Shot start="10.0" end="15.0">硬切，固定机位，产品特写。网面跑鞋摆在跑道边的木长椅上，鞋头朝向镜头。短发女生的右手从画面右侧伸进来，拿起左脚那只鞋。旁白：{shop}</Shot>
  </Storyboard>
  <seedance:ReferenceVideo id="全片" model="2.5" prompt={全片分镜} duration="15" aspect-ratio="9:16"/>
</icml>
"""

RUN: Final = """<?icml using="@iclip/run-markup@1"?>
<icrun version="1">
  <film source="./film.icml"/>
  <import as="media" from="@iclip/media@1"/>

  <media:Image id="短发女生第一版" src="https://cdn.test/a.png"/>
  <media:Image id="短发女生修过手" src="https://cdn.test/b-fixed.png"/>
  <media:Image id="镜01第一版" src="https://cdn.test/view01.png"/>

  <use output="短发女生参考图.image" image={短发女生修过手}/>
  <use output="镜01机位图.image" image={镜01第一版}/>
</icrun>
"""

SECOND_STORYBOARD: Final = """
  <Storyboard id="后半分镜">
    <Cast element={网面跑鞋} image={跑鞋照片}/>
    <Block name="拍摄与剪辑" text={拍摄与剪辑}/>
    <Shot start="0.0" end="16.0">硬切，固定机位，产品特写。网面跑鞋放在桌面上，缓慢转动一圈。音效：鞋底落在桌面上的一声轻响</Shot>
  </Storyboard>
  <seedance:ReferenceVideo id="后半" model="2.5" prompt={后半分镜} duration="16" aspect-ratio="9:16"/>
</icml>"""
"""接在工程文件末尾的第二次视频请求，时间从 0.0 开始。"""


def two_requests() -> str:
    """把样例改成 36 秒、拆成两次视频请求的工程文件。"""

    first = FILM.replace('<Shot start="10.0" end="15.0">', '<Shot start="10.0" end="20.0">')
    return first.replace('duration="15"', 'duration="20"').replace("</icml>", SECOND_STORYBOARD)


__all__ = [
    "FILM",
    "GIVEN_IMAGES",
    "PERSON_FIRST",
    "PERSON_FIXED",
    "RUN",
    "SECOND_STORYBOARD",
    "SHOE_PHOTO",
    "VIEW_ONE",
    "two_requests",
]
