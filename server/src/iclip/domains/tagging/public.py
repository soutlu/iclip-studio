"""tagging 的跨模块契约：其它模块只准从这里 import。"""

from __future__ import annotations

from iclip.domains.tagging.infra_sql import entry_columns_sql, entry_filter_sql, entry_join_sql
from iclip.domains.tagging.models import KIND_REFERENCE, EntryKey, TagErrorCode, TagStatus
from iclip.domains.tagging.service import TaggingService

__all__ = [
    "KIND_REFERENCE",
    "EntryKey",
    "TagErrorCode",
    "TagStatus",
    "TaggingService",
    "entry_columns_sql",
    "entry_filter_sql",
    "entry_join_sql",
]
