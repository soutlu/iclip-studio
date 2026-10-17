from __future__ import annotations

import uuid
from typing import Final

import structlog

from iclip.common.brand_vocab import BRAND_FONT
from iclip.common.errors import Conflict, NotFound, PermissionDenied, ValidationFailed
from iclip.common.shot_prompt import format_seconds
from iclip.domains.brand_templates.models import FONT_EXTENSIONS, MAX_TEMPLATE_MS
from iclip.domains.brand_templates.repository import BrandTemplateStore, OwnVideoUpload, ProbeVideo
from iclip.domains.brand_templates.schemas import (
    BrandFontConfirmIn,
    BrandFontInfoOut,
    BrandFontSignIn,
    BrandTemplateCreateIn,
    BrandTemplateOut,
    BrandTemplatesOut,
    BrandTemplateUpdateIn,
)
from iclip.domains.identity.public import MANAGE_PERMISSION, Principal
from iclip.platform.media.errors import MediaError
from iclip.platform.media.fonts import MAX_FONT_BYTES, FontError, ProbeFont
from iclip.platform.object_store.direct_upload import UploadTicket, signed_upload_ticket
from iclip.platform.object_store.layout import MEDIA_PATHS
from iclip.platform.object_store.store import SignedUploadStore

_logger = structlog.stdlib.get_logger(__name__)

UNREADABLE_FONT: Final = "字体文件无法读取，无法使用；请上传静态 TTF 或 OTF 字体"


class BrandTemplateService:
    def __init__(
        self,
        store: BrandTemplateStore,
        *,
        own_video_upload: OwnVideoUpload,
        probe: ProbeVideo,
        objects: SignedUploadStore,
        probe_font: ProbeFont,
    ) -> None:
        self._store = store
        self._own_video_upload = own_video_upload
        self._probe = probe
        self._objects = objects
        self._probe_font = probe_font

    async def create(self, principal: Principal, body: BrandTemplateCreateIn) -> BrandTemplateOut:
        url = await self._own_video_upload(principal, body.upload_id)
        if url is None:
            raise NotFound("没有这条视频上传")
        try:
            video = await self._probe(url)
        except MediaError as exc:
            _logger.warning("品牌模板的视频量不出来", upload_id=body.upload_id, error=str(exc))
            raise ValidationFailed("读不出这条视频的画面与时长，请换一条或稍后重试") from exc
        if video.duration_ms > MAX_TEMPLATE_MS:
            raise ValidationFailed(
                f"这条视频长 {format_seconds(video.duration_ms / 1000)} 秒，"
                f"片头片尾最长 {format_seconds(MAX_TEMPLATE_MS / 1000)} 秒"
            )
        created = await self._store.create(
            resource_id=uuid.uuid4(),
            kind=body.kind,
            brand=body.brand,
            name=body.name,
            url=url,
            video=video,
            created_by=principal.user_id,
            api_key_id=principal.api_key_id,
        )
        return BrandTemplateOut.of(created)

    async def list(
        self, principal: Principal, *, kind: str | None, brand: str | None, include_disabled: bool
    ) -> BrandTemplatesOut:
        if include_disabled and not principal.has(MANAGE_PERMISSION):
            raise PermissionDenied("只有管理员能看停用的模板")
        found = await self._store.list(kind=kind, brand=brand, include_disabled=include_disabled)
        return BrandTemplatesOut(items=[BrandTemplateOut.of(one) for one in found])

    async def update(self, template_id: uuid.UUID, body: BrandTemplateUpdateIn) -> BrandTemplateOut:
        updated = await self._store.update(
            template_id,
            name=body.name,
            disabled=body.disabled,
            brand=body.brand,
            update_brand="brand" in body.model_fields_set,
        )
        if updated is None:
            raise NotFound("没有这个品牌模板")
        return BrandTemplateOut.of(updated)

    def sign_font(self, principal: Principal, body: BrandFontSignIn) -> UploadTicket:
        upload_id = uuid.uuid4()
        return signed_upload_ticket(
            self._objects,
            upload_id=upload_id,
            object_key=MEDIA_PATHS.font_upload(
                user_id=principal.user_id,
                upload_id=upload_id,
                ext=FONT_EXTENSIONS[body.content_type],
            ),
            content_type=body.content_type,
            user_id=principal.user_id,
            api_key_id=principal.api_key_id,
        )

    async def confirm_font(
        self, principal: Principal, upload_id: uuid.UUID, body: BrandFontConfirmIn
    ) -> BrandTemplateOut:
        previous = await self._store.get(upload_id)
        if previous is not None:
            if previous.kind != BRAND_FONT or previous.created_by != principal.user_id:
                raise NotFound("没有这次字体上传")
            return BrandTemplateOut.of(previous)
        found = await self._objects.find_object(
            prefix=MEDIA_PATHS.font_upload_prefix(user_id=principal.user_id, upload_id=upload_id)
        )
        if found is None:
            raise Conflict("字体文件尚未上传，请上传完成后重试")
        if found.content_type not in FONT_EXTENSIONS:
            raise ValidationFailed("只接受静态 TTF 或 OTF 字体")
        if found.size_bytes > MAX_FONT_BYTES:
            raise ValidationFailed(f"字体文件不能超过 {MAX_FONT_BYTES // (1024 * 1024)} MB")
        url = self._objects.public_url(found.object_key)
        await self._read_font(url, resource_id=upload_id)
        created = await self._store.create(
            resource_id=upload_id,
            kind=BRAND_FONT,
            brand=body.brand,
            name=body.name,
            url=url,
            video=None,
            created_by=principal.user_id,
            api_key_id=principal.api_key_id,
        )
        if created.kind != BRAND_FONT or created.created_by != principal.user_id:
            raise NotFound("没有这次字体上传")
        return BrandTemplateOut.of(created)

    async def font_info(self, template_id: uuid.UUID) -> BrandFontInfoOut:
        resource = await self._store.get(template_id)
        if resource is None:
            raise NotFound("没有这个字体资源")
        if resource.kind != BRAND_FONT:
            raise ValidationFailed("所选资源不是字体")
        return await self._read_font(resource.url, resource_id=template_id)

    async def _read_font(self, url: str, *, resource_id: uuid.UUID) -> BrandFontInfoOut:
        try:
            return BrandFontInfoOut.of(await self._probe_font(url))
        except FontError as exc:
            _logger.warning("字体文件读取失败", template_id=resource_id, error=str(exc))
            raise ValidationFailed(str(exc)) from exc
        except MediaError as exc:
            _logger.warning("字体文件读取失败", template_id=resource_id, error=str(exc))
            raise ValidationFailed(UNREADABLE_FONT) from exc


__all__ = ["UNREADABLE_FONT", "BrandTemplateService"]
