"""品牌模板的端口：自有表的仓储，以及由组合根接上的上传记录与视频探测。"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable, Sequence
from typing import Protocol

from iclip.domains.brand_templates.models import BrandTemplate, ProbedVideo
from iclip.domains.identity.public import Principal
from iclip.platform.media.fonts import FontInfo


class BrandTemplateStore(Protocol):
    """品牌资源的数据访问；时刻都用数据库时钟。"""

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
    ) -> BrandTemplate:
        """按资源 id 幂等新建，存在时交回原行，不覆盖名称或属主。"""
        ...

    async def get(self, template_id: uuid.UUID) -> BrandTemplate | None:
        """按 id 读，含停用的；没有给 ``None``。"""
        ...

    async def list(
        self, *, kind: str | None, brand: str | None, include_disabled: bool
    ) -> Sequence[BrandTemplate]:
        """建立晚的排前面，同一刻按 id 倒序；``include_disabled`` 为假只列在用的。"""
        ...

    async def update(
        self,
        template_id: uuid.UUID,
        *,
        name: str | None,
        disabled: bool | None,
        brand: str | None = None,
        update_brand: bool = False,
    ) -> BrandTemplate | None:
        """在一个事务里改名、停用或恢复使用，交回改完的那一行；为 ``None`` 的那一项不动。停用记下
        停用时刻（已停用的保留原来的时刻），恢复使用清掉它。没有这一行给 ``None``。"""
        ...


OwnVideoUpload = Callable[[Principal, uuid.UUID], Awaitable[str | None]]
"""主体本人这条视频上传的地址，参数为（主体，``uploadId``）；不是他的、不是视频上传或不存在都给
``None``。由组合根接到生成域的上传记录上。"""

ProbeVideo = Callable[[str], Awaitable[ProbedVideo]]
"""下载这个地址的视频，量出画幅、时长与有没有音轨；取不到或读不懂抛 ``MediaError``。由组合根接上。"""


ProbeFont = Callable[[str], Awaitable[FontInfo]]
"""读取字体内部属性；不能解析时抛 MediaError。由组合根连接下载与字体解析。"""


__all__ = ["BrandTemplateStore", "OwnVideoUpload", "ProbeFont", "ProbeVideo"]
