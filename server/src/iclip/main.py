from __future__ import annotations

import argparse
import os

import uvicorn

from iclip.app.logging import configure_logging


def main() -> None:
    parser = argparse.ArgumentParser(description="iclip-studio server")
    parser.add_argument("--config", default="configs/config.yaml")
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", type=int, default=7788)
    parser.add_argument("--reload", action="store_true")
    parser.add_argument("--reload-dir", action="append", dest="reload_dirs")
    parser.add_argument("--workers", type=int, default=1)
    args = parser.parse_args()

    if args.workers < 1:
        parser.error("--workers 必须 ≥ 1")
    if args.reload and args.workers > 1:
        parser.error("--reload 与多 worker 互斥")

    os.environ["CONFIG_FILE"] = args.config
    configure_logging("INFO", "console")
    uvicorn.run(
        "iclip.asgi:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        reload_dirs=args.reload_dirs,
        workers=args.workers if not args.reload else 1,
        log_config=None,
    )


if __name__ == "__main__":
    main()
