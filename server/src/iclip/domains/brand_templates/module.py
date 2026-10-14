"""brand_templates 装配单元：组合根只调用 ``build_brand_templates_module``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.brand_templates.api import create_brand_templates_router
from iclip.domains.brand_templates.repository import BrandTemplateStore, OwnVideoUpload, ProbeVideo
from iclip.domains.brand_templates.service import BrandTemplateService


@dataclass(frozen=True)
class BrandTemplatesModule:
    routers: tuple[Any, ...]
    """使用 Any 隔离 Web 框架类型。"""

    service: BrandTemplateService


def build_brand_templates_module(
    store: BrandTemplateStore, *, own_video_upload: OwnVideoUpload, probe: ProbeVideo
) -> BrandTemplatesModule:
    service = BrandTemplateService(store, own_video_upload=own_video_upload, probe=probe)
    return BrandTemplatesModule(routers=(create_brand_templates_router(service),), service=service)


__all__ = ["BrandTemplatesModule", "build_brand_templates_module"]
