"""Agent 配置用例：建 agent、改元信息与先后、存草稿、发布与读版本、恢复到草稿、归档，以及导出导入。

同一 agent 的草稿保存、发布、恢复、归档都在锁住这个 agent 行的事务里做，判断与写入看到的是同一份草稿；
草稿按 ``lock_version`` 防覆盖。保存只查结构，引用在发布时由 ``compile_agent`` 查。"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from iclip.common.agent_usage import in_use_message, usages_out
from iclip.common.errors import Conflict, NotFound, ValidationFailed
from iclip.domains.agent_config.compile import compile_agent
from iclip.domains.agent_config.config import (
    AgentConfig,
    dump_config,
    empty_config,
    load_config,
    parse_config,
)
from iclip.domains.agent_config.models import (
    STATUS_ACTIVE,
    STATUS_ARCHIVED,
    AgentState,
    AgentStatus,
    AgentVersion,
    CompiledAgent,
    Problem,
    SkillFacts,
)
from iclip.domains.agent_config.package import (
    ExportedAgent,
    PackageAgent,
    read_package,
    without_credential,
    write_package,
)
from iclip.domains.agent_config.repository import (
    AgentStore,
    AgentWriter,
    ImportedAgent,
    ModelDirectory,
    PluginDirectory,
    SkillDirectory,
)
from iclip.domains.agent_config.rules import (
    agent_id_problem,
    check_agent_id,
    clean_description,
    clean_name,
    clean_note,
    format_problems,
)
from iclip.domains.agent_config.schemas import (
    ActiveVersionOut,
    AgentCreateIn,
    AgentDetailOut,
    AgentDraftIn,
    AgentDraftOut,
    AgentImportItemOut,
    AgentImportOut,
    AgentOrderIn,
    AgentOut,
    AgentPluginOut,
    AgentPluginsOut,
    AgentProblemOut,
    AgentPublishIn,
    AgentRestoreIn,
    AgentsOut,
    AgentUpdateIn,
    AgentVersionDetailOut,
    AgentVersionOut,
    AgentVersionsOut,
)
from iclip.domains.agent_config.usage import subagent_users


class AgentPublishBlocked(ValidationFailed):
    """发布前编译没通过：``problems`` 是全部问题，消息是拼好的一句话。"""

    def __init__(self, problems: Sequence[Problem]) -> None:
        super().__init__(format_problems(problems))
        self.problems = tuple(problems)


@dataclass(frozen=True, slots=True)
class AgentExport:
    """导出包：下载用的文件名与 YAML 文本。"""

    filename: str
    content: str


def _problem_out(problem: Problem) -> AgentProblemOut:
    return AgentProblemOut(path=problem.path, message=problem.message)


def _agent_out(state: AgentState) -> AgentOut:
    agent = state.agent
    active = state.active
    return AgentOut(
        id=agent.id,
        name=agent.name,
        description=agent.description,
        status=agent.status,
        listed=agent.listed,
        sort_order=agent.sort_order,
        active_version=ActiveVersionOut(
            id=active.id, version=active.version, published_at=active.created_at
        )
        if active is not None
        else None,
        has_unpublished_changes=state.has_unpublished_changes,
        created_by=agent.created_by,
        created_at=agent.created_at,
        updated_at=agent.updated_at,
    )


def _version_out(version: AgentVersion) -> AgentVersionOut:
    return AgentVersionOut(
        id=version.id,
        version=version.version,
        note=version.note,
        created_by=version.created_by,
        created_at=version.created_at,
    )


def _check_lock(writer: AgentWriter, lock_version: int) -> None:
    if writer.state.draft.lock_version != lock_version:
        raise Conflict("草稿已被改动，请读取最新内容后再操作")


def _check_skill_ids(skill_ids: Sequence[uuid.UUID], skills: Sequence[SkillFacts]) -> None:
    """技能名单的结构：不重复、都在技能库里（归档与否发布时才查）。"""

    known = {skill.id for skill in skills}
    seen: set[uuid.UUID] = set()
    problems: list[Problem] = []
    for index, skill_id in enumerate(skill_ids):
        if skill_id in seen:
            problems.append(Problem(f"skills[{index}]", "与前面的技能重复"))
        elif skill_id not in known:
            problems.append(Problem(f"skills[{index}]", "技能不存在"))
        seen.add(skill_id)
    if problems:
        raise ValidationFailed(format_problems(problems))


class AgentConfigService:
    """``models``、``plugins``、``skills`` 由组合根接到模型供应商、插件登记表与技能库上。"""

    def __init__(
        self,
        store: AgentStore,
        *,
        models: ModelDirectory,
        plugins: PluginDirectory,
        skills: SkillDirectory,
    ) -> None:
        self._store = store
        self._models = models
        self._plugins = plugins
        self._skills = skills

    async def list(self) -> AgentsOut:
        return AgentsOut(items=[_agent_out(state) for state in await self._store.list()])

    def plugins(self) -> AgentPluginsOut:
        """本部署插件登记表里的全部插件，配置页列出来供选择。"""

        return AgentPluginsOut(
            items=[
                AgentPluginOut(
                    name=plugin.name,
                    label=plugin.label,
                    description=plugin.description,
                    requires=list(plugin.requires),
                    parameters=dict(plugin.parameters_schema),
                )
                for plugin in self._plugins.catalog()
            ]
        )

    async def detail(self, agent_id: str) -> AgentDetailOut:
        """一个 agent 连同草稿、技能绑定与谁把它当作子 agent；没有是 ``NotFound``。"""

        state = await self._require(agent_id)
        draft = state.draft
        users = subagent_users(await self._store.references(), agent_id)
        return AgentDetailOut(
            **_agent_out(state).model_dump(),
            draft=AgentDraftOut(
                config=load_config(draft.config),
                skill_ids=list(draft.skill_ids),
                base_version_id=draft.base_version_id,
                lock_version=draft.lock_version,
                updated_by=draft.updated_by,
                updated_at=draft.updated_at,
            ),
            used_by=usages_out(users),
        )

    async def create(self, body: AgentCreateIn, *, by: uuid.UUID) -> AgentDetailOut:
        """建一个 agent：草稿是空配置（没有模型），不上菜单，排在最后。标识不合规矩、名称为空或超长是
        ``ValidationFailed``，标识已被占用是 ``Conflict``。"""

        agent_id = check_agent_id(body.id)
        await self._store.create(
            agent_id,
            name=clean_name(body.name),
            description=clean_description(body.description),
            config=dump_config(empty_config()),
            by=by,
        )
        return await self.detail(agent_id)

    async def update(self, agent_id: str, body: AgentUpdateIn) -> AgentDetailOut:
        """改名称、描述或上不上菜单；描述不进版本，改了立即生效。"""

        name = clean_name(body.name) if body.name is not None else None
        description = clean_description(body.description) if body.description is not None else None
        async with self._store.edit(agent_id) as writer:
            await writer.update(name=name, description=description, listed=body.listed)
        return await self.detail(agent_id)

    async def reorder(self, body: AgentOrderIn) -> AgentsOut:
        """按给的先后排；必须正好是全部 agent 的标识，各一次。"""

        current = {state.agent.id for state in await self._store.list()}
        if len(set(body.ids)) != len(body.ids) or set(body.ids) != current:
            raise ValidationFailed("要给出全部 agent 的标识，每个一次")
        await self._store.reorder(body.ids)
        return await self.list()

    async def save_draft(
        self, agent_id: str, body: AgentDraftIn, *, by: uuid.UUID
    ) -> AgentDetailOut:
        """整份保存草稿。``lockVersion`` 对不上是 ``Conflict``；配置的结构已由请求模型校验，技能名单重复或
        有不存在的技能是 ``ValidationFailed``；其余引用不查，草稿允许暂时不完整。"""

        _check_skill_ids(body.skill_ids, await self._skills.skills())
        async with self._store.edit(agent_id) as writer:
            _check_lock(writer, body.lock_version)
            await writer.replace_draft(
                dump_config(body.config),
                body.skill_ids,
                base_version_id=writer.state.draft.base_version_id,
                by=by,
            )
        return await self.detail(agent_id)

    async def compile(
        self,
        agent_id: str,
        config: AgentConfig,
        skill_ids: Sequence[uuid.UUID],
        *,
        runtime: bool = False,
    ) -> CompiledAgent | tuple[Problem, ...]:
        """按当下的模型供应商、插件登记表、技能库与全部 agent 编译一份配置；``runtime`` 见
        ``compile_agent``。"""

        return await compile_agent(
            agent_id,
            config,
            skill_ids,
            models=self._models,
            plugins=self._plugins,
            skills=await self._skills.skills(),
            agents=await self._store.references(),
            runtime=runtime,
        )

    # --- 运行时读 -------------------------------------------------------------

    async def listed(self) -> tuple[AgentState, ...]:
        """首页能选的 agent：上菜单、在用、发布过，按 ``sort_order``。"""

        return tuple(
            state
            for state in await self._store.list()
            if state.agent.listed
            and state.agent.status == STATUS_ACTIVE
            and state.active is not None
        )

    async def version_for_new_session(self, agent_id: str) -> uuid.UUID:
        """新对话要固定的版本：这个 agent 的当前版本。没有这个 agent 或它不上菜单是 ``ValidationFailed``，
        已归档或还没发布过是 ``Conflict``。"""

        state = await self._store.get(agent_id)
        if state is None:
            raise ValidationFailed(f"没有标识为 {agent_id} 的 agent")
        if state.agent.status == STATUS_ARCHIVED:
            raise Conflict(f"{state.agent.name} 已归档，不能再开新对话")
        if state.active is None:
            raise Conflict(f"{state.agent.name} 还没有发布过版本，不能开对话")
        if not state.agent.listed:
            raise ValidationFailed(f"{state.agent.name} 不在首页菜单上，不能直接开对话")
        return state.active.id

    async def runtime_version(self, agent_id: str, version_id: uuid.UUID) -> AgentVersion | None:
        """这个 agent 的这个版本；不属于它给 ``None``。"""

        return await self._store.version(agent_id, version_id)

    async def runtime_state(self, agent_id: str) -> AgentState | None:
        """一个 agent 此刻的全部，含草稿与描述；没有给 ``None``。"""

        return await self._store.get(agent_id)

    async def publish(
        self, agent_id: str, body: AgentPublishIn, *, by: uuid.UUID
    ) -> AgentVersionOut:
        """把草稿发布成新版本：``lockVersion`` 对不上是 ``Conflict``；编译不通过是 ``AgentPublishBlocked``
        （带全部问题）；配置与技能名单都与当前版本相同是 ``ValidationFailed``；否则在同一个事务里写版本、
        技能名单与操作记录，移动当前版本，草稿的 ``base_version_id`` 指到新版本。"""

        note = clean_note(body.note)
        version_id = uuid.uuid4()
        async with self._store.edit(agent_id) as writer:
            _check_lock(writer, body.lock_version)
            state = writer.state
            compiled = await self.compile(
                agent_id, load_config(state.draft.config), state.draft.skill_ids
            )
            if not isinstance(compiled, CompiledAgent):
                raise AgentPublishBlocked(compiled)
            if not state.has_unpublished_changes:
                raise ValidationFailed("没有可发布的改动")
            await writer.publish(
                version_id,
                config=state.draft.config,
                skill_ids=state.draft.skill_ids,
                note=note,
                by=by,
            )
        return _version_out(await self._require_version(agent_id, version_id))

    async def versions(self, agent_id: str) -> AgentVersionsOut:
        await self._require(agent_id)
        return AgentVersionsOut(
            items=[_version_out(version) for version in await self._store.versions(agent_id)]
        )

    async def version(self, agent_id: str, version_id: uuid.UUID) -> AgentVersionDetailOut:
        version = await self._require_version(agent_id, version_id)
        return AgentVersionDetailOut(
            **_version_out(version).model_dump(),
            config=load_config(version.config),
            skill_ids=list(version.skill_ids),
        )

    async def restore(
        self, agent_id: str, version_id: uuid.UUID, body: AgentRestoreIn, *, by: uuid.UUID
    ) -> AgentDetailOut:
        """把一个版本的配置与技能名单抄回草稿，记一条 restore；不发布。``lockVersion`` 对不上是
        ``Conflict``，没有这个版本是 ``NotFound``。"""

        async with self._store.edit(agent_id) as writer:
            _check_lock(writer, body.lock_version)
            version = await writer.version(version_id)
            if version is None:
                raise NotFound("版本不存在")
            base = writer.state.draft.base_version_id
            await writer.replace_draft(
                version.config, version.skill_ids, base_version_id=version.id, by=by
            )
            await writer.record("restore", by=by, from_version_id=base, to_version_id=version.id)
        return await self.detail(agent_id)

    async def archive(self, agent_id: str, *, by: uuid.UUID) -> AgentDetailOut:
        """归档；别的 agent 的草稿或当前版本还把它当作子 agent 是 ``Conflict``，列出它们。已归档的原样不动。"""

        async with self._store.edit(agent_id) as writer:
            if writer.state.agent.status != STATUS_ARCHIVED:
                users = subagent_users(await self._store.references(), agent_id)
                if users:
                    raise Conflict(in_use_message(f"agent {agent_id} ", users))
                await self._set_status(writer, STATUS_ARCHIVED, by=by)
        return await self.detail(agent_id)

    async def unarchive(self, agent_id: str, *, by: uuid.UUID) -> AgentDetailOut:
        """取消归档；在用的原样不动。"""

        async with self._store.edit(agent_id) as writer:
            if writer.state.agent.status != STATUS_ACTIVE:
                await self._set_status(writer, STATUS_ACTIVE, by=by)
        return await self.detail(agent_id)

    async def export(self, agent_id: str) -> AgentExport:
        """把 agent 与它的子 agent 各自的当前版本写成导出包，去掉密钥。没有这个 agent、或它与它的子 agent
        有没发布过的，是 ``NotFound``。"""

        state = await self._require(agent_id)
        if state.active is None:
            raise NotFound("还没有发布过版本")
        names = {skill.id: skill.name for skill in await self._skills.skills()}
        exported = [self._exported(state, names)]
        for sub in load_config(state.active.config).subagents:
            sub_state = await self._store.get(sub.agent)
            if sub_state is None or sub_state.active is None:
                raise NotFound(f"子 agent {sub.agent} 没有发布过的版本")
            exported.append(self._exported(sub_state, names))
        return AgentExport(
            filename=f"{agent_id}-v{state.active.version}.yaml",
            content=write_package(agent_id, exported),
        )

    async def import_package(self, data: bytes, *, dry_run: bool, by: uuid.UUID) -> AgentImportOut:
        """导入一个导出包。``dry_run`` 只读不写：交回每个 agent 会新建还是覆盖、问题与提醒，以及整个包的问题
        与提醒。正式导入时有任何问题是 ``ValidationFailed``，什么都不写；否则同标识的覆盖草稿，没有的新建
        （只有草稿），都不发布，每个 agent 记一条 import。"""

        read = read_package(data)
        package = read.package
        items: list[AgentImportItemOut] = []
        imported: list[ImportedAgent] = []
        if package is not None:
            existing = {state.agent.id for state in await self._store.list()}
            skills = {skill.name: skill for skill in await self._skills.skills()}
            for agent_id, agent in package.agents.items():
                item, ready = await self._check_imported(
                    agent_id,
                    agent,
                    exists=agent_id in existing,
                    known_agents=existing | package.agents.keys(),
                    skills=skills,
                )
                items.append(item)
                if ready is not None:
                    imported.append(ready)
        result = AgentImportOut(
            entry=package.entry if package is not None else None,
            agents=items,
            problems=[_problem_out(one) for one in read.problems],
            warnings=list(read.warnings),
        )
        if dry_run:
            return result
        problems = [*read.problems] + [
            Problem(f"{item.agent_id}.{one.path}" if one.path else item.agent_id, one.message)
            for item in items
            for one in item.problems
        ]
        if problems or package is None:
            raise ValidationFailed(format_problems(problems) or "导出包读不出来")
        await self._store.import_agents(imported, by=by)
        return result

    async def _check_imported(
        self,
        agent_id: str,
        agent: PackageAgent,
        *,
        exists: bool,
        known_agents: set[str],
        skills: Mapping[str, SkillFacts],
    ) -> tuple[AgentImportItemOut, ImportedAgent | None]:
        """查包里的一个 agent：问题拦导入，提醒不拦。都没问题时交回要写的那一份。"""

        problems: list[Problem] = []
        warnings: list[Problem] = []
        if (issue := agent_id_problem(agent_id, new=not exists)) is not None:
            problems.append(Problem("", issue))
        name = description = None
        try:
            name = clean_name(agent.name)
        except ValidationFailed as exc:
            problems.append(Problem("name", str(exc)))
        try:
            description = clean_description(agent.description)
        except ValidationFailed as exc:
            problems.append(Problem("description", str(exc)))
        parsed = parse_config(without_credential(agent.config), prefix="config")
        config: AgentConfig | None = None
        if not isinstance(parsed, AgentConfig):
            problems.extend(parsed)
        else:
            config = parsed
            await self._check_imported_model(config, problems, warnings)
            for index, sub in enumerate(config.subagents):
                if sub.agent not in known_agents:
                    problems.append(
                        Problem(
                            f"config.subagents[{index}].agent",
                            f"子 agent {sub.agent} 既不在包里，也不在本环境",
                        )
                    )
        skill_ids: list[uuid.UUID] = []
        for index, skill_name in enumerate(agent.skills):
            skill = skills.get(skill_name)
            if skill is None:
                problems.append(Problem(f"skills[{index}]", f"本环境没有技能 {skill_name}"))
                continue
            skill_ids.append(skill.id)
            if skill.archived:
                warnings.append(Problem(f"skills[{index}]", f"技能 {skill_name} 已归档"))
            elif skill.latest_version_id is None:
                warnings.append(Problem(f"skills[{index}]", f"技能 {skill_name} 还没有发布过版本"))
        if len(set(skill_ids)) != len(skill_ids):
            problems.append(Problem("skills", "技能有重复"))
        item = AgentImportItemOut(
            agent_id=agent_id,
            name=name or agent.name,
            action="overwrite" if exists else "create",
            problems=[_problem_out(one) for one in problems],
            warnings=[_problem_out(one) for one in warnings],
        )
        if problems or config is None or name is None or description is None:
            return item, None
        return item, ImportedAgent(
            agent_id=agent_id,
            name=name,
            description=description,
            listed=agent.listed,
            config=dump_config(config),
            skill_ids=tuple(skill_ids),
        )

    async def _check_imported_model(
        self, config: AgentConfig, problems: list[Problem], warnings: list[Problem]
    ) -> None:
        ref = config.model
        if ref is None:
            return
        provider = await self._models.provider(ref.provider)
        if provider is None:
            problems.append(Problem("config.model.provider", f"本环境没有供应商 {ref.provider}"))
            return
        if not provider.enabled:
            warnings.append(Problem("config.model.provider", f"供应商 {ref.provider} 已停用"))
        model = next((one for one in provider.models if one.name == ref.name), None)
        if model is None:
            problems.append(
                Problem("config.model.name", f"供应商 {ref.provider} 没有对话模型 {ref.name}")
            )
        elif not model.enabled:
            warnings.append(Problem("config.model.name", f"模型 {ref.name} 已停用"))

    def _exported(self, state: AgentState, skill_names: Mapping[uuid.UUID, str]) -> ExportedAgent:
        active = state.active
        if active is None:
            raise NotFound(f"agent {state.agent.id} 没有发布过的版本")
        return ExportedAgent(
            agent_id=state.agent.id,
            name=state.agent.name,
            description=state.agent.description,
            listed=state.agent.listed,
            config=without_credential(active.config),
            skills=[skill_names[skill_id] for skill_id in active.skill_ids],
        )

    async def _set_status(self, writer: AgentWriter, status: AgentStatus, *, by: uuid.UUID) -> None:
        await writer.update(status=status)
        await writer.record("archive" if status == STATUS_ARCHIVED else "unarchive", by=by)

    async def _require(self, agent_id: str) -> AgentState:
        state = await self._store.get(agent_id)
        if state is None:
            raise NotFound("agent 不存在")
        return state

    async def _require_version(self, agent_id: str, version_id: uuid.UUID) -> AgentVersion:
        await self._require(agent_id)
        version = await self._store.version(agent_id, version_id)
        if version is None:
            raise NotFound("版本不存在")
        return version


__all__ = ["AgentConfigService", "AgentExport", "AgentPublishBlocked"]
