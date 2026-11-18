from __future__ import annotations

import re
import subprocess
import sys
import unicodedata
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent.parent
FENCED_BLOCK = re.compile(r"^ {0,3}(`{3,}|~{3,})[^\n]*\n.*?^ {0,3}\1[ \t]*$", re.M | re.S)
HEADING = re.compile(r"^#{1,6}\s+(.+?)\s*#*\s*$", re.M)
INLINE_CODE = re.compile(r"`([^`]*)`")
INLINE_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
EMPHASIS = re.compile(r"[*_~]+")
LINK = re.compile(r"\[[^\]]*\]\(([^)\s]+)\)")
MAKE_MENTION = re.compile(r"`make ([A-Za-z0-9_-]+)`")
MAKE_TARGET = re.compile(r"^([A-Za-z0-9_-]+):", re.M)


def tracked_markdown() -> list[Path]:
    out = subprocess.run(
        ["git", "ls-files", "*.md", "**/*.md"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return [ROOT / line for line in out.splitlines() if "node_modules" not in line]


def strip_fenced_code(text: str) -> str:
    return FENCED_BLOCK.sub("", text)


def github_slug(heading: str) -> str:
    text = INLINE_LINK.sub(r"\1", heading)
    text = INLINE_CODE.sub(r"\1", text)
    text = EMPHASIS.sub("", text).strip().lower()
    kept: list[str] = []
    for ch in text:
        if ch in ("-", " "):
            kept.append("-" if ch == " " else ch)
            continue
        category = unicodedata.category(ch)
        if category[0] in ("L", "N", "M") or category == "Pc":
            kept.append(ch)
    return "".join(kept)


def markdown_anchors(path: Path, cache: dict[Path, set[str]]) -> set[str]:
    resolved = path.resolve()
    if resolved in cache:
        return cache[resolved]
    text = strip_fenced_code(resolved.read_text(encoding="utf-8"))
    anchors: set[str] = set()
    counts: dict[str, int] = {}
    for raw_heading in HEADING.findall(text):
        base = github_slug(raw_heading)
        if not base:
            continue
        seen = counts.get(base, 0)
        counts[base] = seen + 1
        anchors.add(base if seen == 0 else f"{base}-{seen}")
    cache[resolved] = anchors
    return anchors


def main() -> int:
    targets = set(MAKE_TARGET.findall((ROOT / "Makefile").read_text(encoding="utf-8")))
    anchor_cache: dict[Path, set[str]] = {}
    problems: list[str] = []
    for md in tracked_markdown():
        raw_text = md.read_text(encoding="utf-8")
        text = strip_fenced_code(raw_text)
        rel = md.relative_to(ROOT)
        for raw in LINK.findall(text):
            if raw.startswith(("http://", "https://", "mailto:")):
                continue
            path_part, sep, fragment = raw.partition("#")
            target_file = (md.parent / path_part) if path_part else md
            if path_part and not target_file.exists():
                problems.append(f"{rel}: 链接不存在 {raw}")
                continue
            if sep and fragment and target_file.is_file() and target_file.suffix.lower() == ".md":
                expected = unquote(fragment).lower()
                if expected not in markdown_anchors(target_file, anchor_cache):
                    problems.append(f"{rel}: 锚点不存在 {raw}")
        for target in MAKE_MENTION.findall(raw_text):
            if target not in targets:
                problems.append(f"{rel}: Makefile 没有 `make {target}`")
    for line in problems:
        print(line)
    if problems:
        print(f"[docs] {len(problems)} 处不符")
        return 1
    print("[docs] 链接、锚点与 make 目标核对通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
