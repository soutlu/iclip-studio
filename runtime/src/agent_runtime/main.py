from __future__ import annotations

import argparse
import os

import uvicorn

from agent_runtime.http.asgi import CONFIG_ENV
from agent_runtime.http.logging import configure_logging

DEFAULT_PORT = 7790


def main() -> None:
    parser = argparse.ArgumentParser(description="agent runtime service")
    parser.add_argument("--config", default="configs/config.yaml")
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--reload", action="store_true")
    parser.add_argument("--reload-dir", action="append", dest="reload_dirs")
    args = parser.parse_args()

    os.environ[CONFIG_ENV] = args.config
    configure_logging("INFO", "console")
    uvicorn.run(
        "agent_runtime.http.asgi:app_from_env",
        factory=True,
        host=args.host,
        port=args.port,
        reload=args.reload,
        reload_dirs=args.reload_dirs,
        workers=1,
        log_config=None,
    )


if __name__ == "__main__":
    main()
