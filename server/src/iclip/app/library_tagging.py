from __future__ import annotations

import json
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

from agent_runtime.client import RuntimeClient
from agent_runtime.file_store.namespace import namespace_for

from iclip.app.conversation_same_style import TREATMENT_PATH
from iclip.app.runtime_workspace import WorkspaceFiles
from iclip.domains.library.repository import LibraryReports
from iclip.domains.references.repository import ReferenceStore
from iclip.domains.tagging.models import (
    ERROR_MODEL_CALL_FAILED,
    ERROR_MODEL_FAILED,
    ERROR_MODEL_UNAVAILABLE,
    KIND_REFERENCE,
    EntryKey,
    TaggingFailed,
    TagNode,
)
from iclip.platform.video_breakdown.model import ArkBreakdownModel
from iclip.platform.video_breakdown.ports import BreakdownError, BreakdownModelUnavailable

TAG_MODEL: Final = "doubao-seed-2-1-lite-260915"

TAG_REASONING_EFFORT: Final = "low"

TAG_MAX_OUTPUT_TOKENS: Final = 8_192

TAG_TIMEOUT_SECONDS: Final = 180.0

_INTRO: Final = (
    "你会拿到一段描述一条视频的文字。按文字给视频打标签，只用文字里写到的内容，没写的不要猜。\n"
    "根据 JSON Schema 中各维度、标签及其说明选择。每个维度都可以选多个，也可以一个都不选。"
)

_HIERARCHY_DESCRIPTION: Final = (
    "每个对象表示一个选中的标签，subcategories表示它的直接下级选择。"
    "下级仍有子标签时继续使用同样的对象结构，各层都可多选或为空。"
)


@dataclass(frozen=True, slots=True)
class TagRequest:
    system_prompt: str
    text_format: dict[str, Any]
    choices: Mapping[str, Mapping[str, TagNode]]
    groups: Mapping[str, Mapping[str, TagNode]]
    parents: Mapping[uuid.UUID, uuid.UUID | None]


def _choice(node: TagNode) -> dict[str, Any]:
    schema: dict[str, Any] = {"type": "string", "enum": [node.name]}
    if node.guide:
        schema["description"] = node.guide
    return schema


def _choice_array(nodes: Sequence[TagNode]) -> dict[str, Any]:
    if not nodes:
        return {"type": "array", "items": {"type": "string"}, "maxItems": 0}
    if any(node.children for node in nodes):
        items = {"anyOf": [_group(node) for node in nodes]}
    elif any(node.guide for node in nodes):
        items = {"anyOf": [_choice(node) for node in nodes]}
    else:
        items = {"type": "string", "enum": [node.name for node in nodes]}
    return {"type": "array", "items": items}


def _group(node: TagNode) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {"category": _choice(node), "subcategories": _choice_array(node.children)},
        "required": ["category", "subcategories"],
        "additionalProperties": False,
    }


def build_tag_request(dimensions: Sequence[TagNode]) -> TagRequest:
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
        properties[key] = _choice_array(dimension.children)
        if any(node.children for node in dimension.children):
            groups[key] = {node.name: node for node in dimension.children}
            description = f"{description.rstrip('。')}。{_HIERARCHY_DESCRIPTION}"
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
        raise TaggingFailed(f"打标输出的 {key} 标签对象字段不对", code=ERROR_MODEL_FAILED)
    category = _selected_node(value["category"], groups, key)
    subcategories = value["subcategories"]
    if not isinstance(subcategories, list):
        raise TaggingFailed(f"打标输出的 {key} 下级不是数组", code=ERROR_MODEL_FAILED)
    children = {node.name: node for node in category.children}
    nested = any(node.children for node in category.children)
    selected = [category]
    for child in subcategories:
        if nested:
            selected.extend(_selected_group(child, children, key))
        else:
            selected.append(_selected_node(child, children, key))
    return tuple(selected)


def _ancestors(tag_id: uuid.UUID, parents: Mapping[uuid.UUID, uuid.UUID | None]) -> set[uuid.UUID]:
    found: set[uuid.UUID] = set()
    current = parents.get(tag_id)
    while current is not None and current in parents:
        found.add(current)
        current = parents.get(current)
    return found


def parse_tag_answer(raw: str, request: TagRequest) -> tuple[uuid.UUID, ...]:
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
        except BreakdownModelUnavailable as exc:
            raise TaggingFailed(str(exc), code=ERROR_MODEL_UNAVAILABLE) from exc
        except BreakdownError as exc:
            code = ERROR_MODEL_CALL_FAILED if exc.retryable else ERROR_MODEL_FAILED
            raise TaggingFailed(str(exc), code=code) from exc
        return parse_tag_answer(raw, request)


class HitCaseTreatments:
    def __init__(self, store: WorkspaceFiles) -> None:
        self._store = store

    async def exists(self, owner: uuid.UUID, conversation_id: uuid.UUID) -> bool:
        entries = await self._store.entries(
            namespace_for(owner, str(conversation_id)), prefix=TREATMENT_PATH
        )
        return any(entry.path == TREATMENT_PATH for entry in entries)

    async def text(self, owner: uuid.UUID, conversation_id: uuid.UUID) -> str | None:
        stored = await self._store.read(namespace_for(owner, str(conversation_id)), TREATMENT_PATH)
        if stored is None or not stored.content.strip():
            return None
        return stored.content


class LibrarySourceText:
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


def build_library_tagger(runtime: RuntimeClient) -> ArkTagger:
    return ArkTagger(ArkBreakdownModel(runtime, model=TAG_MODEL))


__all__ = [
    "TAG_MAX_OUTPUT_TOKENS",
    "TAG_MODEL",
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
