import path from "node:path";

import { openDatabase } from "../src/db.js";
import { DEFAULT_RULESET } from "../src/rules.js";

const databasePath = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "app.sqlite3");
const database = openDatabase(databasePath);

// 播种默认规则集；已存在的版本不可改写。
const existing = database
  .prepare("SELECT version FROM rule_sets WHERE version = ?")
  .get(DEFAULT_RULESET.version);
if (!existing) {
  database
    .prepare("INSERT INTO rule_sets(version, definition, status, activated_at) VALUES (?, ?, 'active', ?)")
    .run(DEFAULT_RULESET.version, JSON.stringify(DEFAULT_RULESET), new Date().toISOString());
  console.log(`已激活默认规则集 ${DEFAULT_RULESET.version}`);
}

database.close();
console.log(`数据库初始化完成：${databasePath}`);
