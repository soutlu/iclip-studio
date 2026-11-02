"""模型的接口与思考档位词表；Agent 引擎装配模型、运行配置与模型供应商的声明共用这一份。"""

from __future__ import annotations

from typing import Literal

ModelApi = Literal["chat", "responses", "gemini"]
"""模型走哪套接口：``chat`` 是 OpenAI 兼容的 Chat Completions，``responses`` 是 OpenAI 兼容的
Responses，``gemini`` 是 Gemini 原生接口。一家供应商支持哪几套由它的声明写明。"""

ThinkingEffort = Literal["none", "minimal", "low", "medium", "high", "xhigh", "max"]
"""思考强度档位，即 OpenAI 方言的 ``reasoning.effort``；``none`` 是不思考。"""

__all__ = ["ModelApi", "ThinkingEffort"]
