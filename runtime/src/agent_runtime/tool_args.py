from __future__ import annotations

import json
from typing import Final

import structlog
from pydantic import BeforeValidator, ValidationInfo

_logger = structlog.stdlib.get_logger(__name__)

REPLAY_CONTEXT: Final = {"tool_args_replay": True}


def parse_json_text(value: object, info: ValidationInfo) -> object:
    if not isinstance(value, str):
        return value
    if info.context != REPLAY_CONTEXT:
        _logger.warning("工具参数以字符串传入，已解析", field=info.field_name)
    return json.loads(value)


JsonText = BeforeValidator(parse_json_text)
