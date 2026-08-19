# PWA 插件运行时扩展能力评估

## 一、核心机制
1. Code Mode（run_code）：模型写 TS/Python 程序作 async 函数体执行；工具以 `tools` 全局命名空间注入，每个可见工具自动 `await tools.<name>(args)`，复用完整执行流水线。参数/返回值须无损 JSON；结果含 value/logs/error 字段，错误不 reject。每次运行无状态隔离（明确拒绝持久 REPL）；仅外层 logs/result 受 64MiB 上限与 spill，中间值无字节上限。
2. 持久终端：`ctx.terminals` 管理按精确 owner Agent 授权的 PTY 会话（spawn/send/read/signal/kill），同一时刻单活动 send，waitReason 与 shell 存活解耦；会话在工具/后端重载间存活，可跨调用保留长驻进程。
3. LSP：`ctx.lsp` 暴露四个闭合操作（定义/引用/实现/hover），provider 按扩展名自动选择，无 JSON-RPC 逃生口，仅代码语义导航。
4. extensions：`cordis_define` 定义/追加不可变 Package（host+client 源码）不执行；`cordis_run` 激活（run/update）可能需审批；cordis_inspect_* 查运行时元数据。插件会话所有、版本化、沙箱受限。

## 二、PWA 优化方向
1. 灵活分析替代固定工具（高）：拟合后画图/算分波统计/批处理，模型用 run_code 写 TS `await tools.read/grep(...)`+纯计算，免专用绘图工具。
2. ctpwa 交互式会话用持久终端（高）：terminal_open 起 python 预 import ctpwa 加载模型，多次 send 查询同一 analysis 实例，免重复加载。
3. 迭代 API 用 cordis_define（中）：作者/模型临时定义插件挂 Service 试新接口，不重启 DSH，稳定后固化回 pwa 包。
4. LSP 导航拟合代码（低）：为 C++/Fortran 拟合源注册 LSP，定位共振参数与拟合函数定义。

## 三、特别评估
(a) 可部分替代：run_code 能组合 pwa_* 与底层函数做一次性灵活分析。边界：每轮无状态、仅无损 JSON、失败只给 toolName+message 无内部错误码、无长驻进程/持久内核、不适配二进制大对象，故高频/强校验/有副作用/长驻的操作仍应留作工具。
(b) 价值高：持久终端保持 ctpwa python 会话加载，拟合前预载模型、多次查询同一实例，避免重复初始化；注意单 send 串行、输出走工具结果持久化，长输出需 read 分页。
(c) 价值高但偏原型：cordis_define 让作者/模型运行时定义版本化插件、沙箱内 run，可快速迭代 API 不重启 DSH，失败可 inspect_self 读诊断后追加 Package 重试。局限：沙箱能力受限（web/bash 需查询授权）、需审批、Package 不可变需版本管理，正式 API 应固化回插件包。
