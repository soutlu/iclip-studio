"""模型的接口与思考档位词表；Agent 引擎装配模型、运行配置与模型供应商的声明共用这一份。"""

from __future__ import annotations

from typing import Literal

ModelApi = Literal["chat", "responses"]
"""OpenAI 兼容端点用哪套接口：``chat`` 是 Chat Completions，``responses`` 是 Responses。"""

ThinkingEffort = Literal["none", "minimal", "low", "medium", "high", "xhigh", "max"]
"""思考强度档位，即 OpenAI 方言的 ``reasoning.effort``。"""

__all__ = ["ModelApi", "ThinkingEffort"]
