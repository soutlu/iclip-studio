from __future__ import annotations

import uuid

import httpx
import pytest
from agent_runtime.file_store.store import FileSpace
from agent_runtime.plugins.workspace.scope import workspace_namespace
from agent_runtime.run_deps import AgentRunDeps
from pydantic_ai import ModelRetry
from pydantic_ai.messages import ToolReturn
from pydantic_ai.models.test import TestModel
from pydantic_ai.tools import RunContext
from pydantic_ai.usage import RunUsage

from iclip_video.iclip_studio import capability as studio
from iclip_video.iclip_studio.capability import (
    IclipStudio,
    IclipStudioToolset,
)
from iclip_video.iclip_studio.film.checks import check
from iclip_video.iclip_studio.film.film import Film
from iclip_video.iclip_studio.film.load import load_film
from iclip_video.iclip_studio.film.prompts import render_picture, render_video
from iclip_video.iclip_studio.ports import (
    InvalidNodeImageRequest,
    NodeImageJob,
    NodeImageRequest,
)
from iclip_video.shot_prompt import OUTPUT_CONSTRAINT, format_shot_prompt
from tests.helpers.file_store import FakeFileStore
from tests.helpers.film import (
    EXPECTED,
    FILM,
    GENERATED,
    PHOTOS,
    RUN,
    SHOE_FRONT,
    run_of,
)
from tests.helpers.media_probe import ScriptedMedia

USER = uuid.UUID("11111111-1111-1111-1111-111111111111")
PHOTO_URLS = tuple(PHOTOS.values())
NAMESPACE = f"{USER}/thread-1"


class FakeNodeImages:
    def __init__(self) -> None:
        self.requests: list[NodeImageRequest] = []
        self.failing: dict[str, str] = {}
        self.rejecting: dict[str, str] = {}
        self.pending_polls = 0
        self._jobs: dict[uuid.UUID, tuple[NodeImageRequest, int]] = {}

    def url_of(self, node: str) -> str:
        count = sum(1 for request in self.requests if request.node == node)
        return f"https://cdn.test/generated/{node}-{count}.png"

    def _settled(self, job_id: uuid.UUID, request: NodeImageRequest) -> NodeImageJob:
        reason = self.failing.get(request.node)
        if reason is not None:
            return NodeImageJob(job_id, "failed", error_message=reason)
        return NodeImageJob(job_id, "completed", output_url=self.url_of(request.node))

    async def submit(self, user_id: uuid.UUID, request: NodeImageRequest) -> NodeImageJob:
        if request.node in self.rejecting:
            raise InvalidNodeImageRequest(self.rejecting[request.node])
        self.requests.append(request)
        job_id = uuid.uuid4()
        if self.pending_polls:
            self._jobs[job_id] = (request, self.pending_polls)
            return NodeImageJob(job_id, "submitted")
        return self._settled(job_id, request)

    async def get(self, user_id: uuid.UUID, job_id: uuid.UUID) -> NodeImageJob:
        request, left = self._jobs[job_id]
        if left > 1:
            self._jobs[job_id] = (request, left - 1)
            return NodeImageJob(job_id, "submitted")
        return self._settled(job_id, request)


@pytest.fixture
def images() -> FakeNodeImages:
    return FakeNodeImages()


@pytest.fixture
def files() -> FakeFileStore:
    return FakeFileStore()


@pytest.fixture
def ctx() -> RunContext[object]:
    deps = AgentRunDeps(user_id=USER, conversation_id="thread-1", user_name="logan")
    return RunContext[object](deps=deps, model=TestModel(), usage=RunUsage(), messages=[])


def capability(
    files: FakeFileStore,
    images: FakeNodeImages | None = None,
    *,
    can_generate: bool = True,
) -> IclipStudio[object]:
    return IclipStudio[object](
        space=FileSpace(store=files, namespace=workspace_namespace),
        images=images,
        can_generate=can_generate,
    )


def text_of(result: ToolReturn[str]) -> str:
    assert isinstance(result.return_value, str)
    return result.return_value


def without_uses(*nodes: str) -> str:
    run = RUN
    for node in nodes:
        use = f'  <use output="{node}.image" image={{{node}-v1}}/>\n'
        assert use in run, node
        run = run.replace(use, "")
    return run


async def workspace(
    files: FakeFileStore,
    *,
    project: str | None = FILM,
    run: str | None = RUN,
    generation: FakeNodeImages | None = None,
) -> IclipStudioToolset[object]:
    if project is not None:
        await files.write(NAMESPACE, "film.icml", project)
    if run is not None:
        await files.write(NAMESPACE, "film.icrun", run)
    return capability(files, generation).get_toolset()


async def test_problems_come_back_with_file_and_line(
    files: FakeFileStore, ctx: RunContext[object]
) -> None:
    broken = FILM.replace('aspect-ratio="3:4" resolution="2k"', 'aspect-ratio="3:4" size="2k"')
    tools = await workspace(files, project=broken)

    result = await tools.check_film(ctx)

    head, *listed = text_of(result).splitlines()
    assert head == "工程规范检查未通过，本次发现 2 处问题："
    assert listed[0].startswith("film.icml 第 ") and "gpt:Image 没有属性 size" in listed[0]
    assert "gpt:Image 缺属性 resolution" in listed[1]
    assert result.metadata == {"chip": "2 处问题"}


async def test_the_run_file_is_checked_together_with_the_project_file(
    files: FakeFileStore, ctx: RunContext[object]
) -> None:
    tools = await workspace(files, run=RUN.replace("personB.image", "personC.image"))

    result = await tools.check_film(ctx)

    assert "film.icrun 第 15 行：film.icml 里没有叫 personC 的生图节点" in text_of(result)


async def test_addresses_that_do_not_open_are_reported_at_their_nodes_without_echoing_them(
    files: FakeFileStore, media: ScriptedMedia, ctx: RunContext[object]
) -> None:
    media.set(GENERATED["personB"], (404, None))
    media.set(GENERATED["scene"], (200, "text/html"))
    tools = await workspace(files)

    lines = text_of(await tools.check_film(ctx)).splitlines()

    assert lines[0] == "工程规范检查未通过，本次发现 2 处问题："
    assert lines[1].startswith("film.icrun 第 ")
    assert lines[1].endswith("src 打不开，换成能打开的图片地址")
    assert lines[2].endswith("src 不是图片，换成能打开的图片地址")
    assert "preview.invalid" not in "\n".join(lines)


async def test_a_video_address_cannot_stand_in_for_an_image(
    files: FakeFileStore, media: ScriptedMedia, ctx: RunContext[object]
) -> None:
    media.set(SHOE_FRONT, (200, "video/mp4"))
    tools = await workspace(files, run=None)

    result = await tools.check_film(ctx)

    line = FILM.count("\n", 0, FILM.index('<media:Image id="shoeFrontPhoto"')) + 1
    assert f"film.icml 第 {line} 行：src 不是图片，换成能打开的图片地址" in text_of(result)


@pytest.mark.parametrize("run", [RUN, None], ids=["both-files", "project-only"])
async def test_the_check_probes_every_address_written_in_the_files_once(
    files: FakeFileStore, media: ScriptedMedia, ctx: RunContext[object], run: str | None
) -> None:
    tools = await workspace(files, run=run)

    assert text_of(await tools.check_film(ctx)).startswith("工程规范检查通过")
    film = check(FILM, run)
    assert isinstance(film, Film)
    written = {node.attrs["src"] for _, node in film.given_images()}
    assert sorted(media.asked) == sorted(written)


async def test_an_address_that_does_not_answer_is_reported_at_its_node(
    files: FakeFileStore, media: ScriptedMedia, ctx: RunContext[object]
) -> None:
    media.set(GENERATED["scene"], httpx.ConnectTimeout("慢"))
    tools = await workspace(files)

    lines = text_of(await tools.check_film(ctx)).splitlines()

    assert lines[0] == "工程规范检查未通过，本次发现 1 处问题："
    assert lines[1].endswith("src 打不开，换成能打开的图片地址")


def test_loading_checks_only_the_structure() -> None:
    film = load_film(FILM.replace(SHOE_FRONT, "https://gone.invalid/x.jpg"), RUN)

    assert isinstance(film, Film)


def film_of(run: str = RUN) -> Film:
    film = check(FILM, run)
    assert isinstance(film, Film) and not film.errors
    return film


async def test_show_prints_the_assembled_prompt_of_one_node(
    files: FakeFileStore, ctx: RunContext[object]
) -> None:
    tools = await workspace(files)

    image = text_of(await tools.check_film(ctx, show="view02"))
    video = text_of(await tools.check_film(ctx, show="video01"))

    names = ("modelAFullBodyPhoto", "shoeSidePhoto", "shoeSolePhoto", "scene", "view01")
    listed = "、".join(
        f"@Image{n} = {name} {url}"
        for n, (name, url) in enumerate(
            zip(names, EXPECTED["images"]["view02"]["input_str_list"], strict=True), start=1
        )
    )
    assert image.splitlines()[2:] == [
        "view02：画幅 16:9，分辨率 2k",
        f"参考图：{listed}",
        "",
        *EXPECTED["images"]["view02"]["prompt"].splitlines(),
    ]
    assert "video01：18 秒，画幅 16:9" in video
    assert f"@Image10 = view03 {GENERATED['view03']}" in video
    film = film_of()
    assert format_shot_prompt(render_video(film, film.project.nodes["video01"])) in video
    assert "\n镜头：\n0–6秒 参考@Image8，中景" in video
    assert video.splitlines()[-1] == OUTPUT_CONSTRAINT


async def test_show_names_the_references_that_have_no_image(
    files: FakeFileStore, ctx: RunContext[object]
) -> None:
    tools = await workspace(files, run=run_of("no-personB"))

    image = text_of(await tools.check_film(ctx, show="view01"))

    assert "@Image3 = personB（尚未选用图片）" in image


async def test_show_takes_several_nodes_and_prints_each_once_in_order(
    files: FakeFileStore, ctx: RunContext[object]
) -> None:
    tools = await workspace(files)

    image = text_of(await tools.check_film(ctx, show="view02"))
    video = text_of(await tools.check_film(ctx, show="video01"))
    both = text_of(await tools.check_film(ctx, show=["view02", "video01", "view02"]))

    assert both.splitlines() == [*image.splitlines(), "", *video.splitlines()[2:]]


async def test_show_must_name_a_generation_node(
    files: FakeFileStore, ctx: RunContext[object]
) -> None:
    tools = await workspace(files)

    with pytest.raises(ModelRetry, match="view06、video01、video02"):
        await tools.check_film(ctx, show="view02Prompt")


async def test_a_wrong_show_is_rejected_before_any_address_is_probed(
    files: FakeFileStore, media: ScriptedMedia, ctx: RunContext[object]
) -> None:
    tools = await workspace(files)

    with pytest.raises(ModelRetry, match="show 要填某张图或某段视频的 id"):
        await tools.check_film(ctx, show=["view02", "view02Prompt"])
    assert media.asked == []


async def test_checking_needs_the_project_file(
    files: FakeFileStore, ctx: RunContext[object]
) -> None:
    tools = await workspace(files, project=None, run=None)

    with pytest.raises(ModelRetry, match=r"没有 film\.icml"):
        await tools.check_film(ctx)


async def test_listed_nodes_get_one_image_each(
    files: FakeFileStore,
    media: ScriptedMedia,
    images: FakeNodeImages,
    ctx: RunContext[object],
) -> None:
    tools = await workspace(files, run=None, generation=images)

    result = await tools.generate_images(ctx, ["scene", "personB"])

    person, scene = images.requests
    assert (person.node, person.model, person.aspect_ratio, person.resolution) == (
        "personB",
        "gpt-image-2.5",
        "3:4",
        "2k",
    )
    assert person.reference_image_urls == ()
    assert person.prompt == EXPECTED["images"]["personB"]["prompt"]
    assert (person.user_name, person.conversation_id) == ("logan", "thread-1")
    assert scene.node == "scene"
    made = [images.url_of("personB"), images.url_of("scene")]
    assert text_of(result).splitlines() == [
        "生成结束：2 张成功，0 张失败，0 个没有生成。",
        f"personB：已生成，地址 {made[0]}",
        f"scene：已生成，地址 {made[1]}",
    ]
    assert result.metadata == {
        "items": [
            {"url": made[0], "caption": "personB"},
            {"url": made[1], "caption": "scene"},
        ],
        "note": "2 张",
    }
    assert media.asked == []


async def test_a_node_whose_references_lack_images_is_not_generated(
    files: FakeFileStore,
    images: FakeNodeImages,
    ctx: RunContext[object],
) -> None:
    tools = await workspace(files, run=None, generation=images)

    result = await tools.generate_images(ctx, ["view02", "view01", "personB"])

    assert [request.node for request in images.requests] == ["personB"]
    assert text_of(result).splitlines()[1:] == [
        f"personB：已生成，地址 {images.url_of('personB')}",
        "view01：没有生成，参考图 personB、scene 还没有选用图",
        "view02：没有生成，参考图 scene、view01 还没有选用图",
    ]
    assert text_of(result).splitlines()[0] == "生成结束：1 张成功，0 张失败，2 个没有生成。"


async def test_a_node_with_a_selection_in_the_run_file_is_not_generated(
    files: FakeFileStore,
    images: FakeNodeImages,
    ctx: RunContext[object],
) -> None:
    tools = await workspace(files, run=without_uses("personB"), generation=images)

    result = await tools.generate_images(ctx, ["personB", "scene"])

    assert [request.node for request in images.requests] == ["personB"]
    lines = text_of(result).splitlines()
    assert lines[0] == "生成结束：1 张成功，0 张失败，1 个没有生成。"
    assert lines[2] == "scene：没有生成，运行文件里选用了「scene-v1」；要重新生成先删掉它的 use"


async def test_one_failure_does_not_stop_the_others(
    files: FakeFileStore,
    media: ScriptedMedia,
    images: FakeNodeImages,
    ctx: RunContext[object],
) -> None:
    images.failing = {"personB": "上游报告生成失败"}
    images.rejecting = {"view05": "图片生成仅支持模型 nano_banana_pro"}
    run = without_uses("personB", "view02", "view05")
    tools = await workspace(files, run=run, generation=images)

    result = await tools.generate_images(ctx, ["view05", "personB", "view02"])

    lines = text_of(result).splitlines()
    assert lines[0] == "生成结束：1 张成功，2 张失败，0 个没有生成。"
    assert lines[1] == "personB：生成失败，上游报告生成失败"
    assert lines[2] == f"view02：已生成，地址 {images.url_of('view02')}"
    assert lines[3] == "view05：生成失败，请求被拒：图片生成仅支持模型 nano_banana_pro"
    (sent,) = [request for request in images.requests if request.node == "view02"]
    assert list(sent.reference_image_urls) == EXPECTED["images"]["view02"]["input_str_list"]
    used = {
        url
        for name in ("view05", "personB", "view02")
        for url in render_picture(film_of(run), film_of(run).project.nodes[name]).image_urls
    }
    assert set(media.asked) == used


async def test_a_reference_that_does_not_open_stops_the_generation_and_names_the_node(
    files: FakeFileStore,
    media: ScriptedMedia,
    images: FakeNodeImages,
    ctx: RunContext[object],
) -> None:
    references = EXPECTED["images"]["view02"]["input_str_list"]
    media.set(references[1], (404, None))
    tools = await workspace(files, run=without_uses("view02"), generation=images)

    with pytest.raises(ModelRetry) as raised:
        await tools.generate_images(ctx, ["view02"])

    assert "view02 的 @Image2：打不开" in str(raised.value)
    assert references[1] not in str(raised.value)
    assert images.requests == []


async def test_generation_waits_for_a_job_that_is_still_running(
    files: FakeFileStore,
    images: FakeNodeImages,
    ctx: RunContext[object],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(studio, "IMAGE_POLL_SECONDS", 0.0)
    images.pending_polls = 2
    tools = await workspace(files, run=None, generation=images)

    result = await tools.generate_images(ctx, ["personB"])

    assert text_of(result).splitlines()[0] == "生成结束：1 张成功，0 张失败，0 个没有生成。"


async def test_a_job_that_outlasts_the_wait_is_reported_and_left_running(
    files: FakeFileStore,
    images: FakeNodeImages,
    ctx: RunContext[object],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(studio, "IMAGE_WAIT_SECONDS", 0.0)
    images.pending_polls = 5
    tools = await workspace(files, run=None, generation=images)

    result = await tools.generate_images(ctx, ["personB"])

    assert "personB：生成失败，等超时了" in text_of(result)


@pytest.mark.parametrize(
    ("nodes", "message"),
    [
        ([], "1–10 个不重复的生图节点名"),
        (["view01", "view01"], "1–10 个不重复的生图节点名"),
        ([f"图{n}" for n in range(11)], "1–10 个不重复的生图节点名"),
        (["view01Prompt", "video01"], "view01Prompt、video01 不是生图节点"),
    ],
)
async def test_nodes_must_name_image_nodes(
    files: FakeFileStore,
    images: FakeNodeImages,
    ctx: RunContext[object],
    nodes: list[str],
    message: str,
) -> None:
    tools = await workspace(files, generation=images)

    with pytest.raises(ModelRetry, match=message):
        await tools.generate_images(ctx, nodes)
    assert images.requests == []


async def test_nothing_is_generated_while_the_check_fails(
    files: FakeFileStore,
    images: FakeNodeImages,
    ctx: RunContext[object],
) -> None:
    broken = FILM.replace('duration="18"', 'duration="17"')
    tools = await workspace(files, project=broken, generation=images)

    with pytest.raises(ModelRetry, match="检查没通过，没有生成"):
        await tools.generate_images(ctx, ["personB"])
    assert images.requests == []


def test_the_generate_tool_is_offered_only_when_its_model_is_connected(
    files: FakeFileStore, images: FakeNodeImages
) -> None:
    def offered(studio_capability: IclipStudio[object]) -> bool:
        return "generate_images" in studio_capability.get_toolset().tools

    assert offered(capability(files, images))
    assert not offered(capability(files, images, can_generate=False))
    assert not offered(capability(files, None))
