from __future__ import annotations

import os
from pathlib import Path

from iclip.app.bootstrap import build_app
from iclip.config import load_runtime_config

app = build_app(load_runtime_config(Path(os.environ.get("CONFIG_FILE", "configs/config.yaml"))))
