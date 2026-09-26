import path from "node:path";
import { openDatabase } from "../src/db.js";

const databasePath =
  process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "app.sqlite3");
const db = openDatabase(databasePath);
db.close();
console.log(`数据库初始化完成：${databasePath}`);
