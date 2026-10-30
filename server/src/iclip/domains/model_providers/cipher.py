"""密钥里机密字段的加密：MultiFernet，第一个 key 加密，全部 key 用来解密；换钥把密文改用第一个 key。"""

from __future__ import annotations

from collections.abc import Sequence

from cryptography.fernet import Fernet, InvalidToken, MultiFernet


class CredentialCipher:
    """``keys`` 是启动时校验过的 Fernet key，至少一个。"""

    def __init__(self, keys: Sequence[str]) -> None:
        if not keys:
            raise ValueError("至少要一个 Fernet key")
        self._fernet = MultiFernet([Fernet(key) for key in keys])

    def encrypt(self, plaintext: str) -> str:
        return self._fernet.encrypt(plaintext.encode()).decode()

    def decrypt(self, token: str) -> str:
        """解不开说明加密它的 key 已不在钥匙串里，或密文坏了：抛 ``RuntimeError``，不当空值继续。"""

        try:
            return self._fernet.decrypt(token.encode()).decode()
        except InvalidToken:
            raise RuntimeError(
                "密钥的机密字段解不开：CREDENTIAL_ENCRYPTION_KEYS 里没有加密它的那个 key，或密文已损坏"
            ) from None

    def rotate(self, token: str) -> str:
        """同一个明文改用第一个 key 重新加密；解不开同 ``decrypt``。"""

        try:
            return self._fernet.rotate(token.encode()).decode()
        except InvalidToken:
            raise RuntimeError(
                "密钥的机密字段解不开：CREDENTIAL_ENCRYPTION_KEYS 里没有加密它的那个 key，或密文已损坏"
            ) from None


__all__ = ["CredentialCipher"]
