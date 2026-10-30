"""视频解析的内存替身。"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class FakeUnderstanding:
    """返回预设文档或抛出预设异常。"""

    document: str = "## 4、逐镜拉片表\n**[00:00.000-00:03.800]** 中景……"
    error: Exception | None = None
    calls: list[str] = field(default_factory=list[str])

    async def parse(self, video_url: str) -> str:
        self.calls.append(video_url)
        if self.error is not None:
            raise self.error
        return self.document


__all__ = ["FakeUnderstanding"]
