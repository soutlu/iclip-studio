from __future__ import annotations


class DomainError(Exception):
    code: str | None = None


class NotFound(DomainError):
    pass


class PermissionDenied(DomainError):
    pass


class Conflict(DomainError):
    pass


class ValidationFailed(DomainError):
    pass


class AuthenticationFailed(DomainError):
    pass


class AgentUnavailable(Conflict):
    code = "agent_unavailable"


class ModelUnavailable(Conflict):
    code = "model_unavailable"


class HookRejected(DomainError):
    code = "gate_rejected"


__all__ = [
    "AgentUnavailable",
    "AuthenticationFailed",
    "Conflict",
    "DomainError",
    "HookRejected",
    "ModelUnavailable",
    "NotFound",
    "PermissionDenied",
    "ValidationFailed",
]
