"""应用用的运行时客户端库：经 HTTP 调 ``/v1`` 各接口、透传管理接口、连两条 WebSocket。

只认接口与帧的形状（``agent_runtime.app_wire``、``transcript.wire``、``live.frames`` 与文件存储、素材台账
的形状），不碰 Web 框架、数据库与引擎；边界见运行时架构测试。
"""

from agent_runtime.client.errors import AppRejected, RuntimeUnavailable, StreamClosed
from agent_runtime.client.runtime_client import (
    DEFAULT_TIMEOUT,
    AdminFiles,
    AdminResponse,
    RuntimeClient,
)
from agent_runtime.client.streams import (
    AppEventFrame,
    EventStream,
    RawFrame,
    TranscriptChannel,
    WorkChangedFrame,
)

__all__ = [
    "DEFAULT_TIMEOUT",
    "AdminFiles",
    "AdminResponse",
    "AppEventFrame",
    "AppRejected",
    "EventStream",
    "RawFrame",
    "RuntimeClient",
    "RuntimeUnavailable",
    "StreamClosed",
    "TranscriptChannel",
    "WorkChangedFrame",
]
