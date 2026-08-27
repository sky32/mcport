# 项目空间与本地访问

## 项目空间是什么

项目空间（Workspace）是一个已注册的本机项目目录。AI 客户端通过项目空间访问文件、代码、Git 和开发命令。

Desktop 侧每个 Workspace 记录：目录路径、启用状态、独立本地端口、公网开关与路径、公网认证方式（oauth/token，默认 oauth）和工具档位（readonly/standard/full，默认 full）。名称由目录名推导，字符集为 `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`。

Runtime 侧的 Workspace 名单来自 Desktop 传入的注册表（`WORKSPACE_REGISTRY_JSON`）与 Workspace 根目录（`WORKSPACE_ROOT`）的并集。

## 本地访问

Desktop 模式下，Runtime 的默认服务监听 `http://127.0.0.1:47877/mcp`（端口被占用时自动顺延）。Runtime 由 Desktop 作为 utilityProcess 托管启动，不提供单独运行入口；smoke 测试和打包流程会直接运行编译产物。默认服务的认证跟随全局设置：本机免 Token（`authMode=none`，仅允许 loopback Host）或 Bearer Token。

此外，每个启用的 Workspace 各有一个独立服务（`workspace:<name>`），从 8788 起分配端口、绑定单一 Workspace，工具调用不需要传 `workspace` 参数。默认服务暴露多个 Workspace 时，工具 schema 要求显式传入 `workspace`。

健康检查端点：本地 `/healthz`，公网 `/w/<workspace>/healthz`，返回服务与 Workspace 就绪状态（Workspace 目录解析失败时返回 503）。

## 文件范围

文件读取、搜索、创建、修改和删除都限制在项目目录内：所有路径先 realpath 解析，再做 Workspace 容器检查；指向外部的符号链接会被拒绝。命令的 `cwd` 同样必须留在 Workspace 内。

## 配置优先级

Runtime 的有效配置按三层合并（`ConfigStore.getEffectiveConfig`）：

1. 环境变量基线（Desktop 注入或 `src/config.ts` 默认值）
2. SQLite 中的全局 Runtime 设置（`settings` 表，`runtime.*` 键）
3. Workspace 绑定的 Runtime Profile 覆盖（`workspace_runtime_profiles` 表；字段为 null 时继承上层）

Desktop 的“运行环境”设置页写全局 Runtime 设置；Workspace 高级设置写该 Workspace 的 Profile。Desktop 侧的路由/偏好（端口、公网、语言、主题等）保存在 Desktop 自己的设置文件中，两份状态由 Desktop 在保存时一起原子化。

## 多项目

多个项目可以同时注册。连接某个项目时，客户端使用对应的本地端点；公网地址使用 `/w/<workspace>/mcp` 区分项目。
