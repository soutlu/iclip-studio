"""模型供应商的四张表与它们的 Postgres 仓储。

时间统一用数据库时钟。类型、来源与字段形状的取值只在 Python 里检查，表上不加 CHECK；
``model_providers.default_credential_id`` 不加外键，由服务在改它的事务里核对它属于本供应商。"""

from __future__ import annotations

import uuid
from collections import defaultdict
from collections.abc import AsyncGenerator, Callable, Mapping, Sequence
from contextlib import asynccontextmanager
from typing import Any, Final, cast

from agent_runtime.errors import NotFound, ValidationFailed
from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    MetaData,
    Table,
    Text,
    UniqueConstraint,
    Uuid,
    delete,
    func,
    select,
    text,
    update,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.engine import RowMapping
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from iclip.domains.model_providers.models import (
    CredentialRecord,
    DefaultModel,
    ModelProperties,
    ModelSetting,
    ModelType,
    ProviderRecord,
    ProviderState,
)

DB_SCHEMA: Final = "iclip"

metadata_obj = MetaData(schema=DB_SCHEMA)

model_providers_table = Table(
    "model_providers",
    metadata_obj,
    Column("id", Uuid, primary_key=True),
    Column("name", Text, nullable=False),
    Column("provider", Text, nullable=False),
    Column("label", Text, nullable=False),
    Column("default_credential_id", Uuid, nullable=True),
    Column("enabled", Boolean, nullable=False, server_default=text("true")),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=text("now()")),
    Column("updated_at", DateTime(timezone=True), nullable=False, server_default=text("now()")),
    UniqueConstraint("name", name="uq_model_providers_name"),
)

provider_credentials_table = Table(
    "provider_credentials",
    metadata_obj,
    Column("id", Uuid, primary_key=True),
    Column(
        "provider_id",
        Uuid,
        ForeignKey(f"{DB_SCHEMA}.model_providers.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("name", Text, nullable=False),
    Column("fields", JSONB, nullable=False),
    Column("created_by", Uuid, ForeignKey(f"{DB_SCHEMA}.users.id"), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=text("now()")),
    Column("updated_at", DateTime(timezone=True), nullable=False, server_default=text("now()")),
    UniqueConstraint("provider_id", "name", name="uq_provider_credentials_provider_name"),
)

provider_models_table = Table(
    "provider_models",
    metadata_obj,
    Column("id", Uuid, primary_key=True),
    Column(
        "provider_id",
        Uuid,
        ForeignKey(f"{DB_SCHEMA}.model_providers.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("name", Text, nullable=False),
    Column("type", Text, nullable=False),
    Column("source", Text, nullable=False),
    Column("properties", JSONB, nullable=True),
    Column("enabled", Boolean, nullable=False),
    UniqueConstraint("provider_id", "name", "type", name="uq_provider_models_provider_name_type"),
)

default_models_table = Table(
    "default_models",
    metadata_obj,
    Column("type", Text, primary_key=True),
    Column(
        "provider_id",
        Uuid,
        ForeignKey(f"{DB_SCHEMA}.model_providers.id"),
        nullable=False,
    ),
    Column("model_name", Text, nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False, server_default=text("now()")),
)

_PROVIDER_NAME_CONSTRAINT: Final = "uq_model_providers_name"
_CREDENTIAL_NAME_CONSTRAINT: Final = "uq_provider_credentials_provider_name"

_providers = model_providers_table.c
_credentials = provider_credentials_table.c
_models = provider_models_table.c
_defaults = default_models_table.c


def _violated_constraint(error: IntegrityError) -> str:
    """违反的约束名；asyncpg 把它挂在被包起来的原异常上。"""

    cause = getattr(error.orig, "__cause__", None)
    return getattr(cause, "constraint_name", None) or ""


def _provider(row: RowMapping) -> ProviderRecord:
    return ProviderRecord(
        id=row["id"],
        name=row["name"],
        provider=row["provider"],
        label=row["label"],
        default_credential_id=row["default_credential_id"],
        enabled=row["enabled"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _credential(row: RowMapping) -> CredentialRecord:
    return CredentialRecord(
        id=row["id"],
        provider_id=row["provider_id"],
        name=row["name"],
        fields=dict(cast("Mapping[str, str]", row["fields"])),
        created_by=row["created_by"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _properties_json(properties: ModelProperties | None) -> dict[str, Any] | None:
    if properties is None:
        return None
    return {
        "api": properties.api,
        "context_size": properties.context_size,
        "thinking": list(properties.thinking),
    }


def _setting(row: RowMapping) -> ModelSetting:
    raw = cast("Mapping[str, Any] | None", row["properties"])
    return ModelSetting(
        name=row["name"],
        type=row["type"],
        source=row["source"],
        properties=None
        if raw is None
        else ModelProperties(
            api=raw["api"], context_size=raw["context_size"], thinking=tuple(raw["thinking"])
        ),
        enabled=row["enabled"],
    )


def _default(row: RowMapping) -> DefaultModel:
    return DefaultModel(
        type=row["type"],
        provider_id=row["provider_id"],
        provider_name=row["provider_name"],
        model_name=row["model_name"],
        updated_at=row["updated_at"],
    )


_DEFAULTS: Final = (
    select(default_models_table, _providers.name.label("provider_name"))
    .join(model_providers_table, _providers.id == _defaults.provider_id)
    .order_by(_defaults.type)
)


_CREDENTIAL_ORDER: Final = (_credentials.created_at.desc(), _credentials.id.desc())
"""密钥新的在前；自己加的模型按类型、名字排。"""
_MODEL_ORDER: Final = (_models.type, _models.name)


async def _read_states(
    conn: AsyncConnection, providers: Sequence[RowMapping]
) -> tuple[ProviderState, ...]:
    ids = [row["id"] for row in providers]
    if not ids:
        return ()
    credentials: dict[uuid.UUID, list[CredentialRecord]] = defaultdict(list)
    for row in (
        await conn.execute(
            select(provider_credentials_table)
            .where(_credentials.provider_id.in_(ids))
            .order_by(*_CREDENTIAL_ORDER)
        )
    ).mappings():
        credentials[row["provider_id"]].append(_credential(row))
    settings: dict[uuid.UUID, list[ModelSetting]] = defaultdict(list)
    for row in (
        await conn.execute(
            select(provider_models_table)
            .where(_models.provider_id.in_(ids))
            .order_by(*_MODEL_ORDER)
        )
    ).mappings():
        settings[row["provider_id"]].append(_setting(row))
    return tuple(
        ProviderState(
            provider=_provider(row),
            credentials=tuple(credentials[row["id"]]),
            settings=tuple(settings[row["id"]]),
        )
        for row in providers
    )


class _SqlProviderEditor:
    """``ProviderEditor`` 的 Postgres 实现，用一条已锁住供应商那一行的事务连接。"""

    def __init__(
        self, conn: AsyncConnection, state: ProviderState, defaults: tuple[DefaultModel, ...]
    ) -> None:
        self._conn = conn
        self._state = state
        self._defaults = defaults

    @property
    def state(self) -> ProviderState:
        return self._state

    @property
    def defaults(self) -> tuple[DefaultModel, ...]:
        return self._defaults

    @property
    def _provider_id(self) -> uuid.UUID:
        return self._state.provider.id

    async def update_provider(
        self, *, label: str, enabled: bool, default_credential_id: uuid.UUID | None
    ) -> None:
        await self._conn.execute(
            update(model_providers_table)
            .where(_providers.id == self._provider_id)
            .values(
                label=label,
                enabled=enabled,
                default_credential_id=default_credential_id,
                updated_at=func.now(),
            )
        )

    async def insert_credential(
        self,
        credential_id: uuid.UUID,
        *,
        name: str,
        fields: Mapping[str, str],
        created_by: uuid.UUID,
    ) -> None:
        await self._conn.execute(
            provider_credentials_table.insert().values(
                id=credential_id,
                provider_id=self._provider_id,
                name=name,
                fields=dict(fields),
                created_by=created_by,
            )
        )
        await self._conn.execute(
            update(model_providers_table)
            .where(
                _providers.id == self._provider_id,
                _providers.default_credential_id.is_(None),
            )
            .values(default_credential_id=credential_id, updated_at=func.now())
        )

    async def update_credential(
        self, credential_id: uuid.UUID, *, name: str, fields: Mapping[str, str]
    ) -> None:
        await self._conn.execute(
            update(provider_credentials_table)
            .where(
                _credentials.id == credential_id,
                _credentials.provider_id == self._provider_id,
            )
            .values(name=name, fields=dict(fields), updated_at=func.now())
        )

    async def delete_credential(self, credential_id: uuid.UUID) -> None:
        await self._conn.execute(
            delete(provider_credentials_table).where(
                _credentials.id == credential_id,
                _credentials.provider_id == self._provider_id,
            )
        )

    async def put_model(self, setting: ModelSetting) -> None:
        values = {
            "source": setting.source,
            "properties": _properties_json(setting.properties),
            "enabled": setting.enabled,
        }
        await self._conn.execute(
            pg_insert(provider_models_table)
            .values(
                id=uuid.uuid4(),
                provider_id=self._provider_id,
                name=setting.name,
                type=setting.type,
                **values,
            )
            .on_conflict_do_update(constraint="uq_provider_models_provider_name_type", set_=values)
        )

    async def delete_model(self, name: str, model_type: ModelType) -> None:
        await self._conn.execute(
            delete(provider_models_table).where(
                _models.provider_id == self._provider_id,
                _models.name == name,
                _models.type == model_type,
            )
        )

    async def set_default_model(self, model_type: ModelType, model_name: str) -> None:
        values = {
            "provider_id": self._provider_id,
            "model_name": model_name,
            "updated_at": func.now(),
        }
        await self._conn.execute(
            pg_insert(default_models_table)
            .values(type=model_type, **values)
            .on_conflict_do_update(index_elements=[_defaults.type], set_=values)
        )


class SqlModelProviderStore:
    """``ModelProviderStore`` 的 Postgres 实现。"""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def states(self) -> tuple[ProviderState, ...]:
        async with self._engine.connect() as conn:
            providers = (
                (
                    await conn.execute(
                        select(model_providers_table).order_by(
                            _providers.created_at.desc(), _providers.id.desc()
                        )
                    )
                )
                .mappings()
                .all()
            )
            return await _read_states(conn, providers)

    async def state(self, provider_id: uuid.UUID) -> ProviderState | None:
        async with self._engine.connect() as conn:
            providers = (
                (
                    await conn.execute(
                        select(model_providers_table).where(_providers.id == provider_id)
                    )
                )
                .mappings()
                .all()
            )
            found = await _read_states(conn, providers)
        return found[0] if found else None

    async def insert_provider(
        self, provider_id: uuid.UUID, *, name: str, provider: str, label: str
    ) -> None:
        try:
            async with self._engine.begin() as conn:
                await conn.execute(
                    model_providers_table.insert().values(
                        id=provider_id, name=name, provider=provider, label=label
                    )
                )
        except IntegrityError as exc:
            if _violated_constraint(exc) == _PROVIDER_NAME_CONSTRAINT:
                raise ValidationFailed(f"已经有引用名为 {name} 的供应商") from exc
            raise

    @asynccontextmanager
    async def edit(self, provider_id: uuid.UUID) -> AsyncGenerator[_SqlProviderEditor]:
        try:
            async with self._engine.begin() as conn:
                providers = (
                    (
                        await conn.execute(
                            select(model_providers_table)
                            .where(_providers.id == provider_id)
                            .with_for_update()
                        )
                    )
                    .mappings()
                    .all()
                )
                if not providers:
                    raise NotFound("供应商不存在")
                (state,) = await _read_states(conn, providers)
                defaults = tuple(
                    _default(row)
                    for row in (
                        await conn.execute(_DEFAULTS.where(_defaults.provider_id == provider_id))
                    ).mappings()
                )
                yield _SqlProviderEditor(conn, state, defaults)
        except IntegrityError as exc:
            if _violated_constraint(exc) == _CREDENTIAL_NAME_CONSTRAINT:
                raise ValidationFailed("这个供应商下已有同名密钥") from exc
            raise

    async def default_models(self) -> tuple[DefaultModel, ...]:
        async with self._engine.connect() as conn:
            rows = (await conn.execute(_DEFAULTS)).mappings()
            return tuple(_default(row) for row in rows)

    async def rewrite_credentials(
        self, rewrite: Callable[[str, CredentialRecord], Mapping[str, str]]
    ) -> int:
        async with self._engine.begin() as conn:
            rows = (
                (
                    await conn.execute(
                        select(provider_credentials_table, _providers.provider.label("declaration"))
                        .join(model_providers_table, _providers.id == _credentials.provider_id)
                        .order_by(_credentials.id)
                        .with_for_update(of=provider_credentials_table)
                    )
                )
                .mappings()
                .all()
            )
            for row in rows:
                await conn.execute(
                    update(provider_credentials_table)
                    .where(_credentials.id == row["id"])
                    .values(fields=dict(rewrite(row["declaration"], _credential(row))))
                )
            return len(rows)


__all__ = [
    "DB_SCHEMA",
    "SqlModelProviderStore",
    "default_models_table",
    "metadata_obj",
    "model_providers_table",
    "provider_credentials_table",
    "provider_models_table",
]
