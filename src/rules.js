// 规则按优先级排列，命中第一条即停止。规则集整体不可变：
// 新版本只能新增一条 rule_sets 记录，旧判断引用的 rule_version 永不被改写。
export const DEFAULT_RULESET = {
  version: "v1",
  rules: [
    {
      name: "emergency-signal",
      conditions: [{ field: "emergency", op: "eq", value: true }],
      level: "emergency",
      action: "immediate",
      explanation:
        "你发出的信号显示你可能正面临紧迫的危险，我们已立即通知专业人员介入处理。",
    },
    {
      name: "harm-clue",
      conditions: [{ field: "harm_clue", op: "eq", value: true }],
      level: "harm_clue",
      action: "professional_review",
      explanation:
        "信号中出现了可能与现实伤害有关的线索，心理老师会尽快复核并主动与你联系。",
    },
    {
      name: "active-help-request",
      conditions: [{ field: "kind", op: "eq", value: "help_request" }],
      level: "harm_clue",
      action: "professional_review",
      explanation: "你主动发出了求助，心理老师会尽快与你联系。",
    },
    {
      name: "persistent-isolation",
      conditions: [{ field: "isolation_days", op: "gte", value: 21 }],
      level: "isolation",
      action: "trusted_adult",
      explanation:
        "你已经有较长时间很少与身边的人交流，我们会请一位你信任的成年人来关心你。",
    },
    {
      name: "general-dependence",
      conditions: [
        { field: "consecutive_days", op: "gte", value: 14 },
        { field: "late_night_minutes", op: "gte", value: 60 },
      ],
      level: "dependence",
      action: "self_reminder",
      explanation:
        "你最近连续较多天在深夜长时间使用陪伴功能，系统会提醒你注意休息和作息。",
    },
  ],
};

function matchCondition(condition, context) {
  const actual = context[condition.field];
  if (actual === undefined || actual === null) return false;
  switch (condition.op) {
    case "eq":
      return actual === condition.value;
    case "gte":
      return typeof actual === "number" && actual >= condition.value;
    case "lte":
      return typeof actual === "number" && actual <= condition.value;
    default:
      return false;
  }
}

// context 由事件种类、信号类型、年龄段和脱敏指标组成，不含任何谈话内容。
export function evaluateRules(ruleSetDefinition, context) {
  for (const rule of ruleSetDefinition.rules) {
    if (rule.conditions.every((condition) => matchCondition(condition, context))) {
      return rule;
    }
  }
  return null;
}
