"""机密字段的加密：往返、换钥后旧密文仍能读、换钥后的密文用的是新 key，以及打码的长度边界。"""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet

from iclip.domains.model_providers.cipher import CredentialCipher
from iclip.domains.model_providers.models import mask_secret

OLD = Fernet.generate_key().decode()
NEW = Fernet.generate_key().decode()


def test_encrypt_then_decrypt_round_trips_and_hides_the_plaintext() -> None:
    cipher = CredentialCipher([OLD])

    token = cipher.encrypt("sk-secret-value")

    assert "sk-secret-value" not in token
    assert cipher.decrypt(token) == "sk-secret-value"


def test_after_adding_a_new_first_key_old_tokens_still_decrypt() -> None:
    old_token = CredentialCipher([OLD]).encrypt("sk-secret-value")

    assert CredentialCipher([NEW, OLD]).decrypt(old_token) == "sk-secret-value"


def test_rotated_tokens_are_encrypted_with_the_new_key_only() -> None:
    old_token = CredentialCipher([OLD]).encrypt("sk-secret-value")

    rotated = CredentialCipher([NEW, OLD]).rotate(old_token)

    assert CredentialCipher([NEW]).decrypt(rotated) == "sk-secret-value"
    with pytest.raises(RuntimeError, match="CREDENTIAL_ENCRYPTION_KEYS"):
        CredentialCipher([OLD]).decrypt(rotated)


def test_new_tokens_use_the_first_key() -> None:
    token = CredentialCipher([NEW, OLD]).encrypt("sk-secret-value")

    assert CredentialCipher([NEW]).decrypt(token) == "sk-secret-value"


def test_a_token_from_a_removed_key_fails_loudly() -> None:
    token = CredentialCipher([OLD]).encrypt("sk-secret-value")

    with pytest.raises(RuntimeError, match="解不开"):
        CredentialCipher([NEW]).decrypt(token)


@pytest.mark.parametrize(
    ("value", "masked"),
    [("", "••••"), ("1234567", "••••"), ("12345678", "••••5678"), ("sk-abcdefghij", "••••ghij")],
)
def test_masking_shows_the_last_four_only_from_eight_characters(value: str, masked: str) -> None:
    assert mask_secret(value) == masked
