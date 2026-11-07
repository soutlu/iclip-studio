from __future__ import annotations

from collections.abc import Sequence
from typing import Final

from cryptography.fernet import Fernet, InvalidToken, MultiFernet

MASK: Final = "••••"
MASK_MIN_CHARS: Final = 8

_UNREADABLE: Final = "机密值解不开：CREDENTIAL_ENCRYPTION_KEYS 里没有加密它的那个 key，或密文已损坏"


def mask_secret(value: str) -> str:
    if len(value) < MASK_MIN_CHARS:
        return MASK
    return MASK + value[-4:]


class CredentialCipher:
    def __init__(self, keys: Sequence[str]) -> None:
        if not keys:
            raise ValueError("至少要一个 Fernet key")
        self._fernet = MultiFernet([Fernet(key) for key in keys])

    def encrypt(self, plaintext: str) -> str:
        return self._fernet.encrypt(plaintext.encode()).decode()

    def decrypt(self, token: str) -> str:
        try:
            return self._fernet.decrypt(token.encode()).decode()
        except InvalidToken:
            raise RuntimeError(_UNREADABLE) from None

    def rotate(self, token: str) -> str:
        try:
            return self._fernet.rotate(token.encode()).decode()
        except InvalidToken:
            raise RuntimeError(_UNREADABLE) from None


__all__ = ["MASK", "MASK_MIN_CHARS", "CredentialCipher", "mask_secret"]
