"""后端开了哪些插件服务：宿主给运行时的内部接口照它回答，运行时启动时照它核对配了的插件后端接没接，
两边共用这一份。字段名 snake_case 原样；路径写在 contract/conventions.md「后端给运行时的内部接口」。"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class _Wire(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ShotVideoServices(_Wire):
    """取帧拼板、切格与出图挂着：``image_models`` 是宿主接入的图片模型名，按名字排序。"""

    image_models: tuple[str, ...]


class PluginServices(_Wire):
    """宿主挂着的插件服务：``shot_video`` 没挂为 None，``video_breakdown`` 是参考视频拆解挂没挂。"""

    shot_video: ShotVideoServices | None
    video_breakdown: bool


__all__ = ["PluginServices", "ShotVideoServices"]
