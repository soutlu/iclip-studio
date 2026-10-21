"""跨端金样：存进 contract/ 下，前端测试读同一份。"""

from __future__ import annotations

import difflib
import json
import os
from pathlib import Path
from typing import Any

CONTRACT_DIR = Path(__file__).resolve().parents[3] / "contract"


def check_golden_file(path: Path, sample: Any) -> None:
    """与 ``path`` 上的金样比对；UPDATE_GOLDEN=1 时改写文件。"""

    rendered = json.dumps(sample, ensure_ascii=False, indent=2, sort_keys=False) + "\n"
    if os.environ.get("UPDATE_GOLDEN") == "1":
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(rendered, encoding="utf-8")
        return
    expected = path.read_text(encoding="utf-8")
    if expected != rendered:
        diff = "".join(
            difflib.unified_diff(
                expected.splitlines(keepends=True),
                rendered.splitlines(keepends=True),
                fromfile=str(path),
                tofile="现在跑出来的",
            )
        )
        raise AssertionError(
            f"金样 {path.name} 变了，确认是有意为之再用 UPDATE_GOLDEN=1 更新：\n{diff}"
        )


__all__ = ["CONTRACT_DIR", "check_golden_file"]
