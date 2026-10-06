"""验证工程文件的两件工具：check_film 报出问题或概况，export_shots 写出分镜文件。"""

from __future__ import annotations

import json
import uuid

import httpx
import pytest
from pydantic_ai import ModelRetry
from pydantic_ai.messages import ToolReturn
from pydantic_ai.models.test import TestModel
from pydantic_ai.tools import RunContext
from pydantic_ai.usage import RunUsage

from iclip.capabilities.iclip_studio.breakdown.model import ArkBreakdownModel
from iclip.capabilities.iclip_studio.breakdown.service import VideoBreakdown
from iclip.capabilities.iclip_studio.capability import (
    MAX_LISTED_PROBLEMS,
    IclipStudio,
    IclipStudioToolset,
)
from iclip.capabilities.iclip_studio.ports import SampledVideo
from iclip.capabilities.shot_document import SHOTS_PATH, validate_shots_document
from iclip.capabilities.workspace.scope import workspace_namespace
from iclip.domains.agents.public import AgentRunDeps
from iclip.domains.identity.models import Principal
from iclip.platform.file_store.store import FileSpace
from iclip.platform.material_ledger.store import Material
from iclip.platform.transcript.display import GenericDisplay
from tests.helpers.file_store import FakeFileStore
from tests.helpers.film import FILM, GIVEN_IMAGES, PERSON_FIXED, RUN, SHOE_PHOTO, VIEW_ONE
from tests.helpers.material_ledger import FakeMaterialLedger

USER = uuid.UUID("11111111-1111-1111-1111-111111111111")
NAMESPACE = f"{USER}/thread-1"


class NoSampler:
    """这组测试不拆视频。"""

    async def duration_seconds(self, video_url: str) -> float:
        raise AssertionError("不该读视频")

    async def sample(self, video_url: str) -> SampledVideo:
        raise AssertionError("不该抽帧")


class NoShared:
    async def get(self, video_url: str) -> str | None:
        raise AssertionError("不该查共用的拆解")

    async def put(self, video_url: str, document: str) -> None:
        raise AssertionError("不该存共用的拆解")


@pytest.fixture
def files() -> FakeFileStore:
    return FakeFileStore()


@pytest.fixture
def ledger() -> FakeMaterialLedger:
    return FakeMaterialLedger()


@pytest.fixture
def ctx() -> RunContext[object]:
    deps = AgentRunDeps(
        principal=Principal(
            kind="user",
            user_id=USER,
            permissions=frozenset({"agent:run"}),
            audit_label="logan",
            api_key_id=None,
        ),
        conversation_id="thread-1",
        user_name="logan",
    )
    return RunContext[object](deps=deps, model=TestModel(), usage=RunUsage(), messages=[])


def capability(files: FakeFileStore, ledger: FakeMaterialLedger) -> IclipStudio[object]:
    model = ArkBreakdownModel(
        httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(500))),
        url="https://vision.test/responses",
        api_key="ark",
        model="seed-vision",
    )
    return IclipStudio[object](
        space=FileSpace(store=files, namespace=workspace_namespace),
        breakdown=VideoBreakdown(model=model, sampler=NoSampler()),
        shared=NoShared(),
        ledger=ledger,
    )


def text_of(result: ToolReturn[str]) -> str:
    """给模型看的那段文字；return_value 是联合类型，先收窄。"""

    assert isinstance(result.return_value, str)
    return result.return_value


async def workspace(
    files: FakeFileStore,
    ledger: FakeMaterialLedger,
    *,
    project: str | None = FILM,
    run: str | None = RUN,
    images: tuple[str, ...] = GIVEN_IMAGES,
) -> IclipStudioToolset[object]:
    if project is not None:
        await files.write(NAMESPACE, "film.icml", project)
    if run is not None:
        await files.write(NAMESPACE, "film.icrun", run)
    await ledger.record(NAMESPACE, [Material(url=url, kind="image") for url in images])
    return capability(files, ledger).get_toolset()


async def test_a_passing_check_lists_which_image_each_node_uses(
    files: FakeFileStore, ledger: FakeMaterialLedger, ctx: RunContext[object]
) -> None:
    tools = await workspace(files, ledger)

    result = await tools.check_film(ctx)

    assert text_of(result).splitlines() == [
        "检查通过：4 个生图节点，1 次视频请求。",
        "短发女生参考图：运行文件选用「短发女生修过手」",
        "公园跑道参考图：还没有图",
        "镜01机位图：运行文件选用「镜01第一版」",
        "镜02机位图：还没有图",
    ]
    assert result.metadata == {"chip": "通过"}


async def test_problems_come_back_with_file_and_line(
    files: FakeFileStore, ledger: FakeMaterialLedger, ctx: RunContext[object]
) -> None:
    broken = FILM.replace(
        '<Element id="网面跑鞋" type="产品">', '<Element id="网面跑鞋" kind="产品">'
    )
    tools = await workspace(files, ledger, project=broken)

    result = await tools.check_film(ctx)

    head, *listed = text_of(result).splitlines()
    assert head == "检查没通过，共 2 处问题："
    assert listed[0].startswith("film.icml 第 ") and "Element 没有属性 kind" in listed[0]
    assert "Element 缺属性 type" in listed[1]
    assert result.metadata == {"chip": "2 处问题"}


async def test_a_long_list_of_problems_is_cut(
    files: FakeFileStore, ledger: FakeMaterialLedger, ctx: RunContext[object]
) -> None:
    noise = "".join(f'  <text:Value id="拍摄" extra="{n}"/>\n' for n in range(40))
    tools = await workspace(files, ledger, project=FILM.replace("</icml>", noise + "</icml>"))

    lines = text_of(await tools.check_film(ctx)).splitlines()

    assert lines[0] == "检查没通过，共 80 处问题："
    assert len(lines) == MAX_LISTED_PROBLEMS + 2
    assert lines[-1] == f"只列了前 {MAX_LISTED_PROBLEMS} 处，改完再检查。"


async def test_the_run_file_is_checked_together_with_the_project_file(
    files: FakeFileStore, ledger: FakeMaterialLedger, ctx: RunContext[object]
) -> None:
    tools = await workspace(
        files, ledger, run=RUN.replace("短发女生参考图.image", "短发女生定妆图.image")
    )

    result = await tools.check_film(ctx)

    assert "film.icrun 第 10 行：output 要写 film.icml 里生图节点的输出" in text_of(result)


async def test_an_address_from_outside_the_conversation_is_refused_without_echoing_it(
    files: FakeFileStore, ledger: FakeMaterialLedger, ctx: RunContext[object]
) -> None:
    tools = await workspace(files, ledger, images=(SHOE_PHOTO, VIEW_ONE))

    result = await tools.check_film(ctx)

    lines = text_of(result).splitlines()
    assert lines[0] == "检查没通过，共 2 处问题："
    assert all(
        line.startswith("film.icrun 第 ") and "src 不是这段对话里的图片" in line
        for line in lines[1:]
    )
    assert "cdn.test" not in text_of(result)


async def test_a_video_address_cannot_stand_in_for_an_image(
    files: FakeFileStore, ledger: FakeMaterialLedger, ctx: RunContext[object]
) -> None:
    await ledger.record(NAMESPACE, [Material(url=SHOE_PHOTO, kind="video")])
    tools = await workspace(files, ledger, run=None)

    result = await tools.check_film(ctx)

    assert "film.icml 第 16 行：src 不是这段对话里的图片" in text_of(result)


async def test_show_prints_the_assembled_prompt_of_one_node(
    files: FakeFileStore, ledger: FakeMaterialLedger, ctx: RunContext[object]
) -> None:
    tools = await workspace(files, ledger)

    image = text_of(await tools.check_film(ctx, show="镜02机位图"))
    video = text_of(await tools.check_film(ctx, show="全片"))

    assert "镜02机位图：画幅 9:16，尺寸 1152x2048" in image
    assert f"参考图：图1 = {PERSON_FIXED}、图2 = {SHOE_PHOTO}、图3 = {VIEW_ONE}" in image
    assert "图3：同一场戏的上一个机位" in image
    assert "全片：15 秒，画幅 9:16" in video
    assert f"@Image3 = {VIEW_ONE}" in video
    assert video.splitlines()[-1] == "不要生成字幕，不要生成背景音乐。"


async def test_show_must_name_a_generation_node(
    files: FakeFileStore, ledger: FakeMaterialLedger, ctx: RunContext[object]
) -> None:
    tools = await workspace(files, ledger)

    with pytest.raises(ModelRetry, match="镜02机位图、全片"):
        await tools.check_film(ctx, show="镜02机位图提示词")


async def test_checking_needs_the_project_file(
    files: FakeFileStore, ledger: FakeMaterialLedger, ctx: RunContext[object]
) -> None:
    tools = await workspace(files, ledger, project=None, run=None)

    with pytest.raises(ModelRetry, match=r"没有 film\.icml"):
        await tools.check_film(ctx)


async def test_export_writes_the_shot_file_the_storyboard_page_reads(
    files: FakeFileStore, ledger: FakeMaterialLedger, ctx: RunContext[object]
) -> None:
    tools = await workspace(files, ledger)

    result = await tools.export_shots(ctx)

    stored = await files.read(NAMESPACE, SHOTS_PATH)
    assert stored is not None
    document = validate_shots_document(stored.content)
    (row,) = document.shots
    assert (row.model, row.seconds) == ("mmt-seedance-2-5", 15)
    assert row.image_urls == [PERSON_FIXED, SHOE_PHOTO, VIEW_ONE]
    assert json.loads(stored.content)["aspect_ratio"] == "9:16"
    assert text_of(result) == (
        "已导出到 video_shot.json：1 个镜头组，4 个镜头，合计 15 秒，带 3 张参考图。"
    )
    assert result.metadata == {"chip": "1 组 · 4 镜 · 15 秒"}


async def test_export_replaces_the_previous_shot_file(
    files: FakeFileStore, ledger: FakeMaterialLedger, ctx: RunContext[object]
) -> None:
    tools = await workspace(files, ledger)
    await files.write(NAMESPACE, SHOTS_PATH, "{}")

    await tools.export_shots(ctx)

    stored = await files.read(NAMESPACE, SHOTS_PATH)
    assert stored is not None and stored.version == 2
    validate_shots_document(stored.content)


async def test_nothing_is_exported_while_the_check_fails(
    files: FakeFileStore, ledger: FakeMaterialLedger, ctx: RunContext[object]
) -> None:
    tools = await workspace(files, ledger, project=FILM.replace('duration="15"', 'duration="14"'))

    with pytest.raises(ModelRetry, match="检查没通过，没有导出") as raised:
        await tools.export_shots(ctx)

    assert "这组镜头是 15 秒" in str(raised.value)
    assert await files.read(NAMESPACE, SHOTS_PATH) is None


async def test_a_project_without_a_video_cannot_be_exported(
    files: FakeFileStore, ledger: FakeMaterialLedger, ctx: RunContext[object]
) -> None:
    images_only = FILM[: FILM.index("  <Storyboard")] + "</icml>\n"
    script = images_only[images_only.index("  <Script>") : images_only.index("</Script>") + 10]
    tools = await workspace(files, ledger, project=images_only.replace(script, ""), run=None)

    with pytest.raises(ModelRetry, match="没有视频节点"):
        await tools.export_shots(ctx)


def test_the_tool_cards_name_the_file_they_work_on(
    files: FakeFileStore, ledger: FakeMaterialLedger
) -> None:
    table = capability(files, ledger).display_table()

    assert table["check_film"]({}) == GenericDisplay(summary="检查工程", detail="film.icml")
    assert table["export_shots"]({}) == GenericDisplay(summary="导出分镜", detail="video_shot.json")
