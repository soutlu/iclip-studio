"""插件层：我们自己定义的工具集，连接 harness 与领域服务，业务规则由 domains 持有。

插件之间不直接依赖；共享设施通过平台协议注入，组合根统一提供实例。
插件约定在 base.py，登记在 app/plugin_registry.py。"""
