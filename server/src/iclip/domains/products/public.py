from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Protocol

from iclip.domains.products.models import StyleGrouping


class StyleDirectory(Protocol):
    async def resolve(self, style_nos: Sequence[str]) -> Mapping[str, StyleGrouping]: ...


__all__ = ["StyleDirectory", "StyleGrouping"]
