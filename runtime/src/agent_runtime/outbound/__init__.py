"""出网：只连得到公网的 httpx 客户端（建在 httpx-secure 上）与探地址。

规则见 ``guard``，探地址见 ``probe``；插件的提交点检查经 ``agent_runtime.harness.media_check`` 用它们。
"""
