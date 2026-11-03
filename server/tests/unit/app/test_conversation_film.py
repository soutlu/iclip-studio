"""验证制作页的组合根适配：从工作区读工程，用到图的那一步查地址，带版本写回，按文件生图与出片。"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass

import pytest
from agent_runtime.errors import Conflict, ValidationFailed
from agent_runtime.file_store.namespace import namespace_for
from agent_runtime.file_store.store import FileEntry, VersionConflict
from iclip_video.film_view import FilmImagePrompt, FilmLineEdit, FilmTextEdit, FilmView
from iclip_video.iclip_studio.film.film import FILM_PATH, RUN_PATH

from iclip.app.conversation_film import ConversationFilmAdapter
from iclip.app.film_images import FILM_NODE_KEY
from iclip.domains.generation.models import STATUS_COMPLETED, GenerationJob, GenerationOutput
from iclip.domains.generation.schemas import KIND_IMAGE, KIND_VIDEO, MAX_PROMPT_CHARS
from iclip.domains.identity.models import Principal
from iclip.platform.outbound.guard import FetchFailed
from tests.helpers.file_store import FakeFileStore
from tests.helpers.film import (
    EXPECTED,
    FILM,
    FILM_NO_VIEW04,
    GENERATED,
    GIVEN_IMAGES,
    RUN,
    RUN_NO_VIEW04,
    SHOE_FRONT,
    VIEW04,
    run_of,
)
from tests.helpers.generation import (
    InMemoryGenerationRepository,
    film_image_service,
    image_request,
    make_job,
)
from tests.helpers.media_probe import NoProbing, ScriptedProbe

OWNER = uuid.UUID("77777777-7777-7777-7777-777777777777")
PRINCIPAL = Principal(
    kind="user",
    user_id=OWNER,
    permissions=frozenset({"agent:read", "agent:run"}),
    audit_label="tester",
    username="tester",
)
CONVERSATION = uuid.uuid4()
NAMESPACE = namespace_for(OWNER, str(CONVERSATION))
GENERATED_SCENE = "https://cdn.test/scene-generated.png"
UPLOADED = "https://cdn.test/iclip/agent/uploads/my-scene.png"
NO_SCENE = RUN.replace('  <use output="scene.image" image={scene-v1}/>\n', "")
"""没有选用 scene 的运行文件。"""

FIRST_SHOT = (
    "参考@Image8，中景，平视，手持跟拍。模特A和模特B在红砖街区的人行道上并肩走向镜头。"
    "模特A低头看鞋说：",
    " 模特B侧头问：",
    " 音效：两人的脚步声与街道环境声。",
)


def say(text: str) -> FilmTextEdit:
    """把第一个镜头里第一句台词改成 ``text``。"""

    return FilmTextEdit(
        "shot:video01Shots:1",
        parts=FIRST_SHOT,
        lines=(FilmLineEdit("line:hook", text), FilmLineEdit("line:reply", "鞋底是软的吗？")),
    )


class RecordingStore(FakeFileStore):
    """写入记下先后，写到 ``failing`` 这个文件时按版本冲突退回。"""

    def __init__(self) -> None:
        super().__init__()
        self.failing: str | None = None
        self.written: list[str] = []

    async def write(
        self, namespace: str, path: str, content: str, *, expected_version: int | None = None
    ) -> FileEntry:
        if path == self.failing:
            # 当作别人刚改过这个文件：两个文件在这些测试里都已存在，写入都带版本号。
            assert expected_version is not None
            # 运行时答 409，客户端还原成 Conflict，原话是存储的版本冲突那句。
            raise Conflict(
                str(VersionConflict(path, expected=expected_version, actual=expected_version + 1))
            )
        entry = await super().write(namespace, path, content, expected_version=expected_version)
        self.written.append(path)
        return entry


@dataclass
class Page:
    adapter: ConversationFilmAdapter
    store: RecordingStore
    probe: ScriptedProbe
    jobs: InMemoryGenerationRepository

    def submitted(self, job_id: uuid.UUID) -> GenerationJob:
        return self.jobs.jobs[job_id]

    async def view(self) -> FilmView:
        found = await self.adapter.view(PRINCIPAL, OWNER, CONVERSATION)
        assert found is not None
        return found

    async def content(self, path: str) -> str | None:
        stored = await self.store.read(NAMESPACE, path)
        return None if stored is None else stored.content


@pytest.fixture(autouse=True)
def retry_at_once(monkeypatch: pytest.MonkeyPatch) -> None:
    """探不通的图片地址不等，直接再探一次（替身每次答得一样）。"""

    monkeypatch.setattr("iclip.platform.outbound.media_check.RETRY_DELAY_SECONDS", 0.0)


async def page(
    files: dict[str, str],
    jobs: Sequence[GenerationJob] = (),
    *,
    with_generation: bool = True,
    image_models: Sequence[str] = ("nano_banana_pro", "gpt-image-2.5"),
) -> Page:
    store = RecordingStore()
    for path, content in files.items():
        await store.write(NAMESPACE, path, content)
    store.written.clear()
    probe = ScriptedProbe()
    repo = InMemoryGenerationRepository(list(jobs))
    generation = film_image_service(repo, image_models=image_models) if with_generation else None
    adapter = ConversationFilmAdapter(store=store, probe=probe, generation=generation)
    return Page(adapter, store, probe, repo)


def generated(node: str, url: str) -> GenerationJob:
    """``node`` 按描述生成成功的一条记录。"""

    return make_job(
        image_request(),
        status=STATUS_COMPLETED,
        owner_user_id=OWNER,
        conversation_id=CONVERSATION,
        metadata={FILM_NODE_KEY: node},
        output=GenerationOutput(url=url),
    )


def frame_url(view: FilmView, node: str, group: int = 0) -> str | None:
    return next(frame.url for frame in view.groups[group].frames if frame.node == node)


async def test_there_is_no_view_without_a_film_file() -> None:
    made = await page({RUN_PATH: RUN})

    assert await made.adapter.view(PRINCIPAL, OWNER, CONVERSATION) is None


async def test_a_film_with_problems_shows_only_how_many() -> None:
    broken = FILM.replace('aspect-ratio="3:4" resolution="2k"', 'aspect-ratio="3:4" size="2k"')
    made = await page({FILM_PATH: broken})

    view = await made.view()

    assert (view.problems, view.groups, view.run_version) == (2, (), None)
    with pytest.raises(ValidationFailed, match="等 AI 导演改好"):
        await made.adapter.edit_text(PRINCIPAL, OWNER, CONVERSATION, [say("x")], film_version=1)


async def test_opening_the_page_checks_no_address_and_a_broken_image_still_shows() -> None:
    """打开制作页只查结构：写着打不开的地址照样列出来，是一张打不开的缩略图，到用它时才拦。"""

    broken = "https://gone.test/model.jpg"
    made = await page({FILM_PATH: FILM.replace(GIVEN_IMAGES[0], broken), RUN_PATH: RUN})
    made.adapter = ConversationFilmAdapter(store=made.store, probe=NoProbing(), generation=None)

    view = await made.view()

    assert view.problems == 0
    assert broken in {frame.url for group in view.groups for frame in group.frames}


def insert_into_setting(url: str) -> FilmTextEdit:
    """在第 1 组的场景字里插入一张新图：列表现有 10 张，新图写成 @Image11。"""

    return FilmTextEdit(
        "value:video01Setting", text="纽约红砖街区参考 @Image7，街角参考 @Image11。", images=(url,)
    )


async def test_an_inserted_image_that_opens_joins_the_list_and_only_it_is_checked() -> None:
    """插入的图不论哪来的，能打开、是图片就收；列表里原有的图不查。"""

    made = await page({FILM_PATH: FILM, RUN_PATH: RUN})

    view = await made.adapter.edit_text(
        PRINCIPAL, OWNER, CONVERSATION, [insert_into_setting(UPLOADED)], film_version=1
    )

    assert made.probe.asked == [UPLOADED]
    assert made.store.written == [FILM_PATH]
    inserted = view.groups[0].frames[7]
    assert (inserted.node, inserted.url, inserted.number, view.film_version) == (
        "素材照片1",
        UPLOADED,
        8,
        2,
    )
    assert view.groups[0].settings[4].text == "纽约红砖街区参考 @Image7，街角参考 @Image8。"


@pytest.mark.parametrize(
    ("answer", "message"),
    [
        pytest.param(FetchFailed("对方回了 404"), "^插入的图打不开，请换一张图$", id="打不开"),
        pytest.param("text/html", "^插入的图不是图片，请换一张图$", id="不是图片"),
    ],
)
async def test_an_inserted_image_that_cannot_be_used_is_refused_and_nothing_is_written(
    answer: str | FetchFailed, message: str
) -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN})
    made.probe.answers[UPLOADED] = answer

    with pytest.raises(ValidationFailed, match=message):
        await made.adapter.edit_text(
            PRINCIPAL, OWNER, CONVERSATION, [insert_into_setting(UPLOADED)], film_version=1
        )
    assert made.store.written == []
    assert await made.content(FILM_PATH) == FILM


async def test_a_refused_insertion_checks_nothing() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN})
    shared = FilmTextEdit(
        "value:videoCapture", text="摄影：手机拍摄，参考 @Image11。", images=(UPLOADED,)
    )

    with pytest.raises(ValidationFailed, match="无法插入图片"):
        await made.adapter.edit_text(PRINCIPAL, OWNER, CONVERSATION, [shared], film_version=1)
    assert made.probe.asked == []
    assert made.store.written == []


async def test_editing_text_without_inserting_an_image_checks_nothing() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN})

    await made.adapter.edit_text(PRINCIPAL, OWNER, CONVERSATION, [say("改一句")], film_version=1)

    assert made.probe.asked == []
    assert made.store.written == [FILM_PATH]


async def choose(
    made: Page, node: str, url: str | None, *, film_version: int = 1, run_version: int | None = 1
) -> FilmView:
    return await made.adapter.choose_image(
        PRINCIPAL,
        OWNER,
        CONVERSATION,
        node=node,
        url=url,
        film_version=film_version,
        run_version=run_version,
    )


async def test_any_image_that_opens_can_be_chosen() -> None:
    """不论是谁上传的、哪段对话出的，能打开、是图片就能选用。"""

    made = await page({FILM_PATH: FILM, RUN_PATH: RUN})

    view = await choose(made, "scene", UPLOADED)

    assert made.probe.asked == [UPLOADED]
    assert (view.film_version, view.run_version) == (1, 2)
    assert frame_url(view, "scene") == UPLOADED


@pytest.mark.parametrize(
    ("answer", "message"),
    [
        pytest.param(FetchFailed("对方回了 502"), "^这张图打不开，请换一张图$", id="打不开"),
        pytest.param("video/mp4", "^这张图不是图片，请换一张图$", id="不是图片"),
    ],
)
async def test_a_chosen_image_that_cannot_be_used_is_refused_and_nothing_is_written(
    answer: str | FetchFailed, message: str
) -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN})
    made.probe.answers[UPLOADED] = answer

    with pytest.raises(ValidationFailed, match=message):
        await choose(made, "scene", UPLOADED)
    assert made.store.written == []
    assert await made.content(RUN_PATH) == RUN


async def test_a_version_generated_on_the_page_can_be_chosen() -> None:
    made = await page({FILM_PATH: FILM}, [generated("view02", GENERATED_SCENE)])

    view = await choose(made, "view02", GENERATED_SCENE, run_version=None)

    assert view.run_version == 1
    assert frame_url(view, "view02") == GENERATED_SCENE


@pytest.mark.parametrize(("film_version", "run_version"), [(2, 1), (1, None), (1, 2)])
async def test_choosing_checks_both_versions(film_version: int, run_version: int | None) -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN})

    with pytest.raises(Conflict):
        await choose(made, "personB", None, film_version=film_version, run_version=run_version)


async def test_without_media_generation_an_image_that_opens_can_still_be_chosen() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: NO_SCENE}, with_generation=False)

    assert frame_url(await made.view(), "scene") is None
    assert frame_url(await choose(made, "scene", UPLOADED), "scene") == UPLOADED


async def test_choosing_a_view_writes_the_project_file_first_then_the_run_file() -> None:
    made = await page({FILM_PATH: FILM_NO_VIEW04, RUN_PATH: RUN_NO_VIEW04})

    view = await choose(made, "view04", VIEW04)

    assert made.store.written == [FILM_PATH, RUN_PATH]
    assert (view.film_version, view.run_version) == (2, 2)
    assert await made.content(FILM_PATH) == FILM
    assert frame_url(view, "view04", group=1) == VIEW04


async def test_clearing_a_view_writes_the_run_file_first_then_the_project_file() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN})

    view = await choose(made, "view04", None)

    assert made.probe.asked == [], "取消选用不查地址"
    assert made.store.written == [RUN_PATH, FILM_PATH]
    assert (view.film_version, view.run_version) == (2, 2)
    assert (await made.content(FILM_PATH), await made.content(RUN_PATH)) == (
        FILM_NO_VIEW04,
        RUN_NO_VIEW04,
    )


async def send_video02(made: Page, *, film_version: int, run_version: int) -> uuid.UUID:
    return await made.adapter.generate_video(
        PRINCIPAL,
        OWNER,
        CONVERSATION,
        video="video02",
        model="vendor-a-seedance-2-5",
        resolution="720p",
        generate_audio=True,
        film_version=film_version,
        run_version=run_version,
    )


@pytest.mark.parametrize(
    ("project", "run", "url", "failing", "versions"),
    [
        pytest.param(
            FILM_NO_VIEW04, RUN_NO_VIEW04, VIEW04, RUN_PATH, (2, 1), id="选用时运行文件没写成"
        ),
        pytest.param(FILM, RUN, None, FILM_PATH, (1, 2), id="取消时工程文件没写成"),
    ],
)
async def test_a_view_choice_that_fails_halfway_leaves_its_group_blocked(
    project: str, run: str, url: str | None, failing: str, versions: tuple[int, int]
) -> None:
    made = await page({FILM_PATH: project, RUN_PATH: run})
    made.store.failing = failing

    with pytest.raises(Conflict):
        await choose(made, "view04", url)

    # 两种都停在「列表里有 view04、没有选用它」：文件照样通过检查，这一组出片被拦住。
    assert (await made.content(FILM_PATH), await made.content(RUN_PATH)) == (FILM, RUN_NO_VIEW04)
    view = await made.view()
    assert view.problems == 0
    assert frame_url(view, "view04", group=1) is None
    with pytest.raises(ValidationFailed, match=r"^以下参考图尚未选用：镜头 1；无法生成$"):
        await send_video02(made, film_version=versions[0], run_version=versions[1])
    assert made.jobs.jobs == {}


async def generate(
    made: Page,
    node: str,
    *,
    run_version: int | None = 1,
    prompt: FilmImagePrompt | None = None,
) -> uuid.UUID:
    return await made.adapter.generate_image(
        PRINCIPAL,
        OWNER,
        CONVERSATION,
        node=node,
        prompt=prompt,
        film_version=1,
        run_version=run_version,
    )


async def test_an_image_without_a_picture_is_generated_from_the_film_without_touching_it() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: NO_SCENE})

    job = made.submitted(await generate(made, "scene"))

    assert (job.kind, job.provider, job.metadata) == (
        KIND_IMAGE,
        "gpt-image-2.5",
        {FILM_NODE_KEY: "scene"},
    )
    assert job.request is not None
    assert job.request.model_dump()["prompt"] == EXPECTED["images"]["scene"]["prompt"]
    assert job.conversation_id == CONVERSATION
    assert await made.content(RUN_PATH) == NO_SCENE


async def test_an_image_is_generated_with_its_reference_list_as_it_is() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN})

    job = made.submitted(await generate(made, "view02"))

    assert job.request is not None
    sent = job.request.model_dump()
    assert sent["prompt"] == EXPECTED["images"]["view02"]["prompt"]
    assert sent["reference_image_urls"] == EXPECTED["images"]["view02"]["input_str_list"]
    # 只查这次生成要用的参考图。
    assert sorted(made.probe.asked) == sorted(set(sent["reference_image_urls"]))


async def test_an_image_whose_reference_does_not_open_is_not_generated() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN})
    references = EXPECTED["images"]["view02"]["input_str_list"]
    made.probe.answers[references[0]] = FetchFailed("超时")
    made.probe.answers[references[1]] = "text/html"

    with pytest.raises(
        ValidationFailed, match=r"^第 1 张参考图打不开；第 2 张参考图不是图片，请换一张图$"
    ):
        await generate(made, "view02")
    assert made.jobs.jobs == {}


async def test_generating_again_never_selects_anything() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: NO_SCENE}, [generated("scene", GENERATED_SCENE)])

    await generate(made, "scene")

    view = await made.view()
    assert view.run_version == 1
    assert frame_url(view, "scene") is None
    assert await made.content(RUN_PATH) == NO_SCENE


async def test_a_refused_generation_writes_nothing() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: NO_SCENE}, [generated("scene", GENERATED_SCENE)])
    too_long = FilmImagePrompt("x" * (MAX_PROMPT_CHARS + 1), ())

    with pytest.raises(ValidationFailed, match=r"^这次没有生成："):
        await generate(made, "scene", prompt=too_long)

    assert [job.output.url for job in made.jobs.jobs.values()] == [GENERATED_SCENE]
    assert await made.content(RUN_PATH) == NO_SCENE


async def test_regenerating_an_image_that_is_already_chosen_leaves_the_run_file() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN})

    await generate(made, "personB")

    assert await made.content(RUN_PATH) == RUN
    assert frame_url(await made.view(), "personB") == GENERATED["personB"]


async def test_a_description_edited_in_the_editor_is_used_once() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN})
    edited = FilmImagePrompt("只要鞋，不要人。", (SHOE_FRONT,))

    job = made.submitted(await generate(made, "view02", prompt=edited))

    assert job.request is not None
    sent = job.request.model_dump()
    assert (sent["prompt"], sent["reference_image_urls"]) == ("只要鞋，不要人。", [SHOE_FRONT])
    assert made.probe.asked == [SHOE_FRONT], "查的是编辑器里给的参考图，不是文件里那一份"
    assert await made.content(FILM_PATH) == FILM


@pytest.mark.parametrize(
    "prompt",
    [None, FilmImagePrompt("只要鞋。", (SHOE_FRONT,))],
    ids=["文件里的描述", "编辑器里的描述"],
)
async def test_an_image_whose_references_lack_pictures_is_not_generated(
    prompt: FilmImagePrompt | None,
) -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: run_of("no-personB")})

    with pytest.raises(ValidationFailed, match=r"^以下参考图尚未选用：personB；无法生成$"):
        await generate(made, "view01", prompt=prompt)
    assert made.jobs.jobs == {}


@pytest.mark.parametrize(
    ("node", "image_models", "message"),
    [
        ("shoeFrontPhoto", ("nano_banana_pro", "gpt-image-2.5"), "不能按描述生成"),
        ("capture", ("nano_banana_pro", "gpt-image-2.5"), "不能按描述生成"),
        ("scene", ("nano_banana_pro",), "生图模型还没接上"),
    ],
)
async def test_an_image_that_cannot_be_generated_here_is_refused(
    node: str, image_models: tuple[str, ...], message: str
) -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN}, image_models=image_models)

    with pytest.raises(ValidationFailed, match=message):
        await generate(made, node)
    assert made.jobs.jobs == {}


async def test_nothing_is_generated_without_media_generation() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN}, with_generation=False)

    with pytest.raises(ValidationFailed, match="还没开生成"):
        await generate(made, "scene")


async def test_generating_on_a_stale_version_is_a_conflict() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN})

    with pytest.raises(Conflict):
        await generate(made, "scene", run_version=None)
    assert made.jobs.jobs == {}


async def send(made: Page, video: str) -> uuid.UUID:
    return await made.adapter.generate_video(
        PRINCIPAL,
        OWNER,
        CONVERSATION,
        video=video,
        model="vendor-a-seedance-2-5",
        resolution="720p",
        generate_audio=True,
        film_version=1,
        run_version=1,
    )


async def test_a_group_is_sent_as_its_shot_with_the_group_number() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN})

    job = made.submitted(await send(made, "video01"))

    assert (job.kind, job.shot_index, job.metadata) == (KIND_VIDEO, 1, {FILM_NODE_KEY: "video01"})
    assert job.request is not None
    sent = job.request.model_dump()
    expected = EXPECTED["states"]["both"]["video01"]
    assert sent["reference_image_urls"] == expected["images"]
    assert (sent["seconds"], sent["aspect_ratio"], sent["resolution"]) == (18, "16:9", "720p")
    assert sent["shot"]["global_settings"] == expected["shot"]["global_settings"]
    assert [item["prompt"] for item in sent["shot"]["timeline"]] == [
        item["prompt"] for item in expected["shot"]["timeline"]
    ]
    assert "{这一双，走起来很轻。}" in sent["prompt"]
    assert sorted(made.probe.asked) == sorted(set(expected["images"]))


async def test_a_group_whose_reference_does_not_open_is_not_sent() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN})
    images = EXPECTED["states"]["both"]["video01"]["images"]
    made.probe.answers[images[2]] = "video/mp4"

    with pytest.raises(ValidationFailed, match=r"^第 3 张参考图不是图片，请换一张图$"):
        await send(made, "video01")
    assert made.jobs.jobs == {}


async def test_a_group_whose_list_lacks_a_picture_is_not_sent_and_the_others_are() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: run_of("no-personB")})

    with pytest.raises(ValidationFailed, match=r"^以下参考图尚未选用：personB；无法生成$"):
        await send(made, "video01")
    assert made.jobs.jobs == {}

    job = made.submitted(await send(made, "video02"))
    assert job.shot_index == 2


async def test_an_unknown_group_is_refused() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN})

    with pytest.raises(ValidationFailed, match="找不到这一组"):
        await send(made, "personB")
