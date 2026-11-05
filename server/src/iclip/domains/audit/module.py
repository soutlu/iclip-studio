from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.audit.api import create_audit_router
from iclip.domains.audit.repository import AuditReports
from iclip.domains.audit.service import AuditService


@dataclass(frozen=True)
class AuditModule:
    routers: tuple[Any, ...]

    service: AuditService


def build_audit_module(reports: AuditReports) -> AuditModule:
    service = AuditService(reports)
    return AuditModule(routers=(create_audit_router(service),), service=service)


__all__ = ["AuditModule", "build_audit_module"]
