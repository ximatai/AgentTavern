import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(currentDir, "../..");
const defaultDataDir = path.join(appDir, "data");
const databasePath =
  process.env.AGENT_TAVERN_DB_PATH ??
  path.join(process.env.AGENT_TAVERN_DATA_DIR ?? defaultDataDir, "agent-tavern.db");
const dataDir = path.dirname(databasePath);
const migrationsDir = path.join(appDir, "drizzle");

export function runMigrations(): string {
  fs.mkdirSync(dataDir, { recursive: true });

  const sqlite = new Database(databasePath);
  const db = drizzle(sqlite);

  migrate(db, {
    migrationsFolder: migrationsDir,
  });

  sqlite.close();
  return databasePath;
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;

if (entryHref && import.meta.url === entryHref) {
  const appliedPath = runMigrations();
  console.log(`migrations applied: ${appliedPath}`);
}
