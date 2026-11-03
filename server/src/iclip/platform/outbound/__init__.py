"""出网：只连得到公网的 httpx 客户端（建在 httpx-secure 上）、下载器与媒体地址检查。

规则见 ``guard``；取字节与探地址用 ``fetch.PublicFetcher``，流式读大文件用 ``guard.public_client``
建的客户端；制作页的地址检查见 ``media_check``。
"""
