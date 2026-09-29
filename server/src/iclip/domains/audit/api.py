"""审计报表 HTTP 端点。只读口都要 ``users:manage``，形状见合同 §12。"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Query

from iclip.domains.audit.models import ExecutionSort, SortOrder
from iclip.domains.audit.schemas import AuditExecutionsOut, AuditPeopleOut, OverviewOut
from iclip.domains.audit.service import AuditService
from iclip.domains.identity.public import MANAGE_PERMISSION, Principal, require_permission
from iclip.platform.paging import DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT

UserNameQuery = Annotated[str | None, Query(alias="userName", max_length=150)]
TimezoneQuery = Annotated[str, Query(max_length=64)]


def create_audit_router(service: AuditService) -> APIRouter:
    router = APIRouter(prefix="/audit", tags=["audit"])

    @router.get("/overview", response_model=OverviewOut)
    async def overview(
        _: Annotated[Principal, require_permission(MANAGE_PERMISSION)],
        since: datetime,
        until: datetime | None = None,
        timezone: TimezoneQuery = "UTC",
    ) -> OverviewOut:
        """审计总览：本期与上一期的整段指标、按粒度分期的趋势与 7 / 30 日均线、出片次数分布。

        ``until`` 不给或晚于此刻都按此刻算；时间窗最长 366 天。粒度、上一期、非活跃日与均线的
        补窗规则见合同 §12。
        """

        return await service.overview(since=since, until=until, timezone=timezone)

    @router.get("/people", response_model=AuditPeopleOut)
    async def people(
        _: Annotated[Principal, require_permission(MANAGE_PERMISSION)],
        since: datetime,
        until: datetime | None = None,
        timezone: TimezoneQuery = "UTC",
    ) -> AuditPeopleOut:
        """按人：时间窗里出过片或跑过的每个人一行指标，外加每期成片数；一次全给。

        时间窗与粒度规则同总览，见合同 §12。
        """

        return await service.people(since=since, until=until, timezone=timezone)

    @router.get("/executions", response_model=AuditExecutionsOut)
    async def executions(
        _: Annotated[Principal, require_permission(MANAGE_PERMISSION)],
        since: datetime,
        until: datetime | None = None,
        user_name: UserNameQuery = None,
        sort: ExecutionSort = "start",
        order: SortOrder = "desc",
        limit: Annotated[int, Query(ge=1, le=MAX_LIST_LIMIT)] = DEFAULT_LIST_LIMIT,
        cursor: str | None = None,
    ) -> AuditExecutionsOut:
        """按任务执行：对话建立时刻落在时间窗里、有运行或出片的对话，一段一行，带四种异常。

        排序键取值为空的恒排最后；游标只对发它的那种排序有效。异常判定与门槛见合同 §12。
        """

        return await service.executions(
            since=since,
            until=until,
            user_name=user_name,
            sort=sort,
            order=order,
            limit=limit,
            cursor=cursor,
        )

    return router


__all__ = ["create_audit_router"]
