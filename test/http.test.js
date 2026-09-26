import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../src/db.js";
import { DEFAULT_RULESET } from "../src/rules.js";
import { createServer } from "../src/server.js";

async function withServer(run) {
  const db = openDatabase(":memory:");
  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    server.close();
    db.close();
  }
}

async function post(base, path, body, headers = {}) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("HTTP 接口串联：播种规则、登记同意、上报信号、分级查看", async () => {
  await withServer(async (base) => {
    const health = await fetch(`${base}/health`);
    assert.deepEqual(await health.json(), { status: "ok" });

    await post(base, "/rulesets", DEFAULT_RULESET, { "x-actor-role": "admin", "x-actor-ref": "a1" });

    const consent = await post(base, "/consents", {
      subject_ref: "SUBJ-1",
      age_band: "16_to_18",
      guardian_ref: "GUARD-1",
      guardian_relation: "parent",
    });
    assert.equal(consent.status, 201);

    const body = {
      event_id: "EVT-HTTP-1",
      subject_ref: "SUBJ-1",
      kind: "risk_signal",
      signal_type: "usage_pattern",
      metrics: { consecutive_days: 30, late_night_minutes: 120 },
      payload_digest: "sha256:http",
      occurred_at: "2026-09-26T00:10:00+08:00",
      source_sequence: 1,
    };
    const event = await post(base, "/events", body);
    assert.equal(event.status, 201);
    assert.equal(event.body.assessment.level, "dependence");

    // 重复上报返回 duplicate，不产生新事件。
    const duplicate = await post(base, "/events", body);
    assert.equal(duplicate.body.status, "duplicate");
  });
});

test("HTTP 层拒绝携带谈话原文的信号", async () => {
  await withServer(async (base) => {
    await post(base, "/rulesets", DEFAULT_RULESET, { "x-actor-role": "admin", "x-actor-ref": "a1" });
    await post(base, "/consents", {
      subject_ref: "SUBJ-1",
      age_band: "14_to_16",
      guardian_ref: "GUARD-1",
      guardian_relation: "parent",
    });
    const rejected = await post(base, "/events", {
      event_id: "EVT-RAW",
      subject_ref: "SUBJ-1",
      kind: "risk_signal",
      signal_type: "usage_pattern",
      metrics: { consecutive_days: 30 },
      transcript: "完整聊天记录",
      payload_digest: "sha256:raw",
      occurred_at: "2026-09-26T01:00:00+08:00",
      source_sequence: 1,
    });
    assert.equal(rejected.status, 422);
    assert.equal(rejected.body.error, "raw_content_rejected");
  });
});
