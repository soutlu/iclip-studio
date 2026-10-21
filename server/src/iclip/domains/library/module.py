"""library 装配单元：组合根只调用 ``build_library_module``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.library.api import create_library_router
from iclip.domains.library.repository import LibraryReports
from iclip.domains.library.service import (
    HasProductionFiles,
    HasTreatment,
    HitCaseService,
    LibraryService,
)
from iclip.domains.tagging.public import TaggingService


@dataclass(frozen=True)
class LibraryModule:
    routers: tuple[Any, ...]
    """使用 Any 隔离 Web 框架类型。"""

    service: LibraryService
    hit_cases: HitCaseService


def build_library_module(
    reports: LibraryReports,
    *,
    has_production_files: HasProductionFiles,
    tagging: TaggingService,
    has_treatment: HasTreatment,
) -> LibraryModule:
    """``tagging`` 没配打标时爆款照样入选、改标签，只是不排打标、不挂重新打标。"""

    service = LibraryService(reports, has_production_files=has_production_files)
    hit_cases = HitCaseService(reports, tagging=tagging, has_treatment=has_treatment)
    return LibraryModule(
        routers=(create_library_router(service, hit_cases),), service=service, hit_cases=hit_cases
    )


__all__ = ["LibraryModule", "build_library_module"]
