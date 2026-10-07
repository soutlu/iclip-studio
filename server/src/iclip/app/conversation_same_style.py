"""做同款的适配：对话域建对话时的拷贝端口与资料库的「做得了同款」判断，接到文件存储与素材台账上。

拷哪几份文件、拷过去叫什么、什么样的对话做得了同款都只在这里定（ADR-0013），两处共用。"""

from __future__ import annotations

import uuid
from typing import Final

from iclip.capabilities.iclip_studio.film.film import FILM_PATH, RUN_PATH
from iclip.capabilities.shot_document import SHOTS_PATH
from iclip.capabilities.workspace.scope import namespace_for
from iclip.platform.file_store.store import FileStore
from iclip.platform.material_ledger.pg import PgMaterialLedger

TREATMENT_PATH: Final = "treatment.md"
"""AI 导演写的创作方案；只是 skill 里的约定，代码里别处不读它。"""

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


class SameStyleCopier:
    """对话域 ``CopySameStyle`` 的实现，另给资料库判断一段对话做不做得了同款。

    写走 FileStore 的写入口而不是裸 SQL，容量与路径校验照旧生效；不走发帧的那一层：新对话的
    行还没落库，这一刻没人订阅得了它。台账要 ``list_all``，所以拿 Postgres 实现。"""

    def __init__(self, *, store: FileStore, ledger: PgMaterialLedger) -> None:
        self._store = store
        self._ledger = ledger

    async def has_production_files(self, owner: uuid.UUID, conversation_id: uuid.UUID) -> bool:
        """这段对话的工作区里有没有工程文件或分镜文件。"""

        entries = await self._store.entries(namespace_for(owner, str(conversation_id)))
        return any(entry.path in _PRODUCTION_FILES for entry in entries)

    async def __call__(
        self,
        *,
        source_owner: uuid.UUID,
        source_id: uuid.UUID,
        target_owner: uuid.UUID,
        target_id: uuid.UUID,
    ) -> bool:
        source = namespace_for(source_owner, str(source_id))
        found = {path: await self._store.read(source, path) for path, _ in SAME_STYLE_FILES}
        if all(found[path] is None for path in _PRODUCTION_FILES):
            return False
        target = namespace_for(target_owner, str(target_id))
        for path, renamed in SAME_STYLE_FILES:
            stored = found[path]
            if stored is not None:
                await self._store.write(target, renamed, stored.content)
        await self._ledger.record(target, await self._ledger.list_all(source))
        return True


__all__ = ["SameStyleCopier"]
