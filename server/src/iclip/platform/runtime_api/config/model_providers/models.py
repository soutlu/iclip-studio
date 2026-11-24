from __future__ import annotations

from typing import Literal

ModelType = Literal["llm", "embedding", "rerank"]

CredentialFieldType = Literal["secret", "text"]


__all__ = [
    "CredentialFieldType",
    "ModelType",
]
