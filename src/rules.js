// 版本化规则引擎：纯函数，不读写数据库。
// 每次规则调整必须新建一个版本对象并在 RULES 注册表追加；历史版本保留，
// 事件与每次评估快照都记录 rule_version，新版本永远不改写旧判断。

import { REASON_TEXT } from "./config.js";

export const CURRENT_RULE_VERSION = "bridge-rules-2026-09-01-v1";

const v1 = {
  version: CURRENT_RULE_VERSION,
  evaluate(type, f) {
    switch (type) {
      case "usage_dependency": {
        const reasons = [];
        if (f.daily_minutes >= 180) reasons.push({ code: "dep_time", text: REASON_TEXT.dep_time });
        if (f.dependency_score >= 0.7) reasons.push({ code: "dep_score", text: REASON_TEXT.dep_score });
        if (reasons.length === 0) return null;
        return {
          level: 1,
          confidence: roundConfidence(0.45 + f.dependency_score * 0.4 + (f.daily_minutes >= 240 ? 0.1 : 0)),
          reasons,
        };
      }
      case "social_isolation": {
        const reasons = [];
        if (f.isolation_days >= 7) reasons.push({ code: "iso_days", text: REASON_TEXT.iso_days });
        if (f.isolation_score >= 0.6) reasons.push({ code: "iso_score", text: REASON_TEXT.iso_score });
        if (reasons.length === 0) return null;
        // 孤立超过 21 天或评分很高时升级到需要可信成年人介入。
        const level = f.isolation_days >= 21 || f.isolation_score >= 0.85 ? 2 : 1;
        return {
          level,
          confidence: roundConfidence(0.4 + f.isolation_score * 0.45 + (f.isolation_days >= 21 ? 0.1 : 0)),
          reasons,
        };
      }
      case "harm_cue": {
        const reasons = [{ code: "harm_present", text: REASON_TEXT.harm_present }];
        const specific = f.specificity === "plan" || f.specificity === "attempt" || f.specificity === "means";
        if (specific) reasons.push({ code: "harm_specific", text: REASON_TEXT.harm_specific });
        // 有计划/尝试即 L3 专业复核；含伤害自己类别且线索陈旧超过 72h 不降级，仅降低置信度。
        const level = specific ? 3 : 2;
        const freshness = Math.max(0, 1 - f.recency_hours / 240);
        return {
          level,
          confidence: roundConfidence(0.55 + f.cue_score * 0.3 + (specific ? 0.1 : 0) + freshness * 0.05),
          reasons,
        };
      }
      case "urgent_event": {
        return {
          level: 4,
          confidence: 0.99,
          reasons: [{ code: "urgent_danger", text: REASON_TEXT.urgent_danger }],
        };
      }
      case "help_request": {
        if (f.urgency === "urgent") {
          return {
            level: 4,
            confidence: 0.95,
            reasons: [{ code: "help_urgent", text: REASON_TEXT.help_urgent }],
          };
        }
        if (f.urgency === "talk") {
          return {
            level: 2,
            confidence: 0.8,
            reasons: [{ code: "help_talk", text: REASON_TEXT.help_talk }],
          };
        }
        return {
          level: 1,
          confidence: 0.7,
          reasons: [{ code: "help_support", text: REASON_TEXT.help_support }],
        };
      }
      default:
        return null;
    }
  },
};

// 注册表只追加，不删改。新版本上线通过 registerRuleVersion 登记。
export const RULES = {
  [CURRENT_RULE_VERSION]: v1,
};

// 登记新版本规则：版本号唯一，旧版本必须继续保留可评估。
export function registerRuleVersion(version, rules) {
  if (RULES[version]) throw new Error(`规则版本已存在，禁止覆盖：${version}`);
  if (typeof rules.evaluate !== "function") throw new Error("规则版本必须提供 evaluate 函数");
  RULES[version] = { version, evaluate: rules.evaluate };
  return version;
}

export function evaluateSignal(signalType, features, ruleVersion = CURRENT_RULE_VERSION) {
  const rules = RULES[ruleVersion];
  if (!rules) throw new Error(`未知规则版本：${ruleVersion}`);
  const verdict = rules.evaluate(signalType, features);
  // 把判定所用版本钉在结果上，供事件评估快照留存。
  return verdict ? { ...verdict, ruleVersion: rules.version } : null;
}

function roundConfidence(value) {
  return Math.round(Math.min(0.99, value) * 100) / 100;
}
