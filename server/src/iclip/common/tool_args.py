"""模型面工具入参的归一化，各能力包共用。"""

from __future__ import annotations

import json
from typing import Final

import structlog
from pydantic import BeforeValidator, ValidationInfo

_logger = structlog.stdlib.get_logger(__name__)

REPLAY_CONTEXT: Final = {"tool_args_replay": True}
"""重放已收到的工具入参时传给 ``validate_*`` 的 context（如由入参画工具卡）：照常还原，不再记日志。

日志用来统计模型把结构裹成字符串的次数，一次调用只该记一次。"""


def parse_json_text(value: object, info: ValidationInfo) -> object:
    """模型把对象或数组整体序列化成字符串时先还原再校验；不是字符串原样放行。

    解析失败抛出的 ValueError 由 pydantic 收成普通校验错误退回模型。"""

    if not isinstance(value, str):
        return value
    if info.context != REPLAY_CONTEXT:
        _logger.warning("工具参数以字符串传入，已解析", field=info.field_name)
    return json.loads(value)


JsonText = BeforeValidator(parse_json_text)
"""挂在对象或数组类型的工具入参上：模型有一定概率把它裹成一个 JSON 字符串传进来。"""
