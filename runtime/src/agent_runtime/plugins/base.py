"""插件约定：我们自己定义、写在代码里的工具集，每个插件是一个 pydantic-ai 原生 capability 类。

插件类按 pydantic-ai 的 spec 机制声明自己：

- ``get_serialization_name()`` 给稳定的插件名，agent 配置按它引用；
- ``from_spec(**参数)`` 用可序列化的参数造实例，参数的类型与默认值就写在它的签名上；
- ``get_ordering()`` 用 ``CapabilityOrdering(requires=...)`` 写要求同一 agent 一起挂的插件类。

运行用的服务（FileSpace、台账、各适配器等）不进 spec：组合根启动时调插件类的 ``bind``，得到一个把服务放在
类属性上的子类，插件名不变；``from_spec`` 从类上取服务。登记表收的就是这些绑好服务的类。

运行时服务从配置接插件包：插件包给一个 ``PluginFactory``，服务启动时按配置打开它拿到 ``PluginBinder``，
再用服务自己的工作区存储与素材台账（``PluginHost``）绑出登记表；关停时退出工厂，插件包借此关掉自己的连接。
"""

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

from agent_runtime.file_store.store import FileStore
from agent_runtime.material_ledger.store import MaterialLedger
from agent_runtime.transcript.display import DisplayFn, ToolDisplayEntry


class CapPlugin(AbstractCapability[AgentDepsT]):
    """插件类的共同基类：配置页与工具卡用的界面元数据，以及把服务绑进类的写法。

    子类是 ``@dataclass``，覆写 ``get_serialization_name`` 与 ``from_spec``，有依赖时覆写
    ``get_ordering``；再写一个带类型的类方法 ``bind(*, 服务...)``，内部调 ``_bound``。
    """

    label: ClassVar[str]
    """配置页上给人看的名字。"""

    summary: ClassVar[str]
    """配置页上给人看的一句说明。不用 ``description``：那是 pydantic-ai 自己的实例字段，延迟加载时
    给模型看。"""

    _services: ClassVar[Mapping[str, Any] | None] = None
    """``bind`` 绑进来的服务；没绑的类是 None。"""

    @classmethod
    @abstractmethod
    def get_serialization_name(cls) -> str:
        """稳定的插件名，agent 配置按它引用；插件不退出 spec 机制，所以不会是 None。"""

    @classmethod
    @abstractmethod
    def display_table(cls) -> Mapping[str, DisplayFn | ToolDisplayEntry]:
        """本插件各件工具的工具卡声明，与参数无关，组合根合并后供实时与历史投影共用。"""

    @classmethod
    def _bound(cls, **services: Any) -> type[Self]:
        """返回本类的一个子类，``services`` 放在它的类属性上；插件名、字段与方法都不变。"""

        namespace: dict[str, Any] = {
            "__module__": cls.__module__,
            "__qualname__": cls.__qualname__,
            "_services": MappingProxyType(dict(services)),
            # pydantic-ai 只在类自己的 __dict__ 里找 from_spec 来生成参数 schema，找不到就改读
            # dataclass 的 __init__，会把服务当成参数；所以把 from_spec 放进子类自己的命名空间。
            "from_spec": inspect.getattr_static(cls, "from_spec"),
        }
        # pydantic-ai 登记自定义 capability 时要求类自己带 @dataclass，继承来的不算。
        return cast("type[Self]", dataclass(type(cls.__name__, (cls,), namespace)))

    @classmethod
    def required_plugins(cls) -> tuple[str, ...]:
        """要求同一 agent 一起挂的插件名：照 ``from_spec()`` 造出的实例的 ``get_ordering().requires``。"""

        return required_plugins(cls.from_spec())

    @classmethod
    def parameters_model(cls) -> type[BaseModel]:
        """``from_spec`` 签名上的参数写成的模型，校验参数、给配置页出 JSON Schema 都用它。

        与 pydantic-ai 由 spec 生成 schema 同一做法：签名上的每个参数是一个字段，有默认值的可以不写，
        不收签名上没有的键。
        """

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
        """``bind`` 绑进来的服务。

        Raises:
            RuntimeError: 这个类还没绑服务——组合根应当把 ``bind`` 返回的类交给登记表。
        """

        if cls._services is None:
            raise RuntimeError(
                f"插件 {cls.get_serialization_name()} 还没绑服务：组合根要用 bind 返回的类"
            )
        return cls._services


PluginRegistry = Mapping[str, type[CapPlugin[Any]]]
"""插件名对应绑好服务的插件类；装配时整张表交给 ``Agent.from_spec``，由它按 spec 各造一份实例。"""


@dataclass(frozen=True, slots=True)
class PluginHost:
    """组合根交给插件绑定函数的服务。"""

    files: FileStore
    """工作区存储：写完就发 ``fs.changed`` 的那一份。"""

    ledger: MaterialLedger
    """对话素材台账。"""


PluginBinder = Callable[[PluginHost], PluginRegistry]
"""拿组合根的服务绑好插件，交回登记表。"""

PluginFactory = Callable[[Mapping[str, Any]], AbstractAsyncContextManager[PluginBinder]]
"""插件包的入口：收运行时配置里原样转来的 ``plugins.config``，进入时校验配置、建好自己的连接并做启动
检查，交回绑定函数；退出时关掉这些连接。配置不对或检查不过就在进入或绑定时抛，服务起不来。"""


def required_plugins(capability: AbstractCapability[Any]) -> tuple[str, ...]:
    """这个实例 ``get_ordering().requires`` 里各个插件类的插件名。"""

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
