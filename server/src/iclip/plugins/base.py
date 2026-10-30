"""插件约定：我们自己定义、写在代码里的工具集，按名字挂到 agent 上。

一个插件类说明自己叫什么、给人看的名字与说明、要求同一 agent 一起挂哪些插件、收什么参数，
并由组合根在构造时注入运行依赖（连接池、领域服务的适配器等）。挂载时组合根按 agent 逐个调用
``build``，把产出的 capability 实例交给 Agent。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Mapping
from typing import ClassVar

from pydantic import BaseModel, ConfigDict

from iclip.harness.agents import AgentCapabilities
from iclip.platform.transcript.display import DisplayFn, ToolDisplayEntry


class PluginParameters(BaseModel):
    """插件参数的基类，不可变、不收未声明的字段；没有参数的插件直接用它。"""

    model_config = ConfigDict(extra="forbid", frozen=True)


class CapPlugin[P: PluginParameters](ABC):
    """插件基类。子类以 ``CapPlugin[自己的参数类型]`` 继承，``build`` 只收这一种参数。

    子类在 ``__init__`` 里以 keyword-only 参数接收自己的运行依赖，由组合根注入；构造期发现的装配
    错误（缺依赖、配置没接上）直接抛出，不留到挂载时。

    约定：``build`` 每个 agent 调一次，返回的实例要么是运行模板、由 ``for_run`` 按运行克隆出带状态
    的那份，要么本身没有状态；因此同一个插件给多个 agent、多次重载各 build 一份都是安全的。
    """

    name: ClassVar[str]
    """登记名，agents.yaml 按它引用。"""

    label: ClassVar[str]
    """配置页上给人看的名字。"""

    description: ClassVar[str]
    """配置页上给人看的一句说明。"""

    requires: ClassVar[tuple[str, ...]] = ()
    """要求同一 agent 一起挂的插件名；少挂了在装配期报错。"""

    Parameters: ClassVar[type[PluginParameters]] = PluginParameters
    """参数模型，须与类型参数 ``P`` 是同一个类；挂载时用它校验并构造这次的参数。"""

    @abstractmethod
    def build(self, parameters: P) -> AgentCapabilities:
        """用构造时拿到的依赖加上这份参数，产出要挂到 Agent 上的 capability 实例。"""

    @abstractmethod
    def display_table(self) -> Mapping[str, DisplayFn | ToolDisplayEntry]:
        """本插件各件工具的工具卡声明，与参数无关，组合根合并后供实时与历史投影共用。"""


__all__ = ["CapPlugin", "PluginParameters"]
