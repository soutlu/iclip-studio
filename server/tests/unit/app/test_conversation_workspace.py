"""验证用户写回工程文件与运行文件时的校验：与工具用同一套规则，只看这一个文件。"""

from __future__ import annotations

import uuid

import pytest

from iclip.app.conversation_workspace import validate_film, validate_film_run
from iclip.common.errors import ValidationFailed
from tests.helpers.film import FILM, RUN

USER = uuid.UUID("55555555-5555-5555-5555-555555555555")


async def test_the_sample_files_are_accepted() -> None:
    conversation = uuid.uuid4()

    await validate_film(USER, conversation, FILM)
    await validate_film_run(USER, conversation, RUN)


async def test_a_broken_project_file_is_refused_with_the_first_problem() -> None:
    broken = FILM.replace('duration="15"', 'duration="14"')

    with pytest.raises(ValidationFailed, match=r"film\.icml 第 \d+ 行：duration 写的是 14"):
        await validate_film(USER, uuid.uuid4(), broken)


async def test_a_broken_run_file_is_refused() -> None:
    broken = RUN.replace("{短发女生修过手}", "{没登记}")

    with pytest.raises(ValidationFailed, match=r"film\.icrun 第 \d+ 行"):
        await validate_film_run(USER, uuid.uuid4(), broken)


async def test_several_problems_are_counted_in_the_message() -> None:
    broken = FILM.replace('aspect-ratio="3:4" resolution="2k"', 'aspect-ratio="3:4" size="2k"')

    with pytest.raises(ValidationFailed, match="（共 2 处）"):
        await validate_film(USER, uuid.uuid4(), broken)
