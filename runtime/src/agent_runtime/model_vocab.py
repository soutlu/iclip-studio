from __future__ import annotations

from typing import Literal

ModelApi = Literal["chat", "responses", "gemini"]

ThinkingEffort = Literal["none", "minimal", "low", "medium", "high", "xhigh", "max"]

__all__ = ["ModelApi", "ThinkingEffort"]
