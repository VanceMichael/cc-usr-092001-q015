import path from "node:path";

import { openDatabase } from "./db.js";
import { createServer } from "./http.js";
import { pumpOutbox } from "./cases.js";
import { auditSystem } from "./audit.js";

export function healthPayload() {
  return { status: "ok" };
}

export function buildServer(databasePath = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "app.sqlite3")) {
  const db = openDatabase(databasePath);
  // 启动即补发：服务重启不会丢失任何已触发事件的通知（pending 继续，sent 不重发）。
  const recovered = pumpOutbox(db);
  if (recovered.processed > 0) {
    auditSystem(db, "outbox.recovered_on_start", recovered);
  }
  const server = createServer(db);
  // 周期性补发兜底（也可由外部定时器调用 /v1/outbox/pump）。
  const timer = setInterval(() => pumpOutbox(db), 30_000);
  timer.unref();
  server.on("close", () => {
    clearInterval(timer);
    db.close();
  });
  return { server, db };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  const { server } = buildServer();
  server.listen(port, "0.0.0.0", () => {
    console.log(`安全桥服务已启动：:${port}`);
  });
}
