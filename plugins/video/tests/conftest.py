from __future__ import annotations

from pathlib import Path

import pytest

from tests.helpers.media_probe import ScriptedMedia

TESTS_ROOT = Path(__file__).parent
LAYERS = ("unit", "integration_no_llm", "integration_llm", "e2e_full")


@pytest.fixture(autouse=True)
def media(monkeypatch: pytest.MonkeyPatch) -> ScriptedMedia:
    scripted = ScriptedMedia()
    scripted.install(monkeypatch)
    return scripted


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    for item in items:
        try:
            rel = Path(item.path).relative_to(TESTS_ROOT)
        except ValueError:
            continue
        layer = rel.parts[0] if rel.parts else ""
        if layer in LAYERS:
            item.add_marker(getattr(pytest.mark, layer))
