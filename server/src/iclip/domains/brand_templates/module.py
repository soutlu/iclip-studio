from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.brand_templates.api import create_brand_templates_router
from iclip.domains.brand_templates.repository import BrandTemplateStore
from iclip.domains.brand_templates.service import BrandTemplateService
from iclip.platform.media.fonts import ProbeFont
from iclip.platform.object_store.store import SignedUploadStore


@dataclass(frozen=True)
class BrandTemplatesModule:
    routers: tuple[Any, ...]
    service: BrandTemplateService


def build_brand_templates_module(
    store: BrandTemplateStore,
    *,
    objects: SignedUploadStore,
    probe_font: ProbeFont,
) -> BrandTemplatesModule:
    service = BrandTemplateService(store, objects=objects, probe_font=probe_font)
    return BrandTemplatesModule(routers=(create_brand_templates_router(service),), service=service)


__all__ = ["BrandTemplatesModule", "build_brand_templates_module"]
