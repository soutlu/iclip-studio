"""运行时服务的启动入口：``python -m agent_runtime.main --config <yaml>``。

只跑一个 worker：后面要接的运行驱动与实时投影都在单个进程里。
"""

from __future__ import annotations

import argparse
import os

import uvicorn

from agent_runtime.http.asgi import CONFIG_ENV
from agent_runtime.http.logging import QUIET_LOGGERS, SERVICE_NAME, configure_logging

DEFAULT_PORT = 7790


def main() -> None:
    parser = argparse.ArgumentParser(description="agent runtime service")
    parser.add_argument("--config", default="configs/config.yaml")
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--reload", action="store_true")
    # 可重复；给了就只看这些目录（uvicorn 不再默认看当前目录），不给照 uvicorn 默认。
    parser.add_argument("--reload-dir", action="append", dest="reload_dirs")
    args = parser.parse_args()

    os.environ[CONFIG_ENV] = args.config
    # 这里先配一遍给监督进程（reload 时 uvicorn 的启动行由它打）；worker 建 app 时再按配置文件的
    # 级别与格式配自己那一份。
    configure_logging("INFO", "console", service=SERVICE_NAME, quiet=QUIET_LOGGERS)
    uvicorn.run(
        "agent_runtime.http.asgi:app_from_env",
        factory=True,
        host=args.host,
        port=args.port,
        reload=args.reload,
        reload_dirs=args.reload_dirs,
        workers=1,
        # 不让 uvicorn 自带一套 handler，它的日志与其他来源同一格式。
        log_config=None,
    )


if __name__ == "__main__":
    main()
