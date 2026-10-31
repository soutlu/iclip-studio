"""运行时服务的 HTTP 入口：app 工厂（``http.app``）、应用密钥鉴权、错误信封（``http.errors``）与 ``/v1`` 接口。

FastAPI 与 Starlette 只在本包里出现。包本身不 import app 工厂：后端只引用 ``http.errors``，不该连带装上整个
运行时服务。
"""
