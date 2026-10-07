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
from iclip.platform.material_ledger.store import Material
from tests.helpers.file_store import FakeFileStore
from tests.helpers.film import FILM, GIVEN_IMAGES, PERSON_FIXED, RUN, SHOE_PHOTO, VIEW_ONE
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
LATEST_PARK = "https://cdn.test/park-latest.png"
UPLOADED = "https://cdn.test/iclip/agent/uploads/my-park.png"
FIRST_SHOT = (
    "开场，手持，胸部以上近景，平视。短发女生站在跑道边，双手分别握住网面跑鞋的鞋头和鞋跟，"
    "向内对折到两端相碰，停了一下后松开右手，鞋底立刻弹回平直。她抬头看着镜头说：",
    " 音效：鞋底弹回时的一声轻响",
)


def say(text: str) -> FilmTextEdit:
    """把第一个镜头里那句台词改成 ``text``。"""

    return FilmTextEdit(
        "shot:全片分镜:1",
        parts=FIRST_SHOT,
        lines=(FilmLineEdit("line:lighter", "短发女生", text),),
    )


@dataclass
class Page:
    adapter: ConversationFilmAdapter
    store: FakeFileStore
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
    store = FakeFileStore()
    for path, content in files.items():
        await store.write(NAMESPACE, path, content)
    ledger = FakeMaterialLedger()
    await ledger.record(NAMESPACE, [Material(url=url, kind="image") for url in GIVEN_IMAGES])
    repo = InMemoryGenerationRepository(list(jobs))
    generation = film_image_service(repo, image_models=image_models) if with_generation else None
    adapter = ConversationFilmAdapter(
        store=store, announcing=store, ledger=ledger, generation=generation
    )
    return Page(adapter, store, ledger, repo)


def latest_park() -> GenerationJob:
    return make_job(
        image_request(),
        status=STATUS_COMPLETED,
        owner_user_id=OWNER,
        conversation_id=CONVERSATION,
        metadata={FILM_NODE_KEY: "公园跑道参考图"},
        output_url=LATEST_PARK,
    )


def frame_url(view: FilmView, node: str) -> str | None:
    return next(frame.url for frame in view.groups[0].frames if frame.node == node)


async def test_there_is_no_view_without_a_film_file() -> None:
    made = await page({RUN_PATH: RUN})

    assert await made.adapter.view(PRINCIPAL, OWNER, CONVERSATION) is None


async def test_the_view_carries_both_versions_and_the_latest_generated_image() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN}, [latest_park()])

    view = await made.view()

    assert (view.film_version, view.run_version, view.problems) == (1, 1, 0)
    assert frame_url(view, "公园跑道参考图") == LATEST_PARK


async def test_a_film_with_problems_shows_only_how_many() -> None:
    foreign = FILM.replace(GIVEN_IMAGES[0], "https://elsewhere.test/shoe.jpg")
    made = await page({FILM_PATH: foreign})

    view = await made.view()

    assert (view.problems, view.groups, view.run_version) == (1, (), None)
    with pytest.raises(ValidationFailed, match="等 AI 导演改好"):
        await made.adapter.edit_text(
            PRINCIPAL,
            OWNER,
            CONVERSATION,
            [say("x")],
            film_version=1,
        )


async def test_an_edit_is_written_with_its_version_and_answered_with_the_new_view() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN})

    view = await made.adapter.edit_text(
        PRINCIPAL,
        OWNER,
        CONVERSATION,
        [say("Lighter than it looks!")],
        film_version=1,
    )

    assert view.film_version == 2
    assert view.groups[0].shots[0].lines[0].text == "Lighter than it looks!"
    assert "Lighter than it looks!" in (await made.content(FILM_PATH) or "")


async def test_an_edit_on_a_stale_version_is_a_conflict_and_writes_nothing() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN})
    await made.store.write(NAMESPACE, FILM_PATH, FILM + "\n")

    with pytest.raises(Conflict, match="刷新后再改"):
        await made.adapter.edit_text(
            PRINCIPAL,
            OWNER,
            CONVERSATION,
            [say("x")],
            film_version=1,
        )
    assert await made.content(FILM_PATH) == FILM + "\n"


async def test_a_refused_edit_comes_back_as_a_plain_validation_error() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN})

    with pytest.raises(ValidationFailed, match=r"^台词不能是空的$"):
        await made.adapter.edit_text(
            PRINCIPAL,
            OWNER,
            CONVERSATION,
            [say(" ")],
            film_version=1,
        )
    assert await made.content(FILM_PATH) == FILM


async def test_a_users_own_upload_is_recorded_as_material_before_it_is_chosen() -> None:
    upload = make_upload(owner_user_id=OWNER, output_url=UPLOADED)
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN}, [upload])

    view = await made.adapter.choose_image(
        PRINCIPAL,
        OWNER,
        CONVERSATION,
        node="公园跑道参考图",
        url=UPLOADED,
        film_version=1,
        run_version=1,
    )

    assert UPLOADED in made.ledger.urls(NAMESPACE)
    assert (view.film_version, view.run_version) == (1, 2)
    assert frame_url(view, "公园跑道参考图") == UPLOADED


async def test_an_address_that_is_not_this_conversations_image_is_refused() -> None:
    someone_else = make_upload(owner_user_id=uuid.uuid4(), output_url=UPLOADED)
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN}, [someone_else])

    with pytest.raises(ValidationFailed, match="只能换成这段对话里的图"):
        await made.adapter.choose_image(
            PRINCIPAL,
            OWNER,
            CONVERSATION,
            node="公园跑道参考图",
            url=UPLOADED,
            film_version=1,
            run_version=1,
        )
    assert UPLOADED not in made.ledger.urls(NAMESPACE)
    assert await made.content(RUN_PATH) == RUN


async def test_a_generated_image_of_this_conversation_can_be_chosen_without_recording() -> None:
    made = await page({FILM_PATH: FILM}, [latest_park()])

    view = await made.adapter.choose_image(
        PRINCIPAL,
        OWNER,
        CONVERSATION,
        node="镜02机位图",
        url=LATEST_PARK,
        film_version=1,
        run_version=None,
    )

    assert view.run_version == 1
    assert frame_url(view, "镜02机位图") == LATEST_PARK
    assert LATEST_PARK not in made.ledger.urls(NAMESPACE)


@pytest.mark.parametrize(("film_version", "run_version"), [(2, 1), (1, None), (1, 2)])
async def test_choosing_checks_both_versions(film_version: int, run_version: int | None) -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN})

    with pytest.raises(Conflict):
        await made.adapter.choose_image(
            PRINCIPAL,
            OWNER,
            CONVERSATION,
            node="短发女生参考图",
            url=None,
            film_version=film_version,
            run_version=run_version,
        )


async def test_without_media_generation_only_recorded_material_counts() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN}, with_generation=False)

    assert frame_url(await made.view(), "公园跑道参考图") is None
    with pytest.raises(ValidationFailed, match="只能换成这段对话里的图"):
        await made.adapter.choose_image(
            PRINCIPAL,
            OWNER,
            CONVERSATION,
            node="公园跑道参考图",
            url=UPLOADED,
            film_version=1,
            run_version=1,
        )


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
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN})

    job = made.submitted(await generate(made, "公园跑道参考图"))

    assert (job.kind, job.provider, job.metadata) == (
        KIND_IMAGE,
        "gpt-image-2.5",
        {FILM_NODE_KEY: "公园跑道参考图"},
    )
    assert job.request is not None and job.request.model_dump()["prompt"].startswith(
        "画面是用手机实拍的"
    )
    assert job.conversation_id == CONVERSATION
    assert await made.content(RUN_PATH) == RUN


async def test_regenerating_an_image_in_use_first_pins_the_one_in_use() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN}, [latest_park()])

    await generate(made, "公园跑道参考图")

    view = await made.view()
    assert view.run_version == 2
    assert frame_url(view, "公园跑道参考图") == LATEST_PARK
    assert f'src="{LATEST_PARK}"' in (await made.content(RUN_PATH) or "")


async def test_a_refused_regeneration_says_the_current_image_was_kept_in_use() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN}, [latest_park()])
    too_long = FilmImagePrompt("x" * (MAX_PROMPT_CHARS + 1), ())

    with pytest.raises(ValidationFailed, match=r"^已经选用现在这张图，这次没有生成："):
        await generate(made, "公园跑道参考图", prompt=too_long)

    assert [job.output_url for job in made.jobs.jobs.values()] == [LATEST_PARK]
    assert frame_url(await made.view(), "公园跑道参考图") == LATEST_PARK


async def test_regenerating_an_image_that_is_already_chosen_leaves_the_run_file() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN})

    await generate(made, "短发女生参考图")

    assert await made.content(RUN_PATH) == RUN
    assert frame_url(await made.view(), "短发女生参考图") == PERSON_FIXED


async def test_a_description_edited_in_the_editor_is_used_once() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN})
    edited = FilmImagePrompt("只要鞋，不要人。", (SHOE_PHOTO,))

    job = made.submitted(await generate(made, "镜02机位图", prompt=edited))

    assert job.request is not None
    sent = job.request.model_dump()
    assert (sent["prompt"], sent["reference_image_urls"]) == ("只要鞋，不要人。", [SHOE_PHOTO])
    assert await made.content(FILM_PATH) == FILM


@pytest.mark.parametrize(
    ("node", "image_models", "message"),
    [
        ("跑鞋照片", ("nano_banana_pro", "gpt-image-2.5"), "不能按描述生成"),
        ("短发女生", ("nano_banana_pro", "gpt-image-2.5"), "不能按描述生成"),
        ("公园跑道参考图", ("nano_banana_pro",), "生图模型还没接上"),
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
        await generate(made, "公园跑道参考图")


async def test_generating_on_a_stale_version_is_a_conflict() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN})

    with pytest.raises(Conflict):
        await generate(made, "公园跑道参考图", run_version=None)
    assert made.jobs.jobs == {}


async def test_a_group_is_sent_as_its_shot_with_the_group_number() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN})

    job_id = await made.adapter.generate_video(
        PRINCIPAL,
        OWNER,
        CONVERSATION,
        video="全片",
        model="vendor-a-seedance-2-5",
        resolution="720p",
        generate_audio=True,
        film_version=1,
        run_version=1,
    )

    job = made.submitted(job_id)
    assert (job.kind, job.shot_index, job.metadata) == (KIND_VIDEO, 1, {FILM_NODE_KEY: "全片"})
    assert job.request is not None
    sent = job.request.model_dump()
    assert sent["reference_image_urls"] == [PERSON_FIXED, SHOE_PHOTO, VIEW_ONE]
    assert (sent["seconds"], sent["aspect_ratio"], sent["resolution"]) == (15, "9:16", "720p")
    assert sent["shot"]["timeline"][0]["prompt"].startswith("@Image3 的机位。开场")
    assert "{It's lighter than it looks.}" in sent["prompt"]


async def test_an_unknown_group_is_refused() -> None:
    made = await page({FILM_PATH: FILM, RUN_PATH: RUN})

    with pytest.raises(ValidationFailed, match="找不到这一组"):
        await made.adapter.generate_video(
            PRINCIPAL,
            OWNER,
            CONVERSATION,
            video="短发女生参考图",
            model="vendor-a-seedance-2-5",
            resolution="720p",
            generate_audio=False,
            film_version=1,
            run_version=1,
        )
