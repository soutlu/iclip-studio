"""验证工程文件的两件工具：check_film 报出问题或概况，generate_images 给生图节点出图。"""

from __future__ import annotations

import uuid

import pytest
from pydantic_ai import ModelRetry
from pydantic_ai.messages import ToolReturn
from pydantic_ai.models.test import TestModel
from pydantic_ai.tools import RunContext
from pydantic_ai.usage import RunUsage

from iclip.capabilities.iclip_studio import capability as studio
from iclip.capabilities.iclip_studio.capability import (
    MAX_LISTED_PROBLEMS,
    IclipStudio,
    IclipStudioToolset,
)
from iclip.capabilities.iclip_studio.ports import (
    FailedBreakdown,
    InvalidNodeImageRequest,
    NodeImageJob,
    NodeImageRequest,
)
from iclip.capabilities.workspace.scope import workspace_namespace
from iclip.domains.agents.public import AgentRunDeps
from iclip.domains.identity.models import Principal
from iclip.platform.file_store.store import FileSpace
from iclip.platform.material_ledger.store import Material
from iclip.platform.transcript.display import GenericDisplay, ToolDisplayEntry
from tests.helpers.file_store import FakeFileStore
from tests.helpers.film import (
    FILM,
    GIVEN_IMAGES,
    PERSON_FIRST,
    PERSON_FIXED,
    RUN,
    SHOE_FRONT,
    SHOE_SOLE,
    VIEW_ONE,
)
from tests.helpers.material_ledger import FakeMaterialLedger

USER = uuid.UUID("11111111-1111-1111-1111-111111111111")
PHOTOS = (SHOE_FRONT, SHOE_SOLE)
"""用户给的两张跑鞋照片。"""
NAMESPACE = f"{USER}/thread-1"


class NoBreakdowns:
    """这组测试不拆视频。"""

    async def ensure(self, principal: Principal, video_url: str) -> str | FailedBreakdown:
        raise AssertionError("不该拆视频")


class FakeNodeImages:
    """生成域的替身：记下每次出图请求，按设定给出结果；出图立刻有结论，不用等。"""

    def __init__(self) -> None:
        self.requests: list[NodeImageRequest] = []
        self.failing: dict[str, str] = {}
        """节点名 → 失败原因。"""
        self.rejecting: dict[str, str] = {}
        """节点名 → 受理时就被拒的原因。"""
        self.pending_polls = 0
        """出图先停在进行中几次查询，再给结论。"""
        self.known: set[str] = set()
        """生成记录里有的图片地址。"""
        self._jobs: dict[uuid.UUID, tuple[NodeImageRequest, int]] = {}

    def url_of(self, node: str) -> str:
        count = sum(1 for request in self.requests if request.node == node)
        return f"https://cdn.test/generated/{node}-{count}.png"

    def _settled(self, job_id: uuid.UUID, request: NodeImageRequest) -> NodeImageJob:
        reason = self.failing.get(request.node)
        if reason is not None:
            return NodeImageJob(job_id, "failed", error_message=reason)
        return NodeImageJob(job_id, "completed", output_url=self.url_of(request.node))

    async def submit(self, principal: Principal, request: NodeImageRequest) -> NodeImageJob:
        if request.node in self.rejecting:
            raise InvalidNodeImageRequest(self.rejecting[request.node])
        self.requests.append(request)
        job_id = uuid.uuid4()
        if self.pending_polls:
            self._jobs[job_id] = (request, self.pending_polls)
            return NodeImageJob(job_id, "submitted")
        return self._settled(job_id, request)

    async def get(self, principal: Principal, job_id: uuid.UUID) -> NodeImageJob:
        request, left = self._jobs[job_id]
        if left > 1:
            self._jobs[job_id] = (request, left - 1)
            return NodeImageJob(job_id, "submitted")
        return self._settled(job_id, request)

    async def belongs(self, principal: Principal, conversation_id: str, url: str) -> bool:
        return url in self.known


@pytest.fixture
def images() -> FakeNodeImages:
    return FakeNodeImages()


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


def capability(
    files: FakeFileStore,
    ledger: FakeMaterialLedger,
    images: FakeNodeImages | None = None,
    *,
    can_generate: bool = True,
) -> IclipStudio[object]:
    return IclipStudio[object](
        space=FileSpace(store=files, namespace=workspace_namespace),
        breakdowns=NoBreakdowns(),
        ledger=ledger,
        images=images,
        can_generate=can_generate,
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
    generation: FakeNodeImages | None = None,
) -> IclipStudioToolset[object]:
    if project is not None:
        await files.write(NAMESPACE, "film.icml", project)
    if run is not None:
        await files.write(NAMESPACE, "film.icrun", run)
    await ledger.record(NAMESPACE, [Material(url=url, kind="image") for url in images])
    return capability(files, ledger, generation).get_toolset()


async def test_a_passing_check_reports_one_line_of_counts(
    files: FakeFileStore, ledger: FakeMaterialLedger, ctx: RunContext[object]
) -> None:
    tools = await workspace(files, ledger)

    result = await tools.check_film(ctx)

    assert text_of(result).splitlines() == ["检查通过：6 张图，1 段视频。"]
    assert result.metadata == {"chip": "通过"}


async def test_problems_come_back_with_file_and_line(
    files: FakeFileStore, ledger: FakeMaterialLedger, ctx: RunContext[object]
) -> None:
    broken = FILM.replace('aspect-ratio="3:4" resolution="2k"', 'aspect-ratio="3:4" size="2k"')
    tools = await workspace(files, ledger, project=broken)

    result = await tools.check_film(ctx)

    head, *listed = text_of(result).splitlines()
    assert head == "检查没通过，共 2 处问题："
    assert listed[0].startswith("film.icml 第 ") and "gpt:Image 没有属性 size" in listed[0]
    assert "gpt:Image 缺属性 resolution" in listed[1]
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
    tools = await workspace(files, ledger, images=(*PHOTOS, VIEW_ONE))

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
    await ledger.record(NAMESPACE, [Material(url=SHOE_FRONT, kind="video")])
    tools = await workspace(files, ledger, run=None)

    result = await tools.check_film(ctx)

    line = FILM.count("\n", 0, FILM.index('<media:Image id="跑鞋正面"')) + 1
    assert f"film.icml 第 {line} 行：src 不是这段对话里的图片" in text_of(result)


async def test_show_prints_the_assembled_prompt_of_one_node(
    files: FakeFileStore, ledger: FakeMaterialLedger, ctx: RunContext[object]
) -> None:
    tools = await workspace(files, ledger)

    image = text_of(await tools.check_film(ctx, show="镜02机位图"))
    video = text_of(await tools.check_film(ctx, show="全片"))

    assert "镜02机位图：画幅 9:16，分辨率 2k" in image
    assert (
        f"参考图：@Image1 = {PERSON_FIXED}、@Image2 = {SHOE_FRONT}、@Image3 = {SHOE_SOLE}、"
        f"@Image4 = {VIEW_ONE}"
    ) in image
    assert "跑道和光线与同一场戏的上一个机位保持一致，参考@Image4。" in image
    assert "全片：15 秒，画幅 9:16" in video
    assert f"@Image4 = {VIEW_ONE}" in video
    assert "\n镜头：\n0–2.5秒 参考@Image4，开场" in video
    assert video.splitlines()[-1] == "不要生成字幕，不要生成背景音乐。"


async def test_show_must_name_a_generation_node(
    files: FakeFileStore, ledger: FakeMaterialLedger, ctx: RunContext[object]
) -> None:
    tools = await workspace(files, ledger)

    with pytest.raises(ModelRetry, match="镜04机位图、全片"):
        await tools.check_film(ctx, show="镜02机位图提示词")


async def test_checking_needs_the_project_file(
    files: FakeFileStore, ledger: FakeMaterialLedger, ctx: RunContext[object]
) -> None:
    tools = await workspace(files, ledger, project=None, run=None)

    with pytest.raises(ModelRetry, match=r"没有 film\.icml"):
        await tools.check_film(ctx)


async def test_an_image_edited_elsewhere_in_the_conversation_can_be_registered(
    files: FakeFileStore,
    ledger: FakeMaterialLedger,
    images: FakeNodeImages,
    ctx: RunContext[object],
) -> None:
    # 分镜页的图片编辑出的图不进素材台账，但生成记录里有它。
    images.known = {PERSON_FIXED}
    tools = await workspace(
        files, ledger, images=(*PHOTOS, PERSON_FIRST, VIEW_ONE), generation=images
    )

    assert text_of(await tools.check_film(ctx)).startswith("检查通过")


async def test_listed_nodes_get_one_image_each_and_become_conversation_material(
    files: FakeFileStore,
    ledger: FakeMaterialLedger,
    images: FakeNodeImages,
    ctx: RunContext[object],
) -> None:
    tools = await workspace(files, ledger, run=None, images=PHOTOS, generation=images)

    result = await tools.generate_images(ctx, ["公园跑道参考图", "短发女生参考图"])

    person, track = images.requests
    assert (person.node, person.model, person.aspect_ratio, person.resolution) == (
        "短发女生参考图",
        "gpt-image-2.5",
        "3:4",
        "2k",
    )
    assert person.reference_image_urls == ()
    assert person.prompt.startswith("拍摄：\n画面是用手机实拍的") and "东亚女性" in person.prompt
    assert (person.user_name, person.conversation_id) == ("logan", "thread-1")
    assert track.node == "公园跑道参考图"
    made = [images.url_of("短发女生参考图"), images.url_of("公园跑道参考图")]
    assert text_of(result).splitlines() == [
        "生成结束：2 张成功，0 张失败，0 个没有生成。",
        f"短发女生参考图：已生成，地址 {made[0]}",
        f"公园跑道参考图：已生成，地址 {made[1]}",
    ]
    assert result.metadata == {
        "items": [
            {"url": made[0], "caption": "短发女生参考图"},
            {"url": made[1], "caption": "公园跑道参考图"},
        ],
        "note": "2 张",
    }
    assert ledger.urls(NAMESPACE) >= set(made), "生成出来的图登记成对话素材，后面的工具才认"


async def test_images_generated_in_the_same_call_do_not_use_each_other(
    files: FakeFileStore,
    ledger: FakeMaterialLedger,
    images: FakeNodeImages,
    ctx: RunContext[object],
) -> None:
    tools = await workspace(files, ledger, run=None, images=PHOTOS, generation=images)

    result = await tools.generate_images(ctx, ["镜02机位图", "镜01机位图", "短发女生参考图"])

    assert [request.node for request in images.requests] == [
        "短发女生参考图",
        "镜01机位图",
        "镜02机位图",
    ]
    # 生成出来的要选用才算有图：同一次里先出的人物图和镜01，镜02 也只用文字写。
    assert images.requests[1].reference_image_urls == PHOTOS
    assert images.requests[2].reference_image_urls == PHOTOS
    assert "跑道和光线与同一场戏的上一个机位保持一致" not in images.requests[2].prompt
    lines = text_of(result).splitlines()
    assert lines[3].startswith("镜02机位图：已生成")
    assert "公园跑道参考图、短发女生参考图、镜01机位图 还没有图，这次只用了文字" in lines[3]


async def test_a_node_with_a_selection_in_the_run_file_is_not_generated(
    files: FakeFileStore,
    ledger: FakeMaterialLedger,
    images: FakeNodeImages,
    ctx: RunContext[object],
) -> None:
    tools = await workspace(files, ledger, generation=images)

    result = await tools.generate_images(ctx, ["短发女生参考图", "公园跑道参考图"])

    assert [request.node for request in images.requests] == ["公园跑道参考图"]
    lines = text_of(result).splitlines()
    assert lines[0] == "生成结束：1 张成功，0 张失败，1 个没有生成。"
    assert lines[1] == (
        "短发女生参考图：没有生成，运行文件里选用了「短发女生修过手」；要重新生成先删掉它的 use"
    )


async def test_one_failure_does_not_stop_the_others(
    files: FakeFileStore,
    ledger: FakeMaterialLedger,
    images: FakeNodeImages,
    ctx: RunContext[object],
) -> None:
    images.failing = {"短发女生参考图": "上游报告生成失败"}
    images.rejecting = {"公园跑道参考图": "图片生成仅支持模型 nano_banana_pro"}
    tools = await workspace(files, ledger, run=None, images=PHOTOS, generation=images)

    result = await tools.generate_images(ctx, ["短发女生参考图", "公园跑道参考图", "镜01机位图"])

    lines = text_of(result).splitlines()
    assert lines[0] == "生成结束：1 张成功，2 张失败，0 个没有生成。"
    assert lines[1] == "短发女生参考图：生成失败，上游报告生成失败"
    assert lines[2] == "公园跑道参考图：生成失败，请求被拒：图片生成仅支持模型 nano_banana_pro"
    assert lines[3].startswith("镜01机位图：已生成")
    assert "公园跑道参考图、短发女生参考图 还没有图，这次只用了文字" in lines[3]
    assert ledger.urls(NAMESPACE) == {*PHOTOS, images.url_of("镜01机位图")}


async def test_generation_waits_for_a_job_that_is_still_running(
    files: FakeFileStore,
    ledger: FakeMaterialLedger,
    images: FakeNodeImages,
    ctx: RunContext[object],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(studio, "IMAGE_POLL_SECONDS", 0.0)
    images.pending_polls = 2
    tools = await workspace(files, ledger, run=None, images=PHOTOS, generation=images)

    result = await tools.generate_images(ctx, ["公园跑道参考图"])

    assert text_of(result).splitlines()[0] == "生成结束：1 张成功，0 张失败，0 个没有生成。"


async def test_a_job_that_outlasts_the_wait_is_reported_and_left_running(
    files: FakeFileStore,
    ledger: FakeMaterialLedger,
    images: FakeNodeImages,
    ctx: RunContext[object],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(studio, "IMAGE_WAIT_SECONDS", 0.0)
    images.pending_polls = 5
    tools = await workspace(files, ledger, run=None, images=PHOTOS, generation=images)

    result = await tools.generate_images(ctx, ["公园跑道参考图"])

    assert "公园跑道参考图：生成失败，等超时了" in text_of(result)
    assert ledger.urls(NAMESPACE) == set(PHOTOS)


@pytest.mark.parametrize(
    ("nodes", "message"),
    [
        ([], "1–10 个不重复的生图节点名"),
        (["镜01机位图", "镜01机位图"], "1–10 个不重复的生图节点名"),
        ([f"图{n}" for n in range(11)], "1–10 个不重复的生图节点名"),
        (["镜01机位图提示词", "全片"], "镜01机位图提示词、全片 不是生图节点"),
    ],
)
async def test_nodes_must_name_image_nodes(
    files: FakeFileStore,
    ledger: FakeMaterialLedger,
    images: FakeNodeImages,
    ctx: RunContext[object],
    nodes: list[str],
    message: str,
) -> None:
    tools = await workspace(files, ledger, generation=images)

    with pytest.raises(ModelRetry, match=message):
        await tools.generate_images(ctx, nodes)
    assert images.requests == []


async def test_nothing_is_generated_while_the_check_fails(
    files: FakeFileStore,
    ledger: FakeMaterialLedger,
    images: FakeNodeImages,
    ctx: RunContext[object],
) -> None:
    broken = FILM.replace('duration="15"', 'duration="14"')
    tools = await workspace(files, ledger, project=broken, generation=images)

    with pytest.raises(ModelRetry, match="检查没通过，没有生成"):
        await tools.generate_images(ctx, ["公园跑道参考图"])
    assert images.requests == []


def test_the_generate_tool_is_offered_only_when_its_model_is_connected(
    files: FakeFileStore, ledger: FakeMaterialLedger, images: FakeNodeImages
) -> None:
    def offered(studio_capability: IclipStudio[object]) -> bool:
        return "generate_images" in studio_capability.get_toolset().tools

    assert offered(capability(files, ledger, images))
    assert not offered(capability(files, ledger, images, can_generate=False))
    assert not offered(capability(files, ledger, None))


def test_the_tool_cards_name_the_file_they_work_on(
    files: FakeFileStore, ledger: FakeMaterialLedger
) -> None:
    table = capability(files, ledger).display_table()

    check, generate = table["check_film"], table["generate_images"]
    assert callable(check)
    assert check({}) == GenericDisplay(summary="检查工程", detail="film.icml")
    assert isinstance(generate, ToolDisplayEntry)
    assert generate.view == "media_grid"
    assert generate.draw({"nodes": ["镜01机位图", "镜02机位图"]}) == GenericDisplay(
        summary="生成图片", detail="镜01机位图、镜02机位图"
    )
