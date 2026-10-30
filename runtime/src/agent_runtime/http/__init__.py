"""运行时服务的 HTTP 入口：app 工厂、应用密钥鉴权、错误信封与 ``/v1`` 接口。

FastAPI 与 Starlette 只在本包里出现。
"""

from agent_runtime.http.app import create_app

__all__ = ["create_app"]
