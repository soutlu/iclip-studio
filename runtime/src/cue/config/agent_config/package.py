from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

import yaml
from packaging.version import InvalidVersion, Version
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from cue.config.agent_config.config import problems_from_errors
from cue.config.agent_config.models import Problem

FORMAT_VERSION: Final = "1.0.0"

MAX_PACKAGE_BYTES: Final = 1024 * 1024


class PackageAgent(BaseModel):
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
    package: AgentPackage | None
    problems: tuple[Problem, ...]
    warnings: tuple[str, ...]


def version_check(imported: str, *, current: str = FORMAT_VERSION) -> tuple[str | None, str | None]:
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
    agent_id: str
    name: str
    description: str
    listed: bool
    config: Mapping[str, Any]
    skills: Sequence[str]


def write_package(entry: str, agents: Sequence[ExportedAgent]) -> str:
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
