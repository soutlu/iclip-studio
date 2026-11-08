from __future__ import annotations

from typing import Literal

ModelType = Literal["llm", "embedding", "rerank"]

ModelSource = Literal["declared", "custom"]

CredentialFieldType = Literal["secret", "text"]


__all__ = [
    "CredentialFieldType",
    "ModelSource",
    "ModelType",
]
