import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(currentDir, "../..");
const dataDir = path.join(appDir, "data");
const databasePath = path.join(dataDir, "agent-tavern.db");
const migrationsDir = path.join(appDir, "drizzle");

fs.mkdirSync(dataDir, { recursive: true });

const sqlite = new Database(databasePath);
const db = drizzle(sqlite);

migrate(db, {
  migrationsFolder: migrationsDir,
});

sqlite.close();

console.log(`migrations applied: ${databasePath}`);
