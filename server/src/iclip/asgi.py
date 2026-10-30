"""ASGI 导出入口：``iclip.asgi:app``。

配置路径来自 ``CONFIG_FILE``。import 本模块只建插件登记表与各个服务，不连库、不装配 agent：连接与后台
循环都留给 lifespan，agent 每次运行按对话固定的版本从库里装配。合同导出靠的就是这一点：
``scripts/dump_openapi.py`` 只 import 本模块取 OpenAPI，从不启动应用。配置里有要用 ffmpeg 的功能时，
import 会同步跑一次本地视频编解码探测（几条秒内结束的 ffmpeg 子进程）；没有硬件的机器上它落到软件。
"""

from __future__ import annotations

import os
from pathlib import Path

from iclip.app.bootstrap import build_app
from iclip.config import load_runtime_config

app = build_app(load_runtime_config(Path(os.environ.get("CONFIG_FILE", "configs/config.yaml"))))
