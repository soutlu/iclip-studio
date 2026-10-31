"""视频拆解结果的协议约束：文档与失败原因必须恰好提供一个。"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from iclip_video.video_breakdown.wire import ReferenceBreakdownResult


@pytest.mark.parametrize("body", [{}, {"document": "d", "failed": {"reason": "timeout"}}])
def test_a_breakdown_result_has_exactly_one_of_the_two(body: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        ReferenceBreakdownResult.model_validate(body)
