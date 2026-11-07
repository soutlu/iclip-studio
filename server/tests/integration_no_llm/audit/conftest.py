from __future__ import annotations

from collections.abc import AsyncGenerator

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.audit.service import AuditService
from tests.helpers.audit import FreshReports, audit_reports


@pytest.fixture
async def reports(engine: AsyncEngine) -> AsyncGenerator[FreshReports]:
    async with audit_reports(engine) as found:
        yield found


@pytest.fixture
def service(reports: FreshReports) -> AuditService:
    return AuditService(reports)
