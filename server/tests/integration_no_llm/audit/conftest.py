"""审计报表用例的夹具：报表经进程内的运行时服务取运行时的事实行，服务层接在它上面。"""

from __future__ import annotations

from collections.abc import AsyncGenerator

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.audit.reports_pg import PgAuditReports
from iclip.domains.audit.service import AuditService
from tests.helpers.audit import audit_reports


@pytest.fixture
async def reports(engine: AsyncEngine) -> AsyncGenerator[PgAuditReports]:
    async with audit_reports(engine) as found:
        yield found


@pytest.fixture
def service(reports: PgAuditReports) -> AuditService:
    return AuditService(reports)
