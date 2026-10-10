"""验证制作页的组合根适配：从工作区读工程，认图片地址，带版本写回，按文件生图与出片。"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass

import pytest

from iclip.app.conversation_film import ConversationFilmAdapter
from iclip.app.film_images import FILM_NODE_KEY
from iclip.capabilities.iclip_studio.film.film import FILM_PATH, RUN_PATH
from iclip.capabilities.workspace.scope import namespace_for
from iclip.common.errors import Conflict, ValidationFailed
from iclip.common.film_view import FilmImagePrompt, FilmLineEdit, FilmTextEdit, FilmView
from iclip.domains.generation.models import STATUS_COMPLETED, GenerationJob
from iclip.domains.generation.schemas import KIND_IMAGE, KIND_VIDEO, MAX_PROMPT_CHARS
from iclip.domains.identity.models import Principal
from iclip.platform.file_store.store import FileEntry, VersionConflict
from iclip.platform.material_ledger.store import Material
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
    make_upload,
)
from tests.helpers.material_ledger import FakeMaterialLedger

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
            raise VersionConflict(path, expected=expected_version, actual=expected_version + 1)
        entry = await super().write(namespace, path, content, expected_version=expected_version)
        self.written.append(path)
        return entry


@dataclass
class Page:
    adapter: ConversationFilmAdapter
    store: RecordingStore
    ledger: FakeMaterialLedger
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
    ledger = FakeMaterialLedger()
    await ledger.record(NAMESPACE, [Material(url=url, kind="image") for url in GIVEN_IMAGES])
    repo = InMemoryGenerationRepository(list(jobs))
    generation = film_image_service(repo, image_models=image_models) if with_generation else None
    adapter = ConversationFilmAdapter(
        store=store, announcing=store, ledger=ledger, generation=generation
    )
    return Page(adapter, store, ledger, repo)


def generated(node: str, url: str) -> GenerationJob:
    """``node`` 按描述生成成功的一条记录。"""

    return make_job(
        image_request(),
        status=STATUS_COMPLETED,
        owner_user_id=OWNER,
        conversation_id=CONVERSATION,
        metadata={FILM_NODE_KEY: node},
        output_url=url,
    )


def frame_url(view: FilmView, node: str, group: int = 0) -> str | None:
    return next(frame.url for frame in view.groups[group].frames if frame.node == node)


async def test_there_is_no_view_without_a_film_file() -> None:
    made = await page({RUN_PATH: RUN})

    assert await made.adapter.view(PRINCIPAL, OWNER, CONVERSATION) is None


async def test_the_view_carries_both_versions_and_only_selected_images() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: NO_SCENE}, [generated("scene", GENERATED_SCENE)])

    view = await made.view()

    assert (view.film_version, view.run_version, view.problems) == (1, 1, 0)
    assert frame_url(view, "personB") == GENERATED["personB"]
    # 生成成功过、运行文件里没选用：还是没有图。
    assert frame_url(view, "scene") is None


async def test_a_film_with_problems_shows_only_how_many() -> None:
    foreign = FILM.replace(GIVEN_IMAGES[0], "https://elsewhere.test/model.jpg")
    made = await page({FILM_PATH: foreign})

    view = await made.view()

    assert (view.problems, view.groups, view.run_version) == (1, (), None)
    with pytest.raises(ValidationFailed, match="等 AI 导演改好"):
        await made.adapter.edit_text(PRINCIPAL, OWNER, CONVERSATION, [say("x")], film_version=1)


async def test_an_address_known_only_from_the_generation_records_is_a_problem() -> None:
    # 文件里的图片地址只认对话素材台账：这张图生成过，但没登记成素材。
    unrecorded = RUN.replace(GENERATED["scene"], GENERATED_SCENE)
    made = await page(
        {FILM_PATH: FILM, RUN_PATH: unrecorded}, [generated("scene", GENERATED_SCENE)]
    )

    assert (await made.view()).problems == 1


async def test_an_edit_is_written_with_its_version_and_answered_with_the_new_view() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN})

    view = await made.adapter.edit_text(
        PRINCIPAL, OWNER, CONVERSATION, [say("这一双，真的很轻。")], film_version=1
    )

    assert view.film_version == 2
    assert view.groups[0].shots[0].lines[0].text == "这一双，真的很轻。"
    assert "这一双，真的很轻。" in (await made.content(FILM_PATH) or "")


async def test_an_edit_on_a_stale_version_is_a_conflict_and_writes_nothing() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN})
    await made.store.write(NAMESPACE, FILM_PATH, FILM + "\n")

    with pytest.raises(Conflict, match="刷新后再改"):
        await made.adapter.edit_text(PRINCIPAL, OWNER, CONVERSATION, [say("x")], film_version=1)
    assert await made.content(FILM_PATH) == FILM + "\n"


async def test_a_refused_edit_comes_back_as_a_plain_validation_error() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN})

    with pytest.raises(ValidationFailed, match=r"^台词不能是空的$"):
        await made.adapter.edit_text(PRINCIPAL, OWNER, CONVERSATION, [say(" ")], film_version=1)
    assert await made.content(FILM_PATH) == FILM


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


async def test_a_users_own_upload_is_recorded_as_material_before_it_is_chosen() -> None:
    upload = make_upload(owner_user_id=OWNER, output_url=UPLOADED)
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN}, [upload])

    view = await choose(made, "scene", UPLOADED)

    assert UPLOADED in made.ledger.urls(NAMESPACE)
    assert (view.film_version, view.run_version) == (1, 2)
    assert frame_url(view, "scene") == UPLOADED


async def test_an_address_that_is_not_this_conversations_image_is_refused() -> None:
    someone_else = make_upload(owner_user_id=uuid.uuid4(), output_url=UPLOADED)
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN}, [someone_else])

    with pytest.raises(ValidationFailed, match="只能换成这段对话里的图"):
        await choose(made, "scene", UPLOADED)
    assert UPLOADED not in made.ledger.urls(NAMESPACE)
    assert await made.content(RUN_PATH) == RUN


async def test_a_version_generated_on_the_page_can_be_chosen_and_is_recorded_as_material() -> None:
    """刚生成的版本不在台账里，靠生成记录认；选用时登记，之后文件检查只看台账。"""

    made = await page({FILM_PATH: FILM}, [generated("view02", GENERATED_SCENE)])

    view = await choose(made, "view02", GENERATED_SCENE, run_version=None)

    assert view.run_version == 1
    assert frame_url(view, "view02") == GENERATED_SCENE
    assert made.ledger.rows[(NAMESPACE, GENERATED_SCENE)] == Material(
        url=GENERATED_SCENE, kind="image"
    )


async def test_choosing_a_result_writes_its_use_and_clearing_it_leaves_no_image() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: NO_SCENE}, [generated("scene", GENERATED_SCENE)])

    chosen = await choose(made, "scene", GENERATED_SCENE)

    assert frame_url(chosen, "scene") == GENERATED_SCENE
    assert '<use output="scene.image" image={scene-1}/>' in (await made.content(RUN_PATH) or "")
    recorded = dict(made.ledger.rows)

    cleared = await choose(made, "scene", None, run_version=2)

    # 取消选用就是没图：不回到生成过的那一张。
    assert cleared.run_version == 3
    assert frame_url(cleared, "scene") is None
    assert 'output="scene.image"' not in (await made.content(RUN_PATH) or "")
    assert made.ledger.rows == recorded, "取消选用不登记任何东西"


@pytest.mark.parametrize(("film_version", "run_version"), [(2, 1), (1, None), (1, 2)])
async def test_choosing_checks_both_versions(film_version: int, run_version: int | None) -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN})

    with pytest.raises(Conflict):
        await choose(made, "personB", None, film_version=film_version, run_version=run_version)


async def test_without_media_generation_only_recorded_material_counts() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: NO_SCENE}, with_generation=False)

    assert frame_url(await made.view(), "scene") is None
    with pytest.raises(ValidationFailed, match="只能换成这段对话里的图"):
        await choose(made, "scene", UPLOADED)


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

    assert [job.output_url for job in made.jobs.jobs.values()] == [GENERATED_SCENE]
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
