import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/http.js";
import { FEATURES, freshDb, setupWorld, signal } from "./helpers.js";

async function start(db) {
  const server = (await import("node:http")).createServer(createApp(db));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

async function jsonHttp(base, path, options = {}) {
  const res = await fetch(base + path, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.role ? { "x-actor-role": options.role, "x-actor-ref": options.ref } : {}),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, body };
}

test("健康检查", async () => {
  const db = freshDb();
  const { base, close } = await start(db);
  const r = await jsonHttp(base, "/health");
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "ok");
  await close();
});

test("摄入端点：无令牌 401；持令牌接收；原文字段 422", async () => {
  const db = freshDb();
  setupWorld(db);
  const { base, close } = await start(db);

  assert.equal((await jsonHttp(base, "/v1/signals", { method: "POST", body: {} })).status, 401);

  const ok = await jsonHttp(base, "/v1/signals", {
    method: "POST",
    token: "dev-ingest-token",
    body: signal({ features: FEATURES.harm_plan, signal_type: "harm_cue" }),
  });
  assert.equal(ok.status, 202);
  assert.equal(ok.body.level, 3);

  const bad = await jsonHttp(base, "/v1/signals", {
    method: "POST",
    token: "dev-ingest-token",
    body: signal({
      signal_type: "harm_cue",
      features: { ...FEATURES.harm_plan, message: "还原原文" },
    }),
  });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error, "prohibited_content");
  await close();
});

test("同意端点校验头部身份与决定人一致", async () => {
  const db = freshDb();
  setupWorld(db, { consent: false });
  const { base, close } = await start(db);

  const mismatch = await jsonHttp(base, "/v1/consent", {
    method: "POST",
    role: "guardian",
    ref: "G_CHILD",
    body: { subject_ref: "S_CHILD", decision: "grant", decided_by: "student", actor_ref: "S_CHILD" },
  });
  assert.equal(mismatch.status, 403);

  const granted = await jsonHttp(base, "/v1/consent", {
    method: "POST",
    role: "guardian",
    ref: "G_CHILD",
    body: { subject_ref: "S_CHILD", decision: "grant", decided_by: "guardian", actor_ref: "G_CHILD" },
  });
  assert.equal(granted.status, 201);
  assert.equal(granted.body.decision, "grant");
  await close();
});

test("不同角色读到不同字段；教师读 L4 被拒且留痕", async () => {
  const db = freshDb();
  setupWorld(db);
  const { base, close } = await start(db);

  const sig = await jsonHttp(base, "/v1/signals", {
    method: "POST",
    token: "dev-ingest-token",
    body: signal({ signal_type: "urgent_event", features: FEATURES.urgent }),
  });
  const eventId = sig.body.event_id;

  const student = await jsonHttp(base, `/v1/events/${eventId}`, { role: "student", ref: "S_CHILD" });
  assert.equal(student.status, 200);
  assert.ok("headline" in student.body);
  assert.ok(!("features" in student.body));

  const guardian = await jsonHttp(base, `/v1/events/${eventId}`, { role: "guardian", ref: "G_CHILD" });
  assert.equal(guardian.status, 200);
  assert.ok(!("features" in guardian.body));
  assert.ok("recommendation" in guardian.body);

  const psy = await jsonHttp(base, `/v1/events/${eventId}`, { role: "psychologist", ref: "P_S_CHILD" });
  assert.equal(psy.status, 200);
  assert.ok("features" in psy.body);
  assert.ok("evaluations" in psy.body);

  const teacher = await jsonHttp(base, `/v1/events/${eventId}`, { role: "teacher", ref: "T_S_CHILD" });
  assert.equal(teacher.status, 403);

  const duty = await jsonHttp(base, `/v1/events/${eventId}`, { role: "duty_teacher", ref: "D_S_CHILD" });
  assert.equal(duty.status, 200);

  // 越权已留痕：管理审计可查到 deny。
  const audit = await jsonHttp(base, "/v1/admin/audit?limit=200", {
    token: "dev-admin-token",
    role: "admin",
    ref: "ADMIN1",
  });
  assert.equal(audit.status, 200);
  assert.ok(audit.body.entries.some((e) => e.result === "deny" && e.action === "event.read_denied"));

  const verify = await jsonHttp(base, "/v1/admin/audit/verify", {
    method: "POST",
    token: "dev-admin-token",
    role: "admin",
    ref: "ADMIN1",
  });
  assert.equal(verify.status, 200);
  assert.equal(verify.body.ok, true);
  await close();
});

test("学生通过 HTTP 查看说明、提交申诉、查询删除进度", async () => {
  const db = freshDb();
  setupWorld(db);
  const { base, close } = await start(db);

  const sig = await jsonHttp(base, "/v1/signals", {
    method: "POST",
    token: "dev-ingest-token",
    body: signal({ features: FEATURES.dep_high }),
  });
  const eventId = sig.body.event_id;

  const ex = await jsonHttp(base, `/v1/events/${eventId}/explanation`, {
    role: "student",
    ref: "S_CHILD",
  });
  assert.equal(ex.status, 200);
  assert.ok(ex.body.version_promise);

  const appeal = await jsonHttp(base, `/v1/events/${eventId}/appeal`, {
    method: "POST",
    role: "student",
    ref: "S_CHILD",
    body: { statement: "判断有误，我只是在用学习功能" },
  });
  assert.equal(appeal.status, 201);

  const deletion = await jsonHttp(base, "/v1/me/deletion", {
    method: "POST",
    role: "student",
    ref: "S_CHILD",
  });
  assert.equal(deletion.status, 201);
  assert.equal(deletion.body.progress, 100);

  const progress = await jsonHttp(base, "/v1/me/deletion", { role: "student", ref: "S_CHILD" });
  assert.equal(progress.status, 200);
  assert.equal(progress.body.deletion.status, "completed");
  await close();
});
