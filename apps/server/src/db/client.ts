import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(currentDir, "../..");
const defaultDataDir = path.join(appDir, "data");
const databasePath =
  process.env.AGENT_TAVERN_DB_PATH ??
  path.join(process.env.AGENT_TAVERN_DATA_DIR ?? defaultDataDir, "agent-tavern.db");
const dataDir = path.dirname(databasePath);

fs.mkdirSync(dataDir, { recursive: true });

const sqlite = new Database(databasePath);
sqlite.pragma("journal_mode = WAL");

export const db = drizzle(sqlite);
export { sqlite };
