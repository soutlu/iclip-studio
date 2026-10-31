"""机密字段的加密：明文隐藏、首钥加密、缺钥报错与打码长度边界。"""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet

from agent_runtime.config.model_providers.cipher import CredentialCipher
from agent_runtime.config.model_providers.models import mask_secret

OLD = Fernet.generate_key().decode()
NEW = Fernet.generate_key().decode()


def test_encrypt_then_decrypt_round_trips_and_hides_the_plaintext() -> None:
    cipher = CredentialCipher([OLD])

    token = cipher.encrypt("sk-secret-value")

    assert "sk-secret-value" not in token
    assert cipher.decrypt(token) == "sk-secret-value"


def test_new_tokens_use_the_first_key() -> None:
    token = CredentialCipher([NEW, OLD]).encrypt("sk-secret-value")

    assert CredentialCipher([NEW]).decrypt(token) == "sk-secret-value"


def test_a_token_from_a_removed_key_fails_loudly() -> None:
    token = CredentialCipher([OLD]).encrypt("sk-secret-value")

    with pytest.raises(RuntimeError, match="解不开：CREDENTIAL_ENCRYPTION_KEYS"):
        CredentialCipher([NEW]).decrypt(token)


@pytest.mark.parametrize(
    ("value", "masked"),
    [("", "••••"), ("1234567", "••••"), ("12345678", "••••5678"), ("sk-abcdefghij", "••••ghij")],
)
def test_masking_shows_the_last_four_only_from_eight_characters(value: str, masked: str) -> None:
    assert mask_secret(value) == masked
