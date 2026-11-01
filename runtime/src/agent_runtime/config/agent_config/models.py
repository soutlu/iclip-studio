"""Agent 配置的领域形状：agent、草稿、版本、问题清单与编译结果。术语见 docs/CONTEXT.md「Agent 标识」等词条。

草稿与版本的 ``config`` 是 ``config.AgentConfig`` 校验后的 JSON 形态（``model_dump(mode="json")``），
比较两份配置是否相同就比这个形态。"""

from __future__ import annotations

import re
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Final, Literal

from agent_runtime.model_vocab import ThinkingEffort

AgentStatus = Literal["active", "archived"]
"""``active`` 在用；``archived`` 已归档，不能再被引用。"""

STATUS_ACTIVE: Final = "active"
STATUS_ARCHIVED: Final = "archived"

RevisionOperation = Literal["create", "publish", "restore", "import", "archive", "unarchive"]
"""操作记录的种类。"""

AGENT_ID_PATTERN: Final = re.compile(r"[a-z][a-z0-9-]{0,39}")
"""Agent 标识：小写字母开头，后面是小写字母、数字或连字符，最多 40 个字符，创建后不能改。"""

RESERVED_AGENT_IDS: Final = frozenset({"plugins", "order", "import", "model-options"})
"""不能用作新 agent 标识的词：它们是 ``/agents/`` 下的固定路径，用作标识会和 ``/agents/{id}`` 撞名。
``/agents/`` 下每加一个固定路径，就在这里补上那一段。"""

MAX_NAME_CHARS: Final = 50
MAX_DESCRIPTION_CHARS: Final = 1024
"""``description`` 在这个 agent 被当作子 agent 时给主 agent 看。"""

MCP_TOOL_NAME_PATTERN: Final = re.compile(r"[A-Za-z0-9_-]{1,64}")
"""模型看到的工具名要满足的写法：我们接的模型接口（OpenAI 兼容）只收这些字符，最多 64 个。"""

_MCP_TOOL_PREFIX: Final = "mcp_"


def mcp_tool_prefix(server_id: str) -> str:
    """一个 MCP 服务的工具在 agent 里的前缀 ``mcp_<服务标识>``；工具名是前缀加 ``_`` 加服务自己给的名字。

    插件的工具名不以 ``mcp_`` 开头，服务标识里没有下划线，所以 MCP 工具既不会和插件工具撞名，也不会在两个
    服务之间撞名，还能从工具名拆回服务与工具。"""

    return f"{_MCP_TOOL_PREFIX}{server_id}"


def mcp_tool_name(server_id: str, tool: str) -> str:
    """模型看到的工具名：``mcp_<服务标识>_<工具名>``。"""

    return f"{mcp_tool_prefix(server_id)}_{tool}"


def split_mcp_tool_name(name: str) -> tuple[str, str] | None:
    """把模型看到的工具名拆回（服务标识，服务自己给的工具名）；不是 MCP 工具给 ``None``。"""

    if not name.startswith(_MCP_TOOL_PREFIX):
        return None
    server_id, separator, tool = name.removeprefix(_MCP_TOOL_PREFIX).partition("_")
    if not separator or not server_id or not tool:
        return None
    return server_id, tool


@dataclass(frozen=True, slots=True)
class Agent:
    """``agents`` 的一行，连带当前版本的版本号与发布时刻。"""

    id: str
    name: str
    description: str
    status: AgentStatus
    listed: bool
    sort_order: int
    active_version_id: uuid.UUID | None
    active_version: int | None
    active_published_at: datetime | None
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class AgentDraft:
    """一个 agent 正在编辑的那一份：配置、按先后排好的技能 id 与乐观锁版本号。"""

    agent_id: str
    config: Mapping[str, Any]
    skill_ids: tuple[uuid.UUID, ...]
    base_version_id: uuid.UUID | None
    """草稿从哪个版本来：发布后是新版本，恢复后是恢复的那一版，新建与导入后为 ``None``。"""
    lock_version: int
    updated_by: uuid.UUID
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class AgentVersion:
    """发布一次得到的不可变版本，连同冻结下来的技能名单。"""

    id: uuid.UUID
    agent_id: str
    version: int
    config: Mapping[str, Any]
    skill_ids: tuple[uuid.UUID, ...]
    note: str | None
    created_by: uuid.UUID
    created_at: datetime


@dataclass(frozen=True, slots=True)
class AgentState:
    """一个 agent 此刻的全部：那一行、草稿与当前版本（没发布过为 ``None``）。"""

    agent: Agent
    draft: AgentDraft
    active: AgentVersion | None

    @property
    def has_unpublished_changes(self) -> bool:
        """草稿的配置或技能名单与当前版本不同；没发布过恒为真。"""

        return self.active is None or (self.draft.config, self.draft.skill_ids) != (
            self.active.config,
            self.active.skill_ids,
        )


@dataclass(frozen=True, slots=True)
class ConfigRefs:
    """一份配置引用了什么：模型（没写为 ``None``）、技能、子 agent 与 MCP 服务。"""

    provider: str | None
    model: str | None
    credential_id: uuid.UUID | None
    skill_ids: tuple[uuid.UUID, ...]
    subagents: tuple[str, ...]
    mcp_servers: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class AgentRefs:
    """一个 agent 的草稿与当前版本各引用了什么，供编译的子 agent 检查与「谁在用」共用。"""

    agent_id: str
    name: str
    description: str
    status: AgentStatus
    active_version_id: uuid.UUID | None
    draft: ConfigRefs
    active: ConfigRefs | None

    @property
    def subagents(self) -> frozenset[str]:
        """草稿与当前版本里写的子 agent 合在一起。"""

        active = self.active.subagents if self.active is not None else ()
        return frozenset((*self.draft.subagents, *active))


@dataclass(frozen=True, slots=True)
class Problem:
    """一条问题：``path`` 指到配置里的字段（如 ``model.settings.thinking``、``tools[2]``、
    ``subagents[0].agent``、``skills[1]``），``message`` 是给人看的一句话。"""

    path: str
    message: str


@dataclass(frozen=True, slots=True)
class CompiledModel:
    """建模型要的：供应商、模型名、这次用的密钥（显式写的，或供应商的默认密钥）与思考档位。"""

    provider_id: uuid.UUID
    provider: str
    model: str
    credential_id: uuid.UUID
    thinking: ThinkingEffort | None


@dataclass(frozen=True, slots=True)
class CompiledSkill:
    """挂哪个技能的哪一版：技能的最新版。"""

    skill_id: uuid.UUID
    name: str
    version_id: uuid.UUID


@dataclass(frozen=True, slots=True)
class CompiledSubagent:
    """一个子 agent：``agent_id`` 是它在派活工具里的名字，``description`` 给主 agent 看，``version_id``
    是它的当前版本；三个控制项照配置传。"""

    agent_id: str
    description: str
    version_id: uuid.UUID
    timeout_seconds: float | None
    max_calls: int | None
    on_failure: str | None


@dataclass(frozen=True, slots=True)
class CompiledMcpServer:
    """挂一个 MCP 服务：``tools`` 是放给模型的工具（服务自己给的名字），``None`` 是全部；``tool_prefix``
    见 ``mcp_tool_prefix``。连接参数与请求头装配时再取，不进编译结果。"""

    server_id: str
    tools: tuple[str, ...] | None
    tool_prefix: str


@dataclass(frozen=True, slots=True)
class CompiledAgent:
    """一份配置编译通过的结果，不可变。

    ``capabilities`` 是原生 AgentSpec 的 capabilities 条目，每项 ``{spec 名: 参数}``，停用的工具已去掉；
    MCP 服务、技能与子 agent 不进 spec，单独带着。"""

    agent_id: str
    instructions: str
    model: CompiledModel
    capabilities: tuple[Mapping[str, Mapping[str, Any]], ...]
    mcp_servers: tuple[CompiledMcpServer, ...]
    skills: tuple[CompiledSkill, ...]
    subagents: tuple[CompiledSubagent, ...]


@dataclass(frozen=True, slots=True)
class ModelFacts:
    """供应商的一个 llm 模型：启没启用、允许设的思考档位（空就是不能设）。"""

    name: str
    enabled: bool
    thinking: tuple[ThinkingEffort, ...]


@dataclass(frozen=True, slots=True)
class ProviderFacts:
    """一个接入的供应商：启停、全部密钥 id、默认密钥与全部 llm 模型（含停用的）。"""

    id: uuid.UUID
    name: str
    enabled: bool
    credential_ids: frozenset[uuid.UUID]
    default_credential_id: uuid.UUID | None
    models: tuple[ModelFacts, ...]


@dataclass(frozen=True, slots=True)
class PluginFacts:
    """插件登记表里的一个插件：插件名、给人看的名字与说明、要求同挂的插件名、参数的 JSON Schema。"""

    name: str
    label: str
    description: str
    requires: tuple[str, ...]
    parameters_schema: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class McpServerFacts:
    """一个 MCP 服务：名称、启没启用与最后一次试连成功时发现的工具名（从没成功过为 ``None``）。"""

    id: str
    name: str
    enabled: bool
    tools: tuple[str, ...] | None


@dataclass(frozen=True, slots=True)
class SkillFacts:
    """技能库里的一个技能：标识、归没归档与最新版（没发布过为 ``None``）。"""

    id: uuid.UUID
    name: str
    archived: bool
    latest_version_id: uuid.UUID | None


__all__ = [
    "AGENT_ID_PATTERN",
    "MAX_DESCRIPTION_CHARS",
    "MAX_NAME_CHARS",
    "MCP_TOOL_NAME_PATTERN",
    "RESERVED_AGENT_IDS",
    "STATUS_ACTIVE",
    "STATUS_ARCHIVED",
    "Agent",
    "AgentDraft",
    "AgentRefs",
    "AgentState",
    "AgentStatus",
    "AgentVersion",
    "CompiledAgent",
    "CompiledMcpServer",
    "CompiledModel",
    "CompiledSkill",
    "CompiledSubagent",
    "ConfigRefs",
    "McpServerFacts",
    "ModelFacts",
    "PluginFacts",
    "Problem",
    "ProviderFacts",
    "RevisionOperation",
    "SkillFacts",
    "mcp_tool_name",
    "mcp_tool_prefix",
    "split_mcp_tool_name",
]
