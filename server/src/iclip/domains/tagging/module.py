from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import procrastinate

from iclip.domains.tagging.api import create_tagging_router
from iclip.domains.tagging.queue import TaggingQueue
from iclip.domains.tagging.repository import SourceText, Tagger, TagStore
from iclip.domains.tagging.service import TaggingService


@dataclass(frozen=True, slots=True)
class TaggingSetup:
    tagger: Tagger
    connector: procrastinate.BaseConnector


@dataclass(frozen=True)
class TaggingModule:
    routers: tuple[Any, ...]

    service: TaggingService
    queue: TaggingQueue | None


def build_tagging_module(
    store: TagStore, *, source_text: SourceText, setup: TaggingSetup | None
) -> TaggingModule:
    queue = (
        TaggingQueue(store, source_text=source_text, tagger=setup.tagger, connector=setup.connector)
        if setup is not None
        else None
    )
    service = TaggingService(store, queue=queue)
    return TaggingModule(routers=(create_tagging_router(service),), service=service, queue=queue)


__all__ = ["TaggingModule", "TaggingSetup", "build_tagging_module"]
