"""做同款的适配：对话域建对话时拷哪几份文件与认源端口、资料库的「做得了同款」判断，接到资料库读模型与
文件存储上。拷贝本身由运行时的会话服务按这里给的清单做。

拷哪几份文件、拷过去叫什么、什么样的对话做得了同款都只在这里定，两处共用。"""

from __future__ import annotations

import uuid
from typing import Final

from agent_runtime.file_store.namespace import namespace_for
from agent_runtime.file_store.store import FileStore
from iclip_video.iclip_studio.film.film import FILM_PATH, RUN_PATH
from iclip_video.shot_document import SHOTS_PATH

from iclip.domains.conversations.service import SameStyleFiles
from iclip.domains.library.repository import LibraryReports

TREATMENT_PATH: Final = "treatment.md"
"""AI 导演写的新片执行方案，路径是 skill 里的约定。做同款把它拷进新对话；爆款素材库看素材片所在
对话有没有它来判断能否入选，并按它的内容打标（见 ``app/library_tagging.py``）。"""

SAME_STYLE_FILES: Final = (
    (TREATMENT_PATH, TREATMENT_PATH),
    # 工程文件与分镜文件在页面上会自动打开制作页、分镜页；改个名，等 agent 改完再改回来。
    (FILM_PATH, "old_film.icml"),
    (RUN_PATH, RUN_PATH),
    (SHOTS_PATH, "old_video_shot.json"),
)
"""（源路径，新对话里的路径），源里没有的跳过；其余文件一概不拷。"""

_PRODUCTION_FILES: Final = frozenset({FILM_PATH, SHOTS_PATH})
"""有其中一份才做得了同款。"""

SAME_STYLE: Final = SameStyleFiles(files=SAME_STYLE_FILES, require_any=_PRODUCTION_FILES)
"""对话域做同款用的清单。"""


class ProductionFilesProbe:
    """给资料库判断一段对话做不做得了同款，与对话域做同款同一个口径。"""

    def __init__(self, store: FileStore) -> None:
        self._store = store

    async def has_production_files(self, owner: uuid.UUID, conversation_id: uuid.UUID) -> bool:
        """这段对话的工作区里有没有工程文件或分镜文件。"""

        entries = await self._store.entries(namespace_for(owner, str(conversation_id)))
        return any(entry.path in _PRODUCTION_FILES for entry in entries)


class LibrarySameStyleSource:
    """对话域 ``SameStyleSource`` 的实现：按资料库的卡认源。

    挂着对话的卡以对话 id 为卡 id，不挂对话的以出片 id 为卡 id、没有属主；所以卡有属主，卡 id
    就是那段对话的 id。资料库不看删除标记，删了的对话照样认。"""

    def __init__(self, reports: LibraryReports) -> None:
        self._reports = reports

    async def __call__(self, card_id: uuid.UUID) -> uuid.UUID | None:
        row = await self._reports.card_of(card_id)
        return None if row is None else row.conversation_owner


__all__ = ["SAME_STYLE", "LibrarySameStyleSource", "ProductionFilesProbe"]
