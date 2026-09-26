# 领域约定

未成年人智能陪伴安全桥围绕同意关系、风险信号与人工介入保存可核对的业务记录。外部主体使用不含真实身份信息的稳定引用编号，时间采用带偏移量的 ISO 8601 字符串，材料只保存受控引用和 `sha256` 摘要。

交换事件包含 `event_id`、`subject_ref`、`occurred_at`、`source_sequence` 和 `payload_digest`。来源序号只在同一来源内递增，接收方必须保留原始发生时间，不得用到达时间覆盖。示例内容仅用于说明字段形状，不代表真实人员、机构或业务结论。

## 接收边界

服务只接受本地处理后的结果：`kind` 限于 `risk_signal`、`usage`、`help_request`，`metrics` 只含登记的数值或布尔指标（如 `consecutive_days`、`isolation_days`、`harm_clue`、`emergency`）。任何可能还原谈话的字段（如 `content`、`transcript`、`message`）一律拒绝入库。同一信号重复上报（同 `event_id`，或同 `subject_ref` + `signal_type` + `payload_digest` + `occurred_at`）只产生一次事件与一次判断。

## 分级与处置

规则集按版本整体冻结，旧判断引用的 `rule_version` 永不改写。等级与处置一一对应：`dependence` → `self_reminder`（自我提醒），`isolation` → `trusted_adult`（可信成年人），`harm_clue` → `professional_review`（专业人员复核），`emergency` → `immediate`（即时处置）。每条判断附学生可读懂的 `explanation`。

## 同意与撤回

同意记录按年龄段（`under_14` / `14_to_16` / `16_to_18`）与监护关系登记。撤回授权后常规信号直接丢弃（只留审计痕迹），但紧急信号与学生主动求助仍按法律与既定策略受理；已经触发的未结紧急事件不随数据删除中断。

## 可见性与留痕

心理人员、监护人、教师、学生看到的案件字段各不相同，监护人与学生只能访问与自身关联的记录。每次查看生成披露回执（字段清单 + 内容摘要），复核者可凭 `/cases/{id}/proof` 证明一次升级未暴露多余内容；所有允许与拒绝的访问都写入哈希链审计日志，可整体校验完整性。删除申请按步骤推进并可查询进度，回执与审计日志因不含谈话内容而按策略保留。
