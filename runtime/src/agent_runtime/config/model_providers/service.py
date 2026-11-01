"""模型供应商用例：读声明，接入与修改供应商，管密钥（保存前先试连）、模型的启停与自己加的模型，设默认模型，
换钥。规则见 ``rules``；跨行的规则都在 ``ModelProviderStore.edit`` 锁住供应商之后判断。"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import replace

import structlog

from agent_runtime.agent_usage import (
    AgentUsage,
    ModelReference,
    in_use_message,
    merge_usages,
    usages_out,
)
from agent_runtime.config.model_providers.catalog import Declarations, ProviderDeclaration
from agent_runtime.config.model_providers.cipher import CredentialCipher
from agent_runtime.config.model_providers.models import (
    SOURCE_CUSTOM,
    SOURCE_DECLARED,
    CredentialRecord,
    DefaultModel,
    ModelSetting,
    ModelType,
    ProbeResult,
    ProviderModel,
    ProviderRecord,
    ProviderState,
    ResolvedProvider,
    RuntimeModel,
)
from agent_runtime.config.model_providers.repository import (
    CredentialProbe,
    ModelProviderStore,
    ModelUsages,
    ProviderEditor,
)
from agent_runtime.config.model_providers.rules import (
    check_provider_name,
    clean_credential_name,
    clean_label,
    custom_model,
    decrypt_fields,
    encrypt_fields,
    find_model,
    masked_fields,
    merge_models,
    merged_fields,
    new_fields,
    probe_model,
)
from agent_runtime.config.model_providers.schemas import (
    CredentialCreateIn,
    CredentialFieldOut,
    CredentialOptionOut,
    CredentialOut,
    CredentialTestIn,
    CredentialUpdateIn,
    CustomModelCreateIn,
    DeclarationOut,
    DeclarationsOut,
    DeclaredModelOut,
    DefaultModelIn,
    DefaultModelOut,
    DefaultModelsOut,
    ModelOptionOut,
    ModelOptionsOut,
    ModelProviderCreateIn,
    ModelProviderOut,
    ModelProvidersOut,
    ModelProviderUpdateIn,
    ModelUpdateIn,
    ProbeOut,
    ProviderModelOut,
    ProviderOptionOut,
)
from agent_runtime.errors import Conflict, NotFound, ValidationFailed

_logger = structlog.stdlib.get_logger(__name__)

_PROPERTY_FIELDS = frozenset({"api", "context_size", "thinking"})


def _declaration_out(declaration: ProviderDeclaration) -> DeclarationOut:
    return DeclarationOut(
        name=declaration.name,
        label=declaration.label,
        credential_fields=[
            CredentialFieldOut(
                name=field.name,
                label=field.label,
                type=field.type,
                required=field.required,
                default=field.default,
            )
            for field in declaration.credential_fields
        ],
        custom_models=declaration.custom_models,
        models=[
            DeclaredModelOut(
                name=model.name,
                type=model.type,
                api=model.api,
                context_size=model.context_size,
                thinking=list(model.thinking),
            )
            for model in declaration.models
        ],
    )


def _model_out(model: ProviderModel, users: Sequence[AgentUsage]) -> ProviderModelOut:
    return ProviderModelOut(
        name=model.name,
        type=model.type,
        api=model.properties.api,
        context_size=model.properties.context_size,
        thinking=list(model.properties.thinking),
        source=model.source,
        enabled=model.enabled,
        used_by=usages_out(users),
    )


def _provider_users(
    references: Sequence[ModelReference], provider: ProviderRecord
) -> tuple[AgentUsage, ...]:
    """写了这个供应商的 agent。"""

    return merge_usages(one.usage for one in references if one.provider == provider.name)


def _model_users(
    references: Sequence[ModelReference], provider: ProviderRecord, model: ProviderModel
) -> tuple[AgentUsage, ...]:
    """写了这个模型的 agent；agent 只用 llm 模型，别的类型没人用。"""

    if model.type != "llm":
        return ()
    return merge_usages(
        one.usage for one in references if one.provider == provider.name and one.model == model.name
    )


def _credential_users(
    references: Sequence[ModelReference], provider: ProviderRecord, credential_id: uuid.UUID
) -> tuple[AgentUsage, ...]:
    """显式写了这把密钥的 agent；没写密钥的用默认密钥，默认密钥本来就不能删。"""

    return merge_usages(
        one.usage
        for one in references
        if one.provider == provider.name and one.credential_id == credential_id
    )


def _default_out(default: DefaultModel) -> DefaultModelOut:
    return DefaultModelOut(
        type=default.type,
        provider_id=default.provider_id,
        provider_name=default.provider_name,
        model_name=default.model_name,
        updated_at=default.updated_at,
    )


def _probe_out(result: ProbeResult) -> ProbeOut:
    return ProbeOut(ok=result.ok, elapsed_ms=result.elapsed_ms, reason=result.reason)


def _credential(state: ProviderState, credential_id: uuid.UUID) -> CredentialRecord:
    found = next((one for one in state.credentials if one.id == credential_id), None)
    if found is None:
        raise NotFound("密钥不存在")
    return found


def _declaration_named(declarations: Declarations, name: str) -> ProviderDeclaration:
    declaration = declarations.get(name)
    if declaration is None:
        # 声明随代码发布；库里还有用它的供应商却删了声明，是发布出了错，不能装作没事。
        raise RuntimeError(f"库里有供应商用声明 {name}，但代码里已没有这个声明")
    return declaration


async def rotate_credential_keys(
    store: ModelProviderStore, *, declarations: Declarations, cipher: CredentialCipher
) -> int:
    """把全部密钥的机密字段改用第一个 key 重新加密，交回改了几把。供 ``scripts/admin.py`` 换钥用。"""

    def rotate(declaration_name: str, credential: CredentialRecord) -> Mapping[str, str]:
        secrets = _declaration_named(declarations, declaration_name).secret_fields
        return {
            name: cipher.rotate(value) if name in secrets else value
            for name, value in credential.fields.items()
        }

    return await store.rewrite_credentials(rotate)


def _require_not_default(editor: ProviderEditor, model: ProviderModel) -> None:
    if any(
        default.type == model.type and default.model_name == model.name
        for default in editor.defaults
    ):
        raise Conflict(f"{model.name} 是默认模型，先把默认模型换成别的")


class ModelProviderService:
    """``probe`` 由组合根接上，每次调用都是一次真实的上游请求；``usages`` 由组合根接到 agent 配置域，
    回答哪些 agent 在用哪个供应商、模型与密钥。"""

    def __init__(
        self,
        store: ModelProviderStore,
        *,
        declarations: Declarations,
        cipher: CredentialCipher,
        probe: CredentialProbe,
        usages: ModelUsages,
    ) -> None:
        self._store = store
        self._declarations = declarations
        self._cipher = cipher
        self._probe = probe
        self._usages = usages

    def declarations(self) -> DeclarationsOut:
        """可以接入的供应商声明，按声明名排。"""

        return DeclarationsOut(
            declarations=[
                _declaration_out(self._declarations[name]) for name in sorted(self._declarations)
            ]
        )

    async def providers(self) -> ModelProvidersOut:
        """接入的全部供应商，带打码的密钥与合并后的模型列表，每个模型与每把密钥带在用它的 agent。"""

        references = await self._usages.model_references()
        return ModelProvidersOut(
            providers=[
                self._provider_out(state, references) for state in await self._store.states()
            ]
        )

    async def model_options(self) -> ModelOptionsOut:
        """agent 编辑页选模型用：启用的供应商，各带启用的 ``llm`` 模型与打码的密钥，不带「谁在用」。"""

        options: list[ProviderOptionOut] = []
        for state in await self._store.states():
            provider = state.provider
            if not provider.enabled:
                continue
            declaration = self._declaration_of(provider)
            options.append(
                ProviderOptionOut(
                    id=provider.id,
                    name=provider.name,
                    label=provider.label,
                    models=[
                        ModelOptionOut(
                            name=model.name,
                            context_size=model.properties.context_size,
                            thinking=list(model.properties.thinking),
                        )
                        for model in merge_models(declaration, state.settings)
                        if model.type == "llm" and model.enabled
                    ],
                    credentials=[
                        CredentialOptionOut(
                            id=credential.id,
                            name=credential.name,
                            fields=masked_fields(
                                declaration,
                                decrypt_fields(declaration, credential.fields, self._cipher),
                            ),
                            is_default=credential.id == provider.default_credential_id,
                        )
                        for credential in state.credentials
                    ],
                )
            )
        return ModelOptionsOut(providers=options)

    async def resolved(self, name: str) -> ResolvedProvider | None:
        """按引用名找接入的供应商，带密钥 id 与合并后的模型列表；没有给 ``None``。供别的模块查引用。"""

        state = next((one for one in await self._store.states() if one.provider.name == name), None)
        if state is None:
            return None
        return ResolvedProvider(
            provider=state.provider,
            credential_ids=tuple(one.id for one in state.credentials),
            models=merge_models(self._declaration_of(state.provider), state.settings),
        )

    async def runtime_model(
        self, provider_name: str, model_name: str, credential_id: uuid.UUID
    ) -> RuntimeModel | None:
        """运行时建对话模型要的东西：按引用名找供应商、它的这个 llm 模型与这把密钥，密钥字段解密成明文。
        三者有一样不在给 ``None``；启没启用不在这里判（agent 编译时已查）。"""

        state = next(
            (one for one in await self._store.states() if one.provider.name == provider_name),
            None,
        )
        if state is None:
            return None
        return self._runtime_model(state, model_name, credential_id)

    async def default_llm(self) -> RuntimeModel | None:
        """默认的对话模型连同供应商的默认密钥，用来起对话标题；没设默认、供应商停用、模型停用或没有默认
        密钥都给 ``None``。"""

        default = next(
            (one for one in await self._store.default_models() if one.type == "llm"), None
        )
        if default is None:
            return None
        state = await self._store.state(default.provider_id)
        if state is None or not state.provider.enabled:
            return None
        credential_id = state.provider.default_credential_id
        if credential_id is None:
            return None
        found = self._runtime_model(state, default.model_name, credential_id)
        if found is None or not found.model.enabled:
            return None
        return found

    def _runtime_model(
        self, state: ProviderState, model_name: str, credential_id: uuid.UUID
    ) -> RuntimeModel | None:
        declaration = self._declaration_of(state.provider)
        model = find_model(merge_models(declaration, state.settings), model_name, "llm")
        credential = next((one for one in state.credentials if one.id == credential_id), None)
        if model is None or credential is None:
            return None
        return RuntimeModel(
            declaration=declaration,
            provider=state.provider,
            model=model,
            credential_id=credential.id,
            credential_updated_at=credential.updated_at,
            fields=decrypt_fields(declaration, credential.fields, self._cipher),
        )

    async def create(self, body: ModelProviderCreateIn) -> ModelProviderOut:
        """接入一个供应商：启用、还没有密钥。不认识的声明、不合格的引用名或显示名、引用名撞了都是
        ``ValidationFailed``。"""

        name = check_provider_name(body.name)
        if body.provider not in self._declarations:
            raise ValidationFailed(f"没有叫 {body.provider} 的供应商声明")
        provider_id = uuid.uuid4()
        await self._store.insert_provider(
            provider_id, name=name, provider=body.provider, label=clean_label(body.label)
        )
        return await self._provider_out_by_id(provider_id)

    async def update(self, provider_id: uuid.UUID, body: ModelProviderUpdateIn) -> ModelProviderOut:
        """改显示名、启停或默认密钥；默认密钥必须是这个供应商的密钥。某个 agent 的草稿或当前版本还写着
        这个供应商时停用是 ``Conflict``。"""

        async with self._store.edit(provider_id) as editor:
            provider = editor.state.provider
            if provider.enabled and body.enabled is False:
                users = _provider_users(await self._usages.model_references(), provider)
                if users:
                    raise Conflict(in_use_message(f"供应商 {provider.name} ", users))
            default_credential_id = provider.default_credential_id
            if body.default_credential_id is not None:
                _ = self._credential_in(editor.state, body.default_credential_id)
                default_credential_id = body.default_credential_id
            await editor.update_provider(
                label=provider.label if body.label is None else clean_label(body.label),
                enabled=provider.enabled if body.enabled is None else body.enabled,
                default_credential_id=default_credential_id,
            )
        return await self._provider_out_by_id(provider_id)

    async def delete(self, provider_id: uuid.UUID) -> None:
        """删一个供应商连同它的密钥与模型设置。某个 agent 的草稿或当前版本还写着这个供应商（含它的模型与
        密钥）、或某个类型的默认模型是它的，都是 ``Conflict``。"""

        async with self._store.edit(provider_id) as editor:
            provider = editor.state.provider
            users = _provider_users(await self._usages.model_references(), provider)
            if users:
                raise Conflict(in_use_message(f"供应商 {provider.name} ", users))
            if editor.defaults:
                names = "、".join(one.model_name for one in editor.defaults)
                raise Conflict(f"{names} 是默认模型，先把默认模型换成别的供应商的再删")
            await editor.delete_provider()

    async def create_credential(
        self, provider_id: uuid.UUID, body: CredentialCreateIn, *, created_by: uuid.UUID
    ) -> CredentialOut:
        """新建一把密钥：按声明校验字段，先试连，通过才保存；供应商的第一把成为默认密钥。"""

        state = await self._state(provider_id)
        declaration = self._declaration_of(state.provider)
        name = clean_credential_name(body.name)
        if any(one.name == name for one in state.credentials):
            raise ValidationFailed("这个供应商下已有同名密钥")
        plain = new_fields(declaration, body.fields)
        await self._require_probe(declaration, state, plain)
        credential_id = uuid.uuid4()
        async with self._store.edit(provider_id) as editor:
            await editor.insert_credential(
                credential_id,
                name=name,
                fields=encrypt_fields(declaration, plain, self._cipher),
                created_by=created_by,
            )
        return await self._credential_out_by_id(provider_id, credential_id)

    async def update_credential(
        self, provider_id: uuid.UUID, credential_id: uuid.UUID, body: CredentialUpdateIn
    ) -> CredentialOut:
        """改名或改字段：给了的字段替换，没给的保持原值；字段真有变化时先试连，通过才保存。"""

        state = await self._state(provider_id)
        declaration = self._declaration_of(state.provider)
        credential = _credential(state, credential_id)
        name = credential.name if body.name is None else clean_credential_name(body.name)
        stored = credential.fields
        if body.fields is not None:
            current = decrypt_fields(declaration, credential.fields, self._cipher)
            plain = merged_fields(declaration, current, body.fields)
            if plain != current:
                await self._require_probe(declaration, state, plain)
                stored = encrypt_fields(declaration, plain, self._cipher)
        async with self._store.edit(provider_id) as editor:
            _ = _credential(editor.state, credential_id)
            await editor.update_credential(credential_id, name=name, fields=stored)
        return await self._credential_out_by_id(provider_id, credential_id)

    async def delete_credential(self, provider_id: uuid.UUID, credential_id: uuid.UUID) -> None:
        """删一把密钥；默认密钥不能删，先换默认（``Conflict``）。某个 agent 的草稿或当前版本显式写着这把
        密钥也是 ``Conflict``。"""

        async with self._store.edit(provider_id) as editor:
            credential = _credential(editor.state, credential_id)
            provider = editor.state.provider
            if provider.default_credential_id == credential_id:
                raise Conflict("这是默认密钥，先把默认密钥换成别的再删")
            users = _credential_users(
                await self._usages.model_references(), provider, credential_id
            )
            if users:
                raise Conflict(in_use_message(f"密钥 {credential.name} ", users))
            await editor.delete_credential(credential_id)

    async def test_credential(self, provider_id: uuid.UUID, body: CredentialTestIn) -> ProbeOut:
        """试连，不保存：已保存的一把、一组新字段，或叠了新字段的已保存的一把（见 ``CredentialTestIn``）。"""

        state = await self._state(provider_id)
        declaration = self._declaration_of(state.provider)
        if body.credential_id is not None:
            credential = _credential(state, body.credential_id)
            plain = decrypt_fields(declaration, credential.fields, self._cipher)
            if body.fields is not None:
                plain = merged_fields(declaration, plain, body.fields)
        elif body.fields is not None:
            plain = new_fields(declaration, body.fields)
        else:
            raise ValidationFailed("credentialId 与 fields 至少给一个")
        return _probe_out(await self._run_probe(declaration, state, plain))

    async def add_model(
        self, provider_id: uuid.UUID, body: CustomModelCreateIn
    ) -> ProviderModelOut:
        """自己加一个模型，启用；声明不允许自己加模型、属性不合格、和已有的同名同类型都是
        ``ValidationFailed``。"""

        async with self._store.edit(provider_id) as editor:
            declaration = self._declaration_of(editor.state.provider)
            if not declaration.custom_models:
                raise ValidationFailed(f"{declaration.label}不能自己加模型")
            spec = custom_model(
                name=body.name,
                model_type=body.type,
                api=body.api,
                context_size=body.context_size,
                thinking=body.thinking,
            )
            models = merge_models(declaration, editor.state.settings)
            if find_model(models, spec.name, spec.type) is not None:
                raise ValidationFailed(f"已经有叫 {spec.name} 的 {spec.type} 模型")
            added = ProviderModel(
                name=spec.name,
                type=spec.type,
                source=SOURCE_CUSTOM,
                properties=spec.properties(),
                enabled=True,
            )
            await editor.put_model(self._setting(added))
            provider = editor.state.provider
        return await self._model_out_with_users(provider, added)

    async def update_model(
        self, provider_id: uuid.UUID, model_type: ModelType, name: str, body: ModelUpdateIn
    ) -> ProviderModelOut:
        """启停一个模型，或改自己加的模型的属性。声明里的模型改属性是 ``ValidationFailed``；停用默认
        模型、或停用某个 agent 的草稿或当前版本还写着的模型是 ``Conflict``。"""

        given = body.model_fields_set
        async with self._store.edit(provider_id) as editor:
            declaration = self._declaration_of(editor.state.provider)
            model = find_model(merge_models(declaration, editor.state.settings), name, model_type)
            if model is None:
                raise NotFound("模型不存在")
            enabled = model.enabled if body.enabled is None else body.enabled
            if model.source == SOURCE_DECLARED:
                if given & _PROPERTY_FIELDS:
                    raise ValidationFailed("声明里的模型只能启用或停用，不能改属性")
                updated = replace(model, enabled=enabled)
            else:
                current = model.properties
                spec = custom_model(
                    name=model.name,
                    model_type=model.type,
                    api=body.api if "api" in given else current.api,
                    context_size=body.context_size
                    if "context_size" in given
                    else current.context_size,
                    thinking=(body.thinking or ()) if "thinking" in given else current.thinking,
                )
                updated = replace(model, properties=spec.properties(), enabled=enabled)
            provider = editor.state.provider
            if model.enabled and not enabled:
                _require_not_default(editor, model)
                await self._require_unused_model(provider, model)
            if updated.source == SOURCE_DECLARED and updated.enabled:
                # 声明里的模型默认启用，重新启用就是去掉那条停用记录。
                await editor.delete_model(updated.name, updated.type)
            else:
                await editor.put_model(self._setting(updated))
        return await self._model_out_with_users(provider, updated)

    async def delete_model(self, provider_id: uuid.UUID, model_type: ModelType, name: str) -> None:
        """删一个自己加的模型。声明里的模型只能停用（``ValidationFailed``）；默认模型、某个 agent 的草稿或
        当前版本还写着的模型不能删（``Conflict``）。"""

        async with self._store.edit(provider_id) as editor:
            declaration = self._declaration_of(editor.state.provider)
            model = find_model(merge_models(declaration, editor.state.settings), name, model_type)
            if model is None:
                raise NotFound("模型不存在")
            if model.source == SOURCE_DECLARED:
                raise ValidationFailed("声明里的模型不能删，只能停用")
            _require_not_default(editor, model)
            await self._require_unused_model(editor.state.provider, model)
            await editor.delete_model(model.name, model.type)

    async def default_models(self) -> DefaultModelsOut:
        return DefaultModelsOut(
            defaults=[_default_out(one) for one in await self._store.default_models()]
        )

    async def set_default_model(
        self, model_type: ModelType, body: DefaultModelIn
    ) -> DefaultModelOut:
        """把某类型的默认模型设成某供应商的一个模型：必须存在、是这个类型、已启用。"""

        if await self._store.state(body.provider_id) is None:
            raise ValidationFailed("供应商不存在")
        async with self._store.edit(body.provider_id) as editor:
            declaration = self._declaration_of(editor.state.provider)
            models = merge_models(declaration, editor.state.settings)
            model = find_model(models, body.model_name, model_type)
            if model is None:
                raise ValidationFailed(
                    f"{editor.state.provider.label}没有叫 {body.model_name} 的 {model_type} 模型"
                )
            if not model.enabled:
                raise ValidationFailed(f"{model.name} 已停用，先启用再设为默认")
            await editor.set_default_model(model_type, model.name)
        (found,) = [one for one in await self._store.default_models() if one.type == model_type]
        return _default_out(found)

    async def _state(self, provider_id: uuid.UUID) -> ProviderState:
        state = await self._store.state(provider_id)
        if state is None:
            raise NotFound("供应商不存在")
        return state

    def _credential_in(self, state: ProviderState, credential_id: uuid.UUID) -> CredentialRecord:
        found = next((one for one in state.credentials if one.id == credential_id), None)
        if found is None:
            raise ValidationFailed("默认密钥必须是这个供应商的密钥")
        return found

    def _declaration_of(self, provider: ProviderRecord) -> ProviderDeclaration:
        return _declaration_named(self._declarations, provider.provider)

    async def _run_probe(
        self, declaration: ProviderDeclaration, state: ProviderState, plain: Mapping[str, str]
    ) -> ProbeResult:
        model = probe_model(merge_models(declaration, state.settings))
        result = await self._probe.probe(declaration, model, plain)
        if not result.ok:
            _logger.info(
                "密钥试连没通过",
                provider=state.provider.name,
                model=model.name,
                reason=result.reason,
            )
        return result

    async def _require_probe(
        self, declaration: ProviderDeclaration, state: ProviderState, plain: Mapping[str, str]
    ) -> None:
        result = await self._run_probe(declaration, state, plain)
        if not result.ok:
            raise ValidationFailed(f"试连没通过：{result.reason}")

    def _setting(self, model: ProviderModel) -> ModelSetting:
        return ModelSetting(
            name=model.name,
            type=model.type,
            source=model.source,
            properties=model.properties if model.source == SOURCE_CUSTOM else None,
            enabled=model.enabled,
        )

    def _credential_out(
        self,
        declaration: ProviderDeclaration,
        provider: ProviderRecord,
        credential: CredentialRecord,
        references: Sequence[ModelReference],
    ) -> CredentialOut:
        plain = decrypt_fields(declaration, credential.fields, self._cipher)
        return CredentialOut(
            id=credential.id,
            name=credential.name,
            fields=masked_fields(declaration, plain),
            used_by=usages_out(_credential_users(references, provider, credential.id)),
            created_at=credential.created_at,
            updated_at=credential.updated_at,
        )

    def _provider_out(
        self, state: ProviderState, references: Sequence[ModelReference]
    ) -> ModelProviderOut:
        declaration = self._declaration_of(state.provider)
        provider = state.provider
        return ModelProviderOut(
            id=provider.id,
            name=provider.name,
            provider=provider.provider,
            label=provider.label,
            enabled=provider.enabled,
            default_credential_id=provider.default_credential_id,
            credentials=[
                self._credential_out(declaration, provider, one, references)
                for one in state.credentials
            ],
            models=[
                _model_out(one, _model_users(references, provider, one))
                for one in merge_models(declaration, state.settings)
            ],
            created_at=provider.created_at,
            updated_at=provider.updated_at,
        )

    async def _provider_out_by_id(self, provider_id: uuid.UUID) -> ModelProviderOut:
        return self._provider_out(
            await self._state(provider_id), await self._usages.model_references()
        )

    async def _credential_out_by_id(
        self, provider_id: uuid.UUID, credential_id: uuid.UUID
    ) -> CredentialOut:
        state = await self._state(provider_id)
        return self._credential_out(
            self._declaration_of(state.provider),
            state.provider,
            _credential(state, credential_id),
            await self._usages.model_references(),
        )

    async def _model_out_with_users(
        self, provider: ProviderRecord, model: ProviderModel
    ) -> ProviderModelOut:
        return _model_out(
            model, _model_users(await self._usages.model_references(), provider, model)
        )

    async def _require_unused_model(self, provider: ProviderRecord, model: ProviderModel) -> None:
        """某个 agent 的草稿或当前版本还写着这个模型就是 ``Conflict``；只被旧版本用到的不拦。"""

        users = _model_users(await self._usages.model_references(), provider, model)
        if users:
            raise Conflict(in_use_message(f"模型 {model.name} ", users))


__all__ = ["ModelProviderService", "rotate_credential_keys"]
