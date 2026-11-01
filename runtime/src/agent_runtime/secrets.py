"""配置里机密值的加密与打码：模型供应商密钥的机密字段与 MCP 服务的请求头共用这一份。

加密用 MultiFernet，key 来自 ``CREDENTIAL_ENCRYPTION_KEYS``：第一个加密，全部用来解密；换钥把密文改用第一个
key。任何接口都只给打码后的值。"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Final

from cryptography.fernet import Fernet, InvalidToken, MultiFernet

MASK: Final = "••••"
MASK_MIN_CHARS: Final = 8
"""原值不足这么多位时只给 ``MASK``，不露末 4 位。"""

_UNREADABLE: Final = "机密值解不开：CREDENTIAL_ENCRYPTION_KEYS 里没有加密它的那个 key，或密文已损坏"


def mask_secret(value: str) -> str:
    """机密值返回给人看的样子：``••••`` 加末 4 位；原值不足 8 位只给 ``••••``。"""

    if len(value) < MASK_MIN_CHARS:
        return MASK
    return MASK + value[-4:]


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
            raise RuntimeError(_UNREADABLE) from None

    def rotate(self, token: str) -> str:
        """同一个明文改用第一个 key 重新加密；解不开同 ``decrypt``。"""

        try:
            return self._fernet.rotate(token.encode()).decode()
        except InvalidToken:
            raise RuntimeError(_UNREADABLE) from None


__all__ = ["MASK", "MASK_MIN_CHARS", "CredentialCipher", "mask_secret"]
