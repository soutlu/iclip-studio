"""导出包：一个 YAML 文件，装着入口 agent 与它的子 agent 各自当前版本的配置。

读包只用 ``yaml.safe_load``，包本身有大小上限。格式版本按 ``packaging.version`` 比较：包比本系统新、或者
主版本比本系统旧都拒收（不保留旧格式的兼容代码）；只是次版本旧的照收，带一条提醒。"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

import yaml
from packaging.version import InvalidVersion, Version
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from iclip.domains.agent_config.config import problems_from_errors
from iclip.domains.agent_config.models import Problem

FORMAT_VERSION: Final = "1.0.0"
"""本系统写出、也能读的包格式版本。"""

MAX_PACKAGE_BYTES: Final = 1024 * 1024


class PackageAgent(BaseModel):
    """包里的一个 agent。``config`` 是配置原样（没有 ``model.credential_id``），技能按标识写。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    name: str
    description: str = ""
    listed: bool = False
    config: dict[str, Any]
    skills: list[str] = Field(default_factory=list[str])


class AgentPackage(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    format_version: str
    entry: str
    agents: dict[str, PackageAgent]


@dataclass(frozen=True, slots=True)
class ReadPackage:
    """读包的结果：读不出来时 ``package`` 为 ``None``，问题在 ``problems``；``warnings`` 只是提醒。"""

    package: AgentPackage | None
    problems: tuple[Problem, ...]
    warnings: tuple[str, ...]


def version_check(imported: str, *, current: str = FORMAT_VERSION) -> tuple[str | None, str | None]:
    """比较包的格式版本与本系统的：交回 ``(问题, 提醒)``，至多一个不为空。"""

    try:
        imported_version = Version(imported)
    except InvalidVersion:
        return f"格式版本 {imported} 写得不对", None
    current_version = Version(current)
    if imported_version > current_version:
        return f"包的格式版本 {imported} 比本系统支持的 {current} 新，请先升级本系统", None
    if imported_version.major < current_version.major:
        return f"包的格式版本 {imported} 太旧，本系统只收 {current_version.major}.x 的包", None
    if imported_version.minor < current_version.minor:
        return (
            None,
            f"包的格式版本 {imported} 比本系统的 {current} 旧，按现在的格式读，请核对导入结果",
        )
    return None, None


def read_package(data: bytes) -> ReadPackage:
    """读一个导出包。大小、YAML、外层结构与格式版本的问题都在这里；每个 agent 的配置由调用方再查。"""

    if len(data) > MAX_PACKAGE_BYTES:
        return _failed(f"文件超过上限 {MAX_PACKAGE_BYTES // (1024 * 1024)} MB")
    try:
        loaded = yaml.safe_load(data.decode("utf-8"))
    except UnicodeDecodeError:
        return _failed("文件不是 UTF-8 文本")
    except yaml.YAMLError:
        return _failed("文件不是合法的 YAML")
    if not isinstance(loaded, dict):
        return _failed("文件应是键值对")
    try:
        package = AgentPackage.model_validate(loaded)
    except ValidationError as exc:
        return ReadPackage(package=None, problems=problems_from_errors(exc.errors()), warnings=())
    problem, warning = version_check(package.format_version)
    problems = [Problem("format_version", problem)] if problem is not None else []
    if package.entry not in package.agents:
        problems.append(Problem("entry", f"入口 {package.entry} 不在 agents 里"))
    return ReadPackage(
        package=package,
        problems=tuple(problems),
        warnings=(warning,) if warning is not None else (),
    )


def _failed(message: str) -> ReadPackage:
    return ReadPackage(package=None, problems=(Problem("", message),), warnings=())


@dataclass(frozen=True, slots=True)
class ExportedAgent:
    """写进包的一个 agent；``config`` 已去掉密钥。"""

    agent_id: str
    name: str
    description: str
    listed: bool
    config: Mapping[str, Any]
    skills: Sequence[str]


def write_package(entry: str, agents: Sequence[ExportedAgent]) -> str:
    """写出导出包；``agents`` 的先后就是包里的先后，入口放在最前。"""

    document = {
        "format_version": FORMAT_VERSION,
        "entry": entry,
        "agents": {
            one.agent_id: {
                "name": one.name,
                "description": one.description,
                "listed": one.listed,
                "config": dict(one.config),
                "skills": list(one.skills),
            }
            for one in agents
        },
    }
    return yaml.safe_dump(document, allow_unicode=True, sort_keys=False, width=1_000_000)


def without_credential(config: Mapping[str, Any]) -> dict[str, Any]:
    """导出用的配置：去掉 ``model.credential_id``，密钥只属于本环境。"""

    exported = dict(config)
    model = exported.get("model")
    if isinstance(model, Mapping):
        exported["model"] = {key: value for key, value in model.items() if key != "credential_id"}
    return exported


__all__ = [
    "FORMAT_VERSION",
    "MAX_PACKAGE_BYTES",
    "AgentPackage",
    "ExportedAgent",
    "PackageAgent",
    "ReadPackage",
    "read_package",
    "version_check",
    "without_credential",
    "write_package",
]
