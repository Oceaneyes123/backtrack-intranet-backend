import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";

const backendDir = path.resolve(process.cwd());

test("backup script creates a valid backup snapshot", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-backup-"));
  const dbPath = path.join(tempDir, "chat.db");
  const sourceDb = new Database(dbPath);
  sourceDb.exec(`
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT);
    INSERT INTO messages (body) VALUES ('hello');
  `);
  sourceDb.close();

  const result = spawnSync(process.execPath, ["scripts/backup.js"], {
    cwd: backendDir,
    env: { ...process.env, DATABASE_PATH: dbPath },
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const backupDir = path.join(tempDir, "backups");
  const backups = fs.readdirSync(backupDir).filter((file) => file.endsWith(".db"));
  assert.equal(backups.length, 1);

  const backupDb = new Database(path.join(backupDir, backups[0]), { readonly: true });
  const integrity = backupDb.pragma("integrity_check");
  const rowCount = backupDb.prepare("SELECT COUNT(1) AS count FROM messages").get();
  backupDb.close();

  assert.equal(integrity[0]?.integrity_check, "ok");
  assert.equal(rowCount?.count, 1);

  fs.rmSync(tempDir, { recursive: true, force: true });
});
