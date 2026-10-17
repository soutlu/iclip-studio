"""品牌资源用例：治理者登记视频或字体、改名、停用与恢复，读者按种类与品牌筛选。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import structlog

from iclip.common.errors import Conflict, NotFound, PermissionDenied, ValidationFailed
from iclip.common.shot_prompt import format_seconds
from iclip.domains.brand_templates.models import MAX_TEMPLATE_MS, FontUploadTicket
from iclip.domains.brand_templates.repository import (
    BrandTemplateStore,
    OwnVideoUpload,
    ProbeFont,
    ProbeVideo,
)
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
from iclip.platform.media.fonts import MAX_FONT_BYTES
from iclip.platform.object_store.layout import MEDIA_PATHS
from iclip.platform.object_store.store import SIGNED_PUT_EXPIRES_SECONDS, SignedUploadStore

_logger = structlog.stdlib.get_logger(__name__)


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
        """拿调用者自己的一条视频上传建一条在用的模板，画幅、时长与音轨从视频本身量出来记下。

        别人的上传、不是视频的上传、不存在的都是 ``NotFound``；量不出来、或超过
        ``MAX_TEMPLATE_MS`` 是 ``ValidationFailed``。"""

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
        """建立晚的排前面；默认只列在用的，连停用的一起列只限治理者，别人要是 ``PermissionDenied``。"""

        if include_disabled and not principal.has(MANAGE_PERMISSION):
            raise PermissionDenied("只有管理员能看停用的模板")
        found = await self._store.list(kind=kind, brand=brand, include_disabled=include_disabled)
        return BrandTemplatesOut(items=[BrandTemplateOut.of(one) for one in found])

    async def update(self, template_id: uuid.UUID, body: BrandTemplateUpdateIn) -> BrandTemplateOut:
        """改名、停用或恢复使用；没有这条模板是 ``NotFound``。"""

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

    def sign_font(self, principal: Principal, body: BrandFontSignIn) -> FontUploadTicket:
        upload_id = uuid.uuid4()
        ext = "ttf" if body.content_type == "font/ttf" else "otf"
        headers = {"Content-Type": body.content_type, "x-oss-meta-uploader": str(principal.user_id)}
        if principal.api_key_id is not None:
            headers["x-oss-meta-api-key"] = str(principal.api_key_id)
        url = self._objects.sign_put(
            object_key=MEDIA_PATHS.font_upload(
                user_id=principal.user_id, upload_id=upload_id, ext=ext
            ),
            headers=headers,
        )
        return FontUploadTicket(
            upload_id=upload_id,
            upload_url=url,
            headers=headers,
            expires_at=datetime.now(UTC) + timedelta(seconds=SIGNED_PUT_EXPIRES_SECONDS),
        )

    async def confirm_font(
        self, principal: Principal, upload_id: uuid.UUID, body: BrandFontConfirmIn
    ) -> BrandTemplateOut:
        """确认字体文件并幂等登记品牌资源；不创建生成记录。"""

        previous = await self._store.get(upload_id)
        if previous is not None:
            if previous.kind != "font" or previous.created_by != principal.user_id:
                raise NotFound("没有这次字体上传")
            return BrandTemplateOut.of(previous)
        found = await self._objects.find_object(
            prefix=MEDIA_PATHS.font_upload_prefix(user_id=principal.user_id, upload_id=upload_id)
        )
        if found is None:
            raise Conflict("字体文件尚未上传，请上传完成后重试")
        if found.content_type not in ("font/ttf", "font/otf"):
            raise ValidationFailed("只接受静态 TTF 或 OTF 字体")
        if found.size_bytes > MAX_FONT_BYTES:
            raise ValidationFailed(f"字体文件不能超过 {MAX_FONT_BYTES // (1024 * 1024)} MB")
        url = self._objects.public_url(found.object_key)
        await self._font_info(url)
        created = await self._store.create(
            resource_id=upload_id,
            kind="font",
            brand=body.brand,
            name=body.name,
            url=url,
            video=None,
            created_by=principal.user_id,
            api_key_id=principal.api_key_id,
        )
        if created.kind != "font" or created.created_by != principal.user_id:
            raise NotFound("没有这次字体上传")
        return BrandTemplateOut.of(created)

    async def font_info(self, template_id: uuid.UUID) -> BrandFontInfoOut:
        """按文件读取内部字体信息；停用资源的已有整片仍可以预览。"""

        resource = await self._store.get(template_id)
        if resource is None:
            raise NotFound("没有这个字体资源")
        if resource.kind != "font":
            raise ValidationFailed("所选资源不是字体")
        return await self._font_info(resource.url)

    async def _font_info(self, url: str) -> BrandFontInfoOut:
        try:
            return BrandFontInfoOut.of(await self._probe_font(url))
        except MediaError as exc:
            raise ValidationFailed(f"字体无法使用：{exc}") from exc


__all__ = ["BrandTemplateService"]
