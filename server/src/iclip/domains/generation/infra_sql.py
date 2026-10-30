"""生成任务的 Postgres 仓储，仅记录业务事实；排期由 procrastinate 管理。时间统一使用数据库时钟。"""

from __future__ import annotations

import uuid
from collections.abc import Collection, Mapping, Sequence
from typing import Any, Final

from sqlalchemy import (
    Column,
    ColumnElement,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    Table,
    Text,
    Uuid,
    and_,
    func,
    literal_column,
    or_,
    select,
    text,
    true,
    tuple_,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.engine.row import RowMapping
from sqlalchemy.ext.asyncio import AsyncEngine
from sqlalchemy.sql.base import ReadOnlyColumnCollection
from sqlalchemy.sql.elements import KeyedColumnElement

from iclip.common.errors import NotFound, ValidationFailed
from iclip.domains.generation.models import (
    REFERENCE_TRIAL_KEY,
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_PENDING,
    STATUS_SUBMITTED,
    STATUS_SUBMITTING,
    GenerationJob,
    GenerationKind,
    GenerationOperation,
    GenerationOutput,
    GenerationStatus,
    InFlightPhase,
    Inheritance,
)
from iclip.domains.generation.schemas import (
    KIND_VIDEO,
    OPERATION_ENHANCE,
    OPERATION_GENERATE,
    OPERATION_UPLOAD,
    SubtitleSentence,
    request_to_payload,
)
from iclip.domains.generation.stored_requests import request_from_payload
from iclip.platform.db.ownership import owner_conditions

DB_SCHEMA: Final = "iclip"

metadata_obj = MetaData(schema=DB_SCHEMA)

# 只有各种记录都用到、或数据库要按它查的才成列；某种记录自己的输入进 request、产出进 output；
# 加种类不改表，也不建 CHECK。
generation_jobs_table = Table(
    "generation_jobs",
    metadata_obj,
    Column("id", Uuid, primary_key=True),
    Column(
        "owner_user_id",
        Uuid,
        ForeignKey(
            f"{DB_SCHEMA}.users.id", ondelete="cascade", name="generation_jobs_owner_user_id_fkey"
        ),
        nullable=False,
    ),
    # 不关联 api_keys 外键，保留 key 删除后的审计身份。
    Column("api_key_id", Uuid, nullable=True),
    # 不关联对话外键，删除对话后仍保留生成来源。
    Column("conversation_id", Uuid, nullable=True),
    # 调用方自带的坐标标签，只做包含匹配；只有参考视频试生成的键按值查。
    Column("metadata", JSONB, nullable=True),
    # 需求单同样不建外键：它是归属标签，删单不抹生成记录。
    Column("task_id", Uuid, nullable=True),
    # 镜头组编号，只有视频有：出片由调用方给，编辑段与合成抄原作的。
    Column("shot_index", Integer, nullable=True),
    # 原作与来源都建外键：它们不是标签，必须指一条真实存在的记录；生成记录从不硬删。
    Column(
        "root_job_id",
        Uuid,
        ForeignKey(f"{DB_SCHEMA}.generation_jobs.id", name="fk_generation_jobs_root_job"),
        nullable=True,
    ),
    Column(
        "source_job_id",
        Uuid,
        ForeignKey(f"{DB_SCHEMA}.generation_jobs.id", name="fk_generation_jobs_source_job"),
        nullable=True,
    ),
    Column("kind", Text, nullable=False),
    Column("operation", Text, nullable=False),
    Column("provider", Text, nullable=True),
    # none_as_null：None 落成 SQL NULL，不是 JSON null，读回来才是「没有」。
    Column("request", JSONB(none_as_null=True), nullable=True),
    Column("status", Text, nullable=False),
    Column("provider_task_id", Text, nullable=True),
    Column("provider_status", Text, nullable=True),
    Column("output", JSONB(none_as_null=True), nullable=True),
    Column("error_code", Text, nullable=True),
    Column("error_message", Text, nullable=True),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("submitted_at", DateTime(timezone=True), nullable=True),
    Column("finished_at", DateTime(timezone=True), nullable=True),
    Index("ix_generation_jobs_owner_created", "owner_user_id", "created_at", "id"),
    Index(
        "ix_generation_jobs_conversation_kind_created",
        "conversation_id",
        "kind",
        "created_at",
        "id",
        postgresql_where=text("conversation_id IS NOT NULL"),
    ),
    Index(
        "ix_generation_jobs_task_created",
        "task_id",
        "created_at",
        "id",
        postgresql_where=text("task_id IS NOT NULL"),
    ),
    # 只索引有原作、有来源的行：按原作查链、按来源找兄弟、外键校验都走它们，出片占大多数、不必进来。
    Index(
        "ix_generation_jobs_root_job",
        "root_job_id",
        postgresql_where=text("root_job_id IS NOT NULL"),
    ),
    Index(
        "ix_generation_jobs_source_job",
        "source_job_id",
        postgresql_where=text("source_job_id IS NOT NULL"),
    ),
    # 按（对话，镜号）找一镜的视频；与迁移 0018 同名同式。
    Index(
        "ix_generation_jobs_conversation_shot",
        "conversation_id",
        "shot_index",
        postgresql_where=text("kind = 'video'::text AND shot_index IS NOT NULL"),
    ),
    Index(
        "ix_generation_jobs_masters",
        "conversation_id",
        "finished_at",
        "id",
        postgresql_where=text(
            "kind = 'video'::text AND status = 'completed'::text"
            " AND (output ->> 'url'::text) IS NOT NULL"
            " AND (operation = 'generate'::text AND source_job_id IS NULL"
            " OR operation = 'compose'::text)"
        ),
    ),
    Index(
        "ix_generation_jobs_whole_films",
        "conversation_id",
        "finished_at",
        "id",
        postgresql_where=text(
            "kind = 'whole_film'::text AND status = 'completed'::text"
            " AND (output ->> 'url'::text) IS NOT NULL"
        ),
    ),
    Index(
        "ix_generation_jobs_unfinished",
        "conversation_id",
        "kind",
        postgresql_where=text(
            "status = ANY (ARRAY['pending'::text, 'submitting'::text, 'submitted'::text])"
        ),
    ),
    Index(
        "ix_generation_jobs_output_url",
        text("(output ->> 'url'::text)"),
        postgresql_using="hash",
        postgresql_where=text("(output ->> 'url'::text) IS NOT NULL"),
    ),
    Index(
        "ix_generation_jobs_video_upload_md5",
        text("(output ->> 'content_md5'::text)"),
        "created_at",
        "id",
        postgresql_where=text("kind = 'video'::text AND operation = 'upload'::text"),
    ),
    Index(
        "ix_generation_jobs_reference_trial",
        text("(metadata ->> 'referenceId'::text)"),
        "created_at",
        postgresql_where=text("(metadata ->> 'referenceId'::text) IS NOT NULL"),
    ),
)

_JOBS = generation_jobs_table.c

type _Columns = ReadOnlyColumnCollection[str, KeyedColumnElement[Any]]


def _json_text(column: KeyedColumnElement[Any], key: str) -> ColumnElement[str]:
    # 键与常量写成 SQL 字面量而不是绑定参数：通用执行计划里参数证明不了表达式索引与部分索引的条件。
    return column.op("->>", return_type=Text())(literal_column(f"'{key}'"))


def _sql_literal(value: str) -> ColumnElement[str]:
    return literal_column(f"'{value}'", Text())


_OUTPUT_URL: Final = _json_text(_JOBS.output, "url")

_MASTER: Final = text(
    "kind = 'video' AND status = 'completed' AND (output ->> 'url') IS NOT NULL"
    " AND ((operation = 'generate' AND source_job_id IS NULL) OR operation = 'compose')"
)

_UNFINISHED: Final = text("status IN ('pending', 'submitting', 'submitted')")


class SqlGenerationRepository:
    """``GenerationRepository`` 的 Postgres 实现。"""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def create(self, job: GenerationJob) -> GenerationJob:
        async with self._engine.begin() as conn:
            row = (
                (
                    await conn.execute(
                        generation_jobs_table.insert()
                        .values(
                            id=job.id,
                            owner_user_id=job.owner_user_id,
                            api_key_id=job.api_key_id,
                            conversation_id=job.conversation_id,
                            metadata=job.metadata,
                            task_id=job.task_id,
                            shot_index=job.shot_index,
                            root_job_id=job.root_job_id,
                            source_job_id=job.source_job_id,
                            kind=job.kind,
                            operation=job.operation,
                            provider=job.provider,
                            request=request_to_payload(job.request),
                            status=job.status,
                            provider_task_id=None,
                            provider_status=None,
                            output=_output_payload(job.output),
                            error_code=None,
                            error_message=None,
                            created_at=func.now(),
                            submitted_at=None,
                            finished_at=None,
                        )
                        .returning(generation_jobs_table)
                    )
                )
                .mappings()
                .one()
            )
        return _job_from_row(row)

    async def create_settled(self, jobs: Sequence[GenerationJob]) -> tuple[GenerationJob, ...]:
        if not jobs:
            return ()
        stmt = (
            pg_insert(generation_jobs_table)
            .values([_settled_values(job) for job in jobs])
            .on_conflict_do_nothing(index_elements=[_JOBS.id])
            .returning(generation_jobs_table)
        )
        async with self._engine.begin() as conn:
            rows = (await conn.execute(stmt)).mappings().all()
        order = {job.id: position for position, job in enumerate(jobs)}
        return tuple(sorted((_job_from_row(row) for row in rows), key=lambda job: order[job.id]))

    async def find_by_output(
        self,
        output_url: str,
        *,
        kind: GenerationKind,
        owner: uuid.UUID | None,
        conversation_id: uuid.UUID | None,
        inherited: Inheritance = (),
        operation: GenerationOperation | None = None,
    ) -> GenerationJob | None:
        # 先按地址取出候选再筛：其余条件留在外面，计划才稳定地走地址那条 hash 索引。
        hits = (
            select(generation_jobs_table)
            .where(_json_text(_JOBS.output, "url") == output_url)
            .cte("hits")
            .prefix_with("MATERIALIZED")
        )
        cols: _Columns = hits.c
        own = owner_conditions(cols.owner_user_id, owner)
        own.append(
            cols.conversation_id.is_(None)
            if conversation_id is None
            else cols.conversation_id == conversation_id
        )
        stmt = select(hits).where(
            cols.kind == kind, cols.status == STATUS_COMPLETED, _visible(cols, own, inherited)
        )
        if operation is not None:
            stmt = stmt.where(cols.operation == operation)
        stmt = stmt.order_by(cols.created_at, cols.id).limit(1)
        async with self._engine.connect() as conn:
            row = (await conn.execute(stmt)).mappings().one_or_none()
        return None if row is None else _job_from_row(row)

    async def find_video_upload_by_md5(self, content_md5: str) -> GenerationJob | None:
        stmt = (
            select(generation_jobs_table)
            .where(
                _json_text(_JOBS.output, "content_md5") == content_md5,
                _JOBS.kind == _sql_literal(KIND_VIDEO),
                _JOBS.operation == _sql_literal(OPERATION_UPLOAD),
            )
            .order_by(_JOBS.created_at, _JOBS.id)
            .limit(1)
        )
        async with self._engine.connect() as conn:
            row = (await conn.execute(stmt)).mappings().one_or_none()
        return None if row is None else _job_from_row(row)

    async def latest_reference_trial(
        self, reference_id: uuid.UUID, *, owner: uuid.UUID | None
    ) -> GenerationJob | None:
        stmt = (
            select(generation_jobs_table)
            .where(
                _json_text(_JOBS.metadata, REFERENCE_TRIAL_KEY) == str(reference_id),
                *owner_conditions(_JOBS.owner_user_id, owner),
                _JOBS.kind == KIND_VIDEO,
                _JOBS.operation == OPERATION_GENERATE,
            )
            .order_by(_JOBS.created_at.desc(), _JOBS.id.desc())
            .limit(1)
        )
        async with self._engine.connect() as conn:
            row = (await conn.execute(stmt)).mappings().one_or_none()
        return None if row is None else _job_from_row(row)

    async def output_urls(self, ids: Collection[uuid.UUID]) -> Mapping[uuid.UUID, str]:
        if not ids:
            return {}
        stmt = select(_JOBS.id, _OUTPUT_URL).where(
            _JOBS.id.in_(list(ids)), _OUTPUT_URL.is_not(None)
        )
        async with self._engine.connect() as conn:
            rows = (await conn.execute(stmt)).all()
        return {job_id: url for job_id, url in rows}

    async def get(
        self, job_id: uuid.UUID, *, owner: uuid.UUID | None, inherited: Inheritance = ()
    ) -> GenerationJob:
        stmt = select(generation_jobs_table).where(
            _JOBS.id == job_id,
            _visible(_JOBS, owner_conditions(_JOBS.owner_user_id, owner), inherited),
        )
        async with self._engine.connect() as conn:
            row = (await conn.execute(stmt)).mappings().one_or_none()
        if row is None:
            raise NotFound(f"没有这次生成: {job_id}")
        return _job_from_row(row)

    async def list_for_owner(
        self,
        *,
        owner: uuid.UUID | None,
        limit: int,
        conversation_id: uuid.UUID | None = None,
        kind: GenerationKind | None = None,
        operation: GenerationOperation | None = None,
        metadata: Mapping[str, Any] | None = None,
        task_id: uuid.UUID | None = None,
        shot_index: int | None = None,
        root_job_id: uuid.UUID | None = None,
        source_job_id: uuid.UUID | None = None,
        before: uuid.UUID | None = None,
        inherited: Inheritance = (),
    ) -> tuple[GenerationJob, ...]:
        own = owner_conditions(_JOBS.owner_user_id, owner)
        if conversation_id is not None:
            own.append(_JOBS.conversation_id == conversation_id)
        stmt = select(generation_jobs_table).where(_visible(_JOBS, own, inherited))
        if task_id is not None:
            stmt = stmt.where(_JOBS.task_id == task_id)
        if shot_index is not None:
            stmt = stmt.where(_JOBS.shot_index == shot_index)
        if root_job_id is not None:
            stmt = stmt.where(_JOBS.root_job_id == root_job_id)
        if source_job_id is not None:
            stmt = stmt.where(_JOBS.source_job_id == source_job_id)
        if kind is not None:
            stmt = stmt.where(_JOBS.kind == kind)
        if operation is not None:
            stmt = stmt.where(_JOBS.operation == operation)
        if metadata is not None:
            stmt = stmt.where(_JOBS.metadata.contains(dict(metadata)))
        if before is not None:
            # 锚点与本页同一个可见范围：按对话翻页时，上一页最后一条可能是继承来的。
            anchor = await self.get(before, owner=owner, inherited=inherited)
            stmt = stmt.where(tuple_(_JOBS.created_at, _JOBS.id) < (anchor.created_at, anchor.id))
        stmt = stmt.order_by(_JOBS.created_at.desc(), _JOBS.id.desc())
        async with self._engine.connect() as conn:
            rows = (await conn.execute(stmt.limit(limit))).mappings().all()
        return tuple(_job_from_row(row) for row in rows)

    async def in_flight_by_conversation(
        self, conversation_ids: Sequence[uuid.UUID], *, kind: GenerationKind
    ) -> Mapping[uuid.UUID, InFlightPhase]:
        if not conversation_ids:
            return {}
        # 一段对话下只要有一条已交给上游就算 running；全部还在本系统排队才是 queued。
        running = func.bool_or(_JOBS.status != STATUS_PENDING)
        stmt = (
            select(_JOBS.conversation_id, running)
            .where(
                _JOBS.conversation_id.in_(list(conversation_ids)),
                _JOBS.kind == kind,
                _UNFINISHED,
            )
            .group_by(_JOBS.conversation_id)
        )
        async with self._engine.connect() as conn:
            rows = (await conn.execute(stmt)).all()
        return {
            conversation_id: "running" if is_running else "queued"
            for conversation_id, is_running in rows
        }

    async def latest_master_by_conversation(
        self, conversation_ids: Sequence[uuid.UUID]
    ) -> Mapping[uuid.UUID, str]:
        if not conversation_ids:
            return {}
        stmt = (
            select(_JOBS.conversation_id, _OUTPUT_URL)
            .distinct(_JOBS.conversation_id)
            .where(_JOBS.conversation_id.in_(list(conversation_ids)), _MASTER)
            .order_by(_JOBS.conversation_id, _JOBS.finished_at.desc(), _JOBS.id.desc())
        )
        async with self._engine.connect() as conn:
            rows = (await conn.execute(stmt)).all()
        return {conversation_id: url for conversation_id, url in rows}

    async def enhancements_of(self, source_job_id: uuid.UUID) -> tuple[GenerationJob, ...]:
        # 走 source_job_id 的部分索引；一条来源下的超分只有几档、几次重做，不分页。
        stmt = (
            select(generation_jobs_table)
            .where(_JOBS.source_job_id == source_job_id, _JOBS.operation == OPERATION_ENHANCE)
            .order_by(_JOBS.created_at.desc(), _JOBS.id.desc())
        )
        async with self._engine.connect() as conn:
            rows = (await conn.execute(stmt)).mappings().all()
        return tuple(_job_from_row(row) for row in rows)

    async def mark_submitting(self, job_id: uuid.UUID) -> GenerationJob | None:
        return await self._update_guarded(job_id, STATUS_PENDING, status=STATUS_SUBMITTING)

    async def mark_submitted(
        self,
        job_id: uuid.UUID,
        *,
        provider_task_id: str,
        provider_status: str,
    ) -> GenerationJob:
        return await self._update(
            job_id,
            status=STATUS_SUBMITTED,
            provider_task_id=provider_task_id,
            provider_status=provider_status,
            submitted_at=func.now(),
        )

    async def mark_completed(
        self,
        job_id: uuid.UUID,
        *,
        output: GenerationOutput,
        provider_status: str,
        provider_task_id: str | None = None,
        only_if_status: GenerationStatus | None = None,
    ) -> GenerationJob | None:
        values: dict[str, Any] = {
            "status": STATUS_COMPLETED,
            "output": _output_payload(output),
            "provider_status": provider_status,
            # 同步生成在完成时补写 submitted_at；异步生成保留提交时间。
            "submitted_at": func.coalesce(_JOBS.submitted_at, func.now()),
            "finished_at": func.now(),
        }
        if provider_task_id is not None:
            values["provider_task_id"] = provider_task_id
        return await self._update_guarded(job_id, only_if_status, **values)

    async def mark_transcribed(
        self,
        job_id: uuid.UUID,
        *,
        sentences: tuple[SubtitleSentence, ...],
        provider_status: str,
        provider_task_id: str,
        only_if_status: GenerationStatus | None = None,
    ) -> GenerationJob | None:
        return await self._update_guarded(
            job_id,
            only_if_status,
            status=STATUS_COMPLETED,
            output=_output_payload(GenerationOutput(sentences=sentences)),
            provider_status=provider_status,
            provider_task_id=provider_task_id,
            submitted_at=func.coalesce(_JOBS.submitted_at, func.now()),
            finished_at=func.now(),
        )

    async def mark_failed(
        self,
        job_id: uuid.UUID,
        *,
        error_code: str,
        error_message: str,
        provider_status: str | None = None,
        only_if_status: GenerationStatus | None = None,
    ) -> GenerationJob | None:
        values: dict[str, Any] = {
            "status": STATUS_FAILED,
            "error_code": error_code,
            "error_message": error_message,
            "finished_at": func.now(),
        }
        if provider_status is not None:
            values["provider_status"] = provider_status
        return await self._update_guarded(job_id, only_if_status, **values)

    async def record_progress(
        self,
        job_id: uuid.UUID,
        *,
        provider_status: str,
        only_if_status: GenerationStatus | None = None,
        skip_unchanged: bool = False,
    ) -> GenerationJob | None:
        conditions: list[ColumnElement[bool]] = []
        if only_if_status is not None:
            conditions.append(_JOBS.status == only_if_status)
        if skip_unchanged:
            conditions.append(_JOBS.provider_status.is_distinct_from(provider_status))
        if not conditions:
            return await self._update(job_id, provider_status=provider_status)
        return await self._update_if(job_id, conditions, provider_status=provider_status)

    async def _update_guarded(
        self, job_id: uuid.UUID, only_if_status: GenerationStatus | None, **values: Any
    ) -> GenerationJob | None:
        if only_if_status is None:
            return await self._update(job_id, **values)
        return await self._update_if(job_id, [_JOBS.status == only_if_status], **values)

    async def _update_if(
        self, job_id: uuid.UUID, conditions: Sequence[ColumnElement[bool]], **values: Any
    ) -> GenerationJob | None:
        """条件写进 WHERE 原子校验，避免并发覆盖；不满足时不更新，返回 None。"""

        async with self._engine.begin() as conn:
            row = (
                (
                    await conn.execute(
                        generation_jobs_table.update()
                        .where(_JOBS.id == job_id, *conditions)
                        .values(**values)
                        .returning(generation_jobs_table)
                    )
                )
                .mappings()
                .one_or_none()
            )
        return None if row is None else _job_from_row(row)

    async def _update(self, job_id: uuid.UUID, **values: Any) -> GenerationJob:
        async with self._engine.begin() as conn:
            row = (
                (
                    await conn.execute(
                        generation_jobs_table.update()
                        .where(_JOBS.id == job_id)
                        .values(**values)
                        .returning(generation_jobs_table)
                    )
                )
                .mappings()
                .one_or_none()
            )
        if row is None:
            raise NotFound(f"没有这次生成: {job_id}")
        return _job_from_row(row)


def _visible(
    cols: _Columns, own: Sequence[ColumnElement[bool]], inherited: Inheritance
) -> ColumnElement[bool]:
    """按属主收敛的自己那一份，并上经这组边界对继承来的；没有继承就只剩前者。"""

    mine = and_(true(), *own)
    if not inherited:
        return mine
    return or_(mine, _inherited(cols, inherited))


def _inherited(cols: _Columns, inherited: Inheritance) -> ColumnElement[bool]:
    """经分叉继承的记录：某个祖先名下已完成、完成时刻不晚于它的边界。

    规则与 ``models.inherited_through`` 相同。边界对逐条展开成 OR，而不是去 join 一段 VALUES：
    挂在 OR 下的相关子查询用不上按对话的索引，展开后每一支都能走 ``conversation_id`` 索引。"""

    return and_(
        cols.status == STATUS_COMPLETED,
        or_(
            *(
                and_(cols.conversation_id == ancestor, cols.finished_at <= boundary)
                for ancestor, boundary in inherited
            )
        ),
    )


def _settled_values(job: GenerationJob) -> dict[str, Any]:
    """一条创建即完成的行：产出照给，建立与完成都是数据库时钟的同一刻，没有提交与上游状态。"""

    return {
        "id": job.id,
        "owner_user_id": job.owner_user_id,
        "api_key_id": job.api_key_id,
        "conversation_id": job.conversation_id,
        "metadata": job.metadata,
        "task_id": job.task_id,
        "shot_index": job.shot_index,
        "root_job_id": job.root_job_id,
        "source_job_id": job.source_job_id,
        "kind": job.kind,
        "operation": job.operation,
        "provider": job.provider,
        "request": request_to_payload(job.request),
        "status": job.status,
        "provider_task_id": None,
        "provider_status": None,
        "output": _output_payload(job.output),
        "error_code": None,
        "error_message": None,
        "created_at": func.now(),
        "submitted_at": None,
        "finished_at": func.now(),
    }


def _output_payload(output: GenerationOutput) -> dict[str, Any] | None:
    # 只去顶层的空值：exclude_none 会递归删掉字幕句子里的 speaker: None，读回就不合法。
    payload = {
        key: value for key, value in output.model_dump(mode="json").items() if value is not None
    }
    return payload or None


def _output_of(payload: dict[str, Any] | None) -> GenerationOutput:
    if payload is None:
        return GenerationOutput()
    try:
        return GenerationOutput.model_validate(payload)
    except ValueError as exc:
        raise ValidationFailed(f"生成产出的形状不合法: {exc}") from exc


def _job_from_row(row: RowMapping) -> GenerationJob:
    kind: GenerationKind = row["kind"]
    operation: GenerationOperation = row["operation"]
    status: GenerationStatus = row["status"]
    return GenerationJob(
        id=row["id"],
        owner_user_id=row["owner_user_id"],
        api_key_id=row["api_key_id"],
        conversation_id=row["conversation_id"],
        metadata=row["metadata"],
        task_id=row["task_id"],
        shot_index=row["shot_index"],
        root_job_id=row["root_job_id"],
        source_job_id=row["source_job_id"],
        kind=kind,
        operation=operation,
        provider=row["provider"],
        request=request_from_payload(
            kind, operation, row["request"], has_source=row["source_job_id"] is not None
        ),
        status=status,
        provider_task_id=row["provider_task_id"],
        provider_status=row["provider_status"],
        output=_output_of(row["output"]),
        error_code=row["error_code"],
        error_message=row["error_message"],
        created_at=row["created_at"],
        submitted_at=row["submitted_at"],
        finished_at=row["finished_at"],
    )


__all__ = [
    "DB_SCHEMA",
    "SqlGenerationRepository",
    "generation_jobs_table",
    "metadata_obj",
]
