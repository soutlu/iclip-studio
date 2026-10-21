"""资料库打标的组合根适配：把 tagging 声明的两个端口接到方舟 Responses 接口与各库的文字上。

打标是一次纯文本调用。输出约束按当前标签树里 ``auto_fill = ai`` 的维度现拼：每个维度是字段
``d1…dn``，名字与说明放在 JSON Schema 中；有小类的维度按大类组织选项，其余维度直接选名字。
``parse_tag_answer`` 校验输出并换成标签 id。"""

from __future__ import annotations

import json
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

import httpx

from iclip.app.conversation_same_style import TREATMENT_PATH
from iclip.capabilities.video_breakdown.model import ArkBreakdownModel
from iclip.capabilities.video_breakdown.ports import BreakdownError
from iclip.capabilities.workspace.scope import namespace_for
from iclip.config import ResolvedIclipStudio
from iclip.domains.library.repository import LibraryReports
from iclip.domains.references.repository import ReferenceStore
from iclip.domains.tagging.models import (
    ERROR_MODEL_CALL_FAILED,
    ERROR_MODEL_FAILED,
    KIND_REFERENCE,
    EntryKey,
    TaggingFailed,
    TagNode,
)
from iclip.platform.file_store.store import FileStore

TAG_REASONING_EFFORT: Final = "low"

TAG_MAX_OUTPUT_TOKENS: Final = 8_192
"""含思考的输出上限。实测思考强度 low 时一次约 2200 个，给到约四倍，避免答到一半被截断。"""

TAG_TIMEOUT_SECONDS: Final = 180.0
"""打标的总超时，短于打标中的超时收尾。"""

_INTRO: Final = (
    "你会拿到一段描述一条视频的文字。按文字给视频打标签，只用文字里写到的内容，没写的不要猜。\n"
    "根据 JSON Schema 中各维度、标签及其说明选择。每个维度都可以选多个，也可以一个都不选。"
)

_HIERARCHY_DESCRIPTION: Final = (
    "每个对象表示一个选中的大类，subcategories表示该大类下选中的小类，可多选或为空。"
)


@dataclass(frozen=True, slots=True)
class TagRequest:
    """一次打标的请求与解析依据，按当时的 AI 维度现拼。"""

    system_prompt: str
    text_format: dict[str, Any]
    choices: Mapping[str, Mapping[str, TagNode]]
    """每个字段（``d1``…）里能填的名字与它对应的节点。"""
    groups: Mapping[str, Mapping[str, TagNode]]
    """有小类的字段及其可选大类；各大类的 children 限定可选小类。"""
    parents: Mapping[uuid.UUID, uuid.UUID | None]
    """这些维度里每个节点的上级。"""


def _choice(node: TagNode) -> dict[str, Any]:
    schema: dict[str, Any] = {"type": "string", "enum": [node.name]}
    if node.guide:
        schema["description"] = node.guide
    return schema


def _choice_array(nodes: Sequence[TagNode]) -> dict[str, Any]:
    if not nodes:
        return {"type": "array", "items": {"type": "string"}, "maxItems": 0}
    items = (
        {"anyOf": [_choice(node) for node in nodes]}
        if any(node.guide for node in nodes)
        else {"type": "string", "enum": [node.name for node in nodes]}
    )
    return {"type": "array", "items": items}


def _group(node: TagNode) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {"category": _choice(node), "subcategories": _choice_array(node.children)},
        "required": ["category", "subcategories"],
        "additionalProperties": False,
    }


def build_tag_request(dimensions: Sequence[TagNode]) -> TagRequest:
    """``dimensions`` 是 AI 维度，按给的先后编成 ``d1…dn``。同一维度里名字重复说明标签树坏了，直接
    抛 ``RuntimeError``。"""

    properties: dict[str, Any] = {}
    choices: dict[str, dict[str, TagNode]] = {}
    groups: dict[str, dict[str, TagNode]] = {}
    parents: dict[uuid.UUID, uuid.UUID | None] = {}
    for index, dimension in enumerate(dimensions, start=1):
        key = f"d{index}"
        named: dict[str, TagNode] = {}
        for node in dimension.descendants():
            if node.name in named:
                raise RuntimeError(f"维度「{dimension.name}」里有两个「{node.name}」")
            named[node.name] = node
            parents[node.id] = node.parent_id
        description = dimension.name + (f"：{dimension.guide}" if dimension.guide else "")
        if any(node.children for node in dimension.children):
            groups[key] = {node.name: node for node in dimension.children}
            properties[key] = {
                "type": "array",
                "items": {"anyOf": [_group(node) for node in dimension.children]},
            }
            description = f"{description.rstrip('。')}。{_HIERARCHY_DESCRIPTION}"
        else:
            properties[key] = _choice_array(dimension.children)
        properties[key]["description"] = description
        choices[key] = named
    return TagRequest(
        system_prompt=_INTRO,
        text_format={
            "type": "json_schema",
            "name": "library_tags",
            "strict": True,
            "schema": {
                "type": "object",
                "properties": properties,
                "required": list(properties),
                "additionalProperties": False,
            },
        },
        choices=choices,
        groups=groups,
        parents=parents,
    )


def _selected_node(value: object, named: Mapping[str, TagNode], key: str) -> TagNode:
    node = named.get(value) if isinstance(value, str) else None
    if node is None:
        raise TaggingFailed(f"打标输出的 {key} 有清单外的值", code=ERROR_MODEL_FAILED)
    return node


def _selected_group(value: object, groups: Mapping[str, TagNode], key: str) -> tuple[TagNode, ...]:
    if not isinstance(value, dict) or set(value) != {"category", "subcategories"}:
        raise TaggingFailed(f"打标输出的 {key} 大类对象字段不对", code=ERROR_MODEL_FAILED)
    category = _selected_node(value["category"], groups, key)
    subcategories = value["subcategories"]
    if not isinstance(subcategories, list):
        raise TaggingFailed(f"打标输出的 {key} 小类不是数组", code=ERROR_MODEL_FAILED)
    children = {node.name: node for node in category.children}
    return (category, *(_selected_node(child, children, key) for child in subcategories))


def _ancestors(tag_id: uuid.UUID, parents: Mapping[uuid.UUID, uuid.UUID | None]) -> set[uuid.UUID]:
    found: set[uuid.UUID] = set()
    current = parents.get(tag_id)
    while current is not None and current in parents:
        found.add(current)
        current = parents.get(current)
    return found


def parse_tag_answer(raw: str, request: TagRequest) -> tuple[uuid.UUID, ...]:
    """校验字段、候选名字及父子关系，错误抛 ``TaggingFailed``（``model_failed``），不静默丢弃。
    名字换成 id 并去重，按持久化约定归一化祖先；按字段与作答的先后排。"""

    try:
        answer = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise TaggingFailed(f"打标输出不是 JSON：{exc.msg}", code=ERROR_MODEL_FAILED) from exc
    if not isinstance(answer, dict) or set(answer) != set(request.choices):
        raise TaggingFailed("打标输出的字段不对", code=ERROR_MODEL_FAILED)
    chosen: dict[uuid.UUID, None] = {}
    for key, named in request.choices.items():
        values = answer[key]
        if not isinstance(values, list):
            raise TaggingFailed(f"打标输出的 {key} 不是数组", code=ERROR_MODEL_FAILED)
        for value in values:
            nodes = (
                _selected_group(value, request.groups[key], key)
                if key in request.groups
                else (_selected_node(value, named, key),)
            )
            for node in nodes:
                chosen[node.id] = None
    covered: set[uuid.UUID] = set()
    for tag_id in chosen:
        covered |= _ancestors(tag_id, request.parents)
    return tuple(tag_id for tag_id in chosen if tag_id not in covered)


class ArkTagger:
    """``Tagger`` 的实现：一次方舟纯文本调用加 ``parse_tag_answer``。"""

    def __init__(self, model: ArkBreakdownModel) -> None:
        self._model = model

    async def tag(self, text: str, dimensions: Sequence[TagNode]) -> tuple[uuid.UUID, ...]:
        request = build_tag_request(dimensions)
        try:
            raw = await self._model.ask_text(
                request.system_prompt,
                text,
                reasoning_effort=TAG_REASONING_EFFORT,
                max_output_tokens=TAG_MAX_OUTPUT_TOKENS,
                text_format=request.text_format,
                timeout=TAG_TIMEOUT_SECONDS,
            )
        except BreakdownError as exc:
            # 可重试的（限流、服务端错、连不上、答得不完整）再打可能就好；被拒与等满总超时不会。
            code = ERROR_MODEL_CALL_FAILED if exc.retryable else ERROR_MODEL_FAILED
            raise TaggingFailed(str(exc), code=code) from exc
        return parse_tag_answer(raw, request)


class HitCaseTreatments:
    """爆款素材的新片执行方案：素材片所在对话（按对话属主与对话 id 定位）工作区里的 ``treatment.md``。
    只读当前那一份，不存快照。"""

    def __init__(self, store: FileStore) -> None:
        self._store = store

    async def exists(self, owner: uuid.UUID, conversation_id: uuid.UUID) -> bool:
        """那段对话的工作区里有没有这份文件；空文件也算有。"""

        entries = await self._store.entries(
            namespace_for(owner, str(conversation_id)), prefix=TREATMENT_PATH
        )
        return any(entry.path == TREATMENT_PATH for entry in entries)

    async def text(self, owner: uuid.UUID, conversation_id: uuid.UUID) -> str | None:
        """这份文件的内容；没有或只有空白给 ``None``。"""

        stored = await self._store.read(namespace_for(owner, str(conversation_id)), TREATMENT_PATH)
        if stored is None or not stored.content.strip():
            return None
        return stored.content


class LibrarySourceText:
    """``SourceText`` 的实现：灵感库的条目读参考视频当前的拆解；爆款素材读它所在对话当前的新片执行
    方案，不挂对话或对话不存在时没有文字。"""

    def __init__(
        self,
        references: ReferenceStore,
        *,
        library: LibraryReports,
        treatments: HitCaseTreatments,
    ) -> None:
        self._references = references
        self._library = library
        self._treatments = treatments

    async def text(self, key: EntryKey) -> str | None:
        if key.kind == KIND_REFERENCE:
            row = await self._references.get(key.subject_id)
            return None if row is None else row.document
        source = await self._library.material_of(key.subject_id)
        if source is None or source.conversation_owner is None or source.conversation_id is None:
            return None
        return await self._treatments.text(source.conversation_owner, source.conversation_id)


def build_library_tagger(settings: ResolvedIclipStudio, client: httpx.AsyncClient) -> ArkTagger:
    """按 ``iclip_studio`` 的配置建打标；HTTP 连接池与组合根共用，模型与拆解是同一个。"""

    return ArkTagger(
        ArkBreakdownModel(
            client,
            url=settings.breakdown_url,
            api_key=settings.breakdown_api_key,
            model=settings.breakdown_model,
        )
    )


__all__ = [
    "TAG_MAX_OUTPUT_TOKENS",
    "TAG_REASONING_EFFORT",
    "TAG_TIMEOUT_SECONDS",
    "ArkTagger",
    "HitCaseTreatments",
    "LibrarySourceText",
    "TagRequest",
    "build_library_tagger",
    "build_tag_request",
    "parse_tag_answer",
]
