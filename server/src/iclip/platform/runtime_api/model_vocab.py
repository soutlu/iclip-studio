from __future__ import annotations

from typing import Final, Literal

ModelApi = Literal["chat", "responses", "gemini"]

ThinkingEffort = Literal["none", "minimal", "low", "medium", "high", "xhigh", "max"]

# 配置组名：应用每次调用带的不透明组名，按它挑密钥上记着同名组的那把。
MODEL_GROUP_PATTERN: Final = r"^[a-z][a-z0-9_]*$"

__all__ = ["MODEL_GROUP_PATTERN", "ModelApi", "ThinkingEffort"]
