"""整片受理走一遍装配好的模块：带片头片尾时，用真 ffprobe 在换过的地址上读第一段成片的画幅，与模板
比例对不上就不受理。成片放在本地 HTTP 服务上。"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest
from procrastinate.testing import InMemoryConnector

from iclip.common.errors import ValidationFailed
from iclip.domains.generation.film_schemas import (
    WholeFilmBrandIn,
    WholeFilmIn,
    WholeFilmRequest,
    WholeFilmSegmentIn,
)
from iclip.domains.generation.models import STATUS_COMPLETED, GenerationJob
from iclip.domains.generation.module import (
    GenerationModule,
    ImageModelConfig,
    build_generation_module,
)
from iclip.domains.generation.ports import BrandTemplateFacts
from iclip.domains.generation.video import VideoProviderSettings
from iclip.domains.identity.acting import ActAs
from iclip.domains.identity.models import Principal
from iclip.platform.media.codec import SOFTWARE
from iclip.platform.media.process import ffmpeg_available
from tests.helpers.fetch_url import rewriting
from tests.helpers.generation import (
    FakeFontProbe,
    FixedBrandTemplates,
    FixedLineage,
    InMemoryGenerationRepository,
    MemoryObjectStore,
    make_job,
    video_request,
)
from tests.helpers.identity import InMemoryUserRepository
from tests.helpers.media import synthesize_video
from tests.helpers.media_server import serving

pytestmark = [
    pytest.mark.anyio,
    pytest.mark.skipif(not ffmpeg_available(), reason="本机 PATH 上没有 ffmpeg/ffprobe"),
]

PRINCIPAL = Principal(
    kind="user",
    user_id=uuid.uuid4(),
    permissions=frozenset({"generation:submit"}),
    audit_label="tester",
    username="tester",
)


async def _keep_completion(_conversation_id: uuid.UUID, _owner: uuid.UUID) -> None:
    return None


def _module(
    repo: InMemoryGenerationRepository,
    template: BrandTemplateFacts,
    fetch_url: Callable[[str], str],
) -> GenerationModule:
    return build_generation_module(
        repo,
        act_as=ActAs(InMemoryUserRepository()),
        clear_completion=_keep_completion,
        lineage=FixedLineage(),
        brand_templates=FixedBrandTemplates(template),
        probe_font=FakeFontProbe(),
        video=VideoProviderSettings(
            submit_url="https://video.test/generate",
            status_base_url="https://video.test/tasks",
            api_key="secret-key",
        ),
        video_default_model="vendor-a-seedance-2-5",
        video_allowed_models=("vendor-a-seedance-2-5",),
        image_models=[
            ImageModelConfig(name="nano_banana_pro", api_base="https://image.test", concurrency=1)
        ],
        image_default_model="nano_banana_pro",
        image_env="test",
        image_text_to_image_task="text-to-image",
        image_edit_task="image-edit",
        object_store=MemoryObjectStore(),
        queue_connector=InMemoryConnector(),
        media_codec=SOFTWARE,
        fetch_url=fetch_url,
    )


@pytest.mark.parametrize(("width", "height", "accepted"), [(640, 480, True), (1280, 720, False)])
async def test_the_intro_ratio_is_checked_against_the_probed_first_segment(
    width: int, height: int, accepted: bool
) -> None:
    """成片是 320×240，记的是本桶公网地址，只在换过的地址上读得到。"""

    public = "https://cdn.test"
    take_url = f"{public}/iclip/agent/take.mp4"
    conversation = uuid.uuid4()
    repo = InMemoryGenerationRepository()
    template = BrandTemplateFacts(
        id=uuid.uuid4(),
        kind="intro",
        name="片头",
        enabled=True,
        url=f"{public}/iclip/agent/intro.mp4",
        duration_ms=2000,
        width=width,
        height=height,
        has_audio=True,
    )
    with TemporaryDirectory(prefix="film-fixture-") as tmp:
        take_bytes = synthesize_video(Path(tmp) / "take.mp4", size="320x240", seconds=2, audio=True)
    async with serving({"iclip/agent/take.mp4": take_bytes}) as server:
        module = _module(repo, template, rewriting(public, server.base_url))
        take = make_job(
            video_request(),
            status=STATUS_COMPLETED,
            owner_user_id=PRINCIPAL.user_id,
            conversation_id=conversation,
            output_url=take_url,
        )
        repo.jobs[take.id] = take
        request = WholeFilmIn(
            segments=[WholeFilmSegmentIn(source_job_id=take.id, start_ms=0, end_ms=1000)],
            subtitles=[],
            intro=WholeFilmBrandIn(template_id=template.id),
            conversation_id=conversation,
        )
        outcome: GenerationJob | ValidationFailed
        try:
            outcome = await module.service.submit_whole_film(PRINCIPAL, request)
        except ValidationFailed as exc:
            outcome = exc

    assert {delivery.target for delivery in server.deliveries} == {"iclip/agent/take.mp4"}
    if accepted:
        assert isinstance(outcome, GenerationJob), outcome
        stored = repo.jobs[outcome.id].request
        assert isinstance(stored, WholeFilmRequest)
        assert stored.intro is not None and stored.intro.template_id == template.id
    else:
        assert isinstance(outcome, ValidationFailed)
        assert "片头模板的画面比例与正文不一致" in str(outcome)
