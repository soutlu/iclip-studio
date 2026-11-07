from __future__ import annotations

import inspect
from abc import abstractmethod
from collections.abc import Callable, Mapping
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, ClassVar, Self, cast, get_type_hints

from pydantic import BaseModel, ConfigDict, create_model
from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.tools import AgentDepsT

from cue.file_store.store import FileStore
from cue.model_connections import ModelConnectionLookup
from cue.transcript.display import DisplayFn, ToolDisplayEntry


class CapPlugin(AbstractCapability[AgentDepsT]):
    label: ClassVar[str]

    summary: ClassVar[str]

    _services: ClassVar[Mapping[str, Any] | None] = None

    @classmethod
    @abstractmethod
    def get_serialization_name(cls) -> str: ...

    @classmethod
    @abstractmethod
    def display_table(cls) -> Mapping[str, DisplayFn | ToolDisplayEntry]: ...

    @classmethod
    def _bound(cls, **services: Any) -> type[Self]:
        namespace: dict[str, Any] = {
            "__module__": cls.__module__,
            "__qualname__": cls.__qualname__,
            "_services": MappingProxyType(dict(services)),
            "from_spec": inspect.getattr_static(cls, "from_spec"),
        }
        return cast("type[Self]", dataclass(type(cls.__name__, (cls,), namespace)))

    @classmethod
    def required_plugins(cls) -> tuple[str, ...]:
        return required_plugins(cls.from_spec())

    @classmethod
    def parameters_model(cls) -> type[BaseModel]:
        hints = get_type_hints(cls.from_spec)
        fields: dict[str, Any] = {}
        for parameter in inspect.signature(cls.from_spec).parameters.values():
            if parameter.kind in (parameter.VAR_POSITIONAL, parameter.VAR_KEYWORD):
                continue
            default = ... if parameter.default is parameter.empty else parameter.default
            fields[parameter.name] = (hints.get(parameter.name, Any), default)
        return create_model(
            cls.get_serialization_name(),
            __config__=ConfigDict(extra="forbid"),
            **fields,
        )

    @classmethod
    def _bound_services(cls) -> Mapping[str, Any]:
        if cls._services is None:
            raise RuntimeError(
                f"插件 {cls.get_serialization_name()} 还没绑服务：组合根要用 bind 返回的类"
            )
        return cls._services


PluginRegistry = Mapping[str, type[CapPlugin[Any]]]


@dataclass(frozen=True, slots=True)
class PluginHost:
    files: FileStore

    model_connection: ModelConnectionLookup


PluginBinder = Callable[[PluginHost], PluginRegistry]

PluginFactory = Callable[[Mapping[str, Any]], AbstractAsyncContextManager[PluginBinder]]


def required_plugins(capability: AbstractCapability[Any]) -> tuple[str, ...]:
    ordering = capability.get_ordering()
    if ordering is None:
        return ()
    names: list[str] = []
    for required in ordering.requires:
        name = required.get_serialization_name()
        if name is None:
            raise RuntimeError(f"{type(capability).__name__} 要求的 {required.__name__} 不是插件")
        names.append(name)
    return tuple(names)


__all__ = [
    "CapPlugin",
    "PluginBinder",
    "PluginFactory",
    "PluginHost",
    "PluginRegistry",
    "required_plugins",
]
