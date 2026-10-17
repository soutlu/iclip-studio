from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable, Sequence
from typing import Protocol

from iclip.domains.brand_templates.models import BrandTemplate, ProbedVideo
from iclip.domains.identity.public import Principal


class BrandTemplateStore(Protocol):
    async def create(
        self,
        *,
        resource_id: uuid.UUID,
        kind: str,
        brand: str | None,
        name: str,
        url: str,
        video: ProbedVideo | None,
        created_by: uuid.UUID,
        api_key_id: uuid.UUID | None,
    ) -> BrandTemplate: ...

    async def get(self, template_id: uuid.UUID) -> BrandTemplate | None: ...

    async def list(
        self, *, kind: str | None, brand: str | None, include_disabled: bool
    ) -> Sequence[BrandTemplate]: ...

    async def update(
        self,
        template_id: uuid.UUID,
        *,
        name: str | None,
        disabled: bool | None,
        brand: str | None = None,
        update_brand: bool = False,
    ) -> BrandTemplate | None: ...


OwnVideoUpload = Callable[[Principal, uuid.UUID], Awaitable[str | None]]

ProbeVideo = Callable[[str], Awaitable[ProbedVideo]]


__all__ = ["BrandTemplateStore", "OwnVideoUpload", "ProbeVideo"]
