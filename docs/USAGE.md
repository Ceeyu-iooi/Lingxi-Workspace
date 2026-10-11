# 用量来源及限制

Codex从明确登记的sessions与archived_sessions核验原始token_count证据；累计值不是单次消费，缓存和推理子集不得重复相加。ZCode从可读数据库与日志采集，Harness 逐帧解码 JSONL / 拼接 Zstandard 会话日志，只保留最小用量证据。

供应商接入包括DeepSeek、GLM、OpenRouter、New API、Sub2API、硅基流动、Moonshot、MiniMax及自定义余额能力。可用的余额、账单、请求明细和历史Token能力不同；普通Key没有历史接口时显示未知，不能通过余额推算Token。

模型、日期、服务商与Key筛选作用于已采集证据；账户级余额和Key级请求分别展示。相同Key及重复响应去重，账户身份不明确时不合并余额。

Codex 参考计价使用ModelRadar当日原币文本Token规则，历史汇率来自加拿大央行USD/CAD与CNY/CAD交叉换算。缺价、缺分项、复杂计费或历史边界不明确时保持未知。Decimal金额与证据关联消费ID，双币种结果受同一筛选管辖。

参考计价不代表订阅实付或供应商扣费。详细记账约定见根目录TOKEN_ACCOUNTING.md；可选提示词AI调用仅在用户点击后发生。

DeepSeek Key 导入后查询余额。点击“一键获取历史用量”可复用已有平台授权；没有有效授权时在独立官方窗口登录，成功后自动匹配对应 Key 并同步。无需复制 cURL。历史按平台返回的粒度展示，不能冒充逐次请求或与 Harness 本地日志叠加。

Codex 首次开启参考计价时准备价格和汇率；以后开关只读取缓存，关闭后图表仍能查看缓存费用。左侧刷新按钮更新缺失或变化的证据，并重算受影响消费。ZCode 和 Harness 的真实 Token 继续保留，参考计价已移除。
