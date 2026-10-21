"""埋点的存储协议。实现在 infra_sql.py，服务层只依赖这里。"""

from __future__ import annotations

import uuid
from typing import Protocol

from iclip.domains.tracking.models import TrackingEvent


class TrackingRepository(Protocol):
    async def downloadable(self, job_id: uuid.UUID) -> bool:
        """这条生成记录是不是一条可下载的视频，即素材片：成功、有地址的出片或合成。

        不存在与不合格一样是 ``False``，不按主体裁：持 ``generation:read`` 就看得到全站的片。"""
        ...

    async def record(self, event: TrackingEvent) -> None:
        """追加一行，发生时刻取数据库时钟。"""
        ...


__all__ = ["TrackingRepository"]
