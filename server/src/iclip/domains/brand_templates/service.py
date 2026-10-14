"""品牌模板用例：治理者新建、改名、停用与恢复，读者按位置列在用的。端点权限由路由声明。"""

from __future__ import annotations

import uuid

import structlog

from iclip.common.errors import NotFound, PermissionDenied, ValidationFailed
from iclip.common.shot_prompt import format_seconds
from iclip.domains.brand_templates.models import MAX_TEMPLATE_MS, Position
from iclip.domains.brand_templates.repository import BrandTemplateStore, OwnVideoUpload, ProbeVideo
from iclip.domains.brand_templates.schemas import (
    BrandTemplateCreateIn,
    BrandTemplateOut,
    BrandTemplatesOut,
    BrandTemplateUpdateIn,
)
from iclip.domains.identity.public import MANAGE_PERMISSION, Principal
from iclip.platform.media.ffmpeg import MediaError

_logger = structlog.stdlib.get_logger(__name__)


class BrandTemplateService:
    def __init__(
        self, store: BrandTemplateStore, *, own_video_upload: OwnVideoUpload, probe: ProbeVideo
    ) -> None:
        self._store = store
        self._own_video_upload = own_video_upload
        self._probe = probe

    async def create(self, principal: Principal, body: BrandTemplateCreateIn) -> BrandTemplateOut:
        """拿调用者自己的一条视频上传建一条在用的模板，画幅、时长与音轨从视频本身量出来记下。

        别人的上传、不是视频的上传、不存在的都是 ``NotFound``；量不出来、或超过
        ``MAX_TEMPLATE_MS`` 是 ``ValidationFailed``。"""

        video_url = await self._own_video_upload(principal, body.upload_id)
        if video_url is None:
            raise NotFound("没有这条视频上传")
        try:
            video = await self._probe(video_url)
        except MediaError as exc:
            _logger.warning("品牌模板的视频量不出来", upload_id=body.upload_id, error=str(exc))
            raise ValidationFailed("读不出这条视频的画面与时长，请换一条或稍后重试") from exc
        if video.duration_ms > MAX_TEMPLATE_MS:
            raise ValidationFailed(
                f"这条视频长 {format_seconds(video.duration_ms / 1000)} 秒，"
                f"片头片尾最长 {format_seconds(MAX_TEMPLATE_MS / 1000)} 秒"
            )
        created = await self._store.create(
            position=body.position,
            name=body.name,
            video_url=video_url,
            video=video,
            created_by=principal.user_id,
            api_key_id=principal.api_key_id,
        )
        return BrandTemplateOut.of(created)

    async def list(
        self, principal: Principal, *, position: Position | None, include_disabled: bool
    ) -> BrandTemplatesOut:
        """建立晚的排前面；默认只列在用的，连停用的一起列只限治理者，别人要是 ``PermissionDenied``。"""

        if include_disabled and not principal.has(MANAGE_PERMISSION):
            raise PermissionDenied("只有管理员能看停用的模板")
        found = await self._store.list(position=position, include_disabled=include_disabled)
        return BrandTemplatesOut(items=[BrandTemplateOut.of(one) for one in found])

    async def update(self, template_id: uuid.UUID, body: BrandTemplateUpdateIn) -> BrandTemplateOut:
        """改名、停用或恢复使用；没有这条模板是 ``NotFound``。"""

        updated = await self._store.update(template_id, name=body.name, disabled=body.disabled)
        if updated is None:
            raise NotFound("没有这个品牌模板")
        return BrandTemplateOut.of(updated)


__all__ = ["BrandTemplateService"]
