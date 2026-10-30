"""技能库的领域形状：技能、草稿文件、版本与它们的上限。术语见 docs/CONTEXT.md「技能库」。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Final, Literal

SkillStatus = Literal["active", "archived"]
"""``active`` 在用；``archived`` 已归档。"""

STATUS_ACTIVE: Final = "active"
STATUS_ARCHIVED: Final = "archived"

SKILL_MD: Final = "SKILL.md"
"""每个技能必须有的入口文件，放在技能的根目录。"""

REFERENCES_DIR: Final = "references/"
"""``SKILL.md`` 之外的文件只能放在这个目录下（可以再分子目录）。"""

MAX_NAME_CHARS: Final = 64
"""技能标识的长度上限，按 Agent Skills 规范。"""

MAX_DISPLAY_NAME_CHARS: Final = 100
MAX_DESCRIPTION_CHARS: Final = 1024
"""``SKILL.md`` frontmatter 里 ``description`` 的长度上限，按 Agent Skills 规范。"""

MAX_FILE_BYTES: Final = 1024 * 1024
"""单个文件按 UTF-8 编码后的字节数上限。"""

MAX_TOTAL_BYTES: Final = 5 * 1024 * 1024
"""一个技能全部文件的字节数合计上限。"""

MAX_FILES: Final = 200

MAX_ARCHIVE_BYTES: Final = 6 * 1024 * 1024
"""导入的压缩包本身的上限：内容上限加上 zip 头部与目录的开销。"""


@dataclass(frozen=True, slots=True)
class FileEntry:
    """清单里的一个文件：路径、UTF-8 字节数与内容的 sha256（十六进制）。"""

    path: str
    size: int
    hash: str


@dataclass(frozen=True, slots=True)
class DraftFileInfo:
    """草稿里的一个文件，不带内容。"""

    path: str
    size: int
    hash: str
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class DraftFile:
    """草稿里的一个文件，带内容。"""

    path: str
    content: str
    size: int
    hash: str
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class Skill:
    id: uuid.UUID
    name: str
    """标识，创建后不能改。"""
    display_name: str
    description: str
    """发布时取这一版 ``SKILL.md`` 的 ``description``；还没发布过时取草稿里的。"""
    latest_version_id: uuid.UUID | None
    latest_version: int | None
    """最新版的版本号；没发布过为 ``None``。"""
    latest_content_hash: str | None
    status: SkillStatus
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class SkillSummary:
    """列表里的一个技能，带草稿清单的 hash，用来判断有没有未发布的修改。"""

    skill: Skill
    draft_hash: str


@dataclass(frozen=True, slots=True)
class SkillVersion:
    """发布一次生成的不可变版本。"""

    id: uuid.UUID
    skill_id: uuid.UUID
    version: int
    note: str | None
    manifest: tuple[FileEntry, ...]
    """按 ``path`` 排好。"""
    content_hash: str
    created_by: uuid.UUID
    created_at: datetime


__all__ = [
    "MAX_ARCHIVE_BYTES",
    "MAX_DESCRIPTION_CHARS",
    "MAX_DISPLAY_NAME_CHARS",
    "MAX_FILES",
    "MAX_FILE_BYTES",
    "MAX_NAME_CHARS",
    "MAX_TOTAL_BYTES",
    "REFERENCES_DIR",
    "SKILL_MD",
    "STATUS_ACTIVE",
    "STATUS_ARCHIVED",
    "DraftFile",
    "DraftFileInfo",
    "FileEntry",
    "Skill",
    "SkillStatus",
    "SkillSummary",
    "SkillVersion",
]
