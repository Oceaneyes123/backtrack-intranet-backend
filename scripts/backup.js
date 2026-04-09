#!/usr/bin/env node
// backend/scripts/backup.js — SQLite backup with WAL checkpoint and integrity check.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const DB_PATH = path.resolve(process.env.DATABASE_PATH || "./data/chat.db");
const BACKUP_DIR = path.resolve(path.dirname(DB_PATH), "backups");

if (!fs.existsSync(DB_PATH)) {
  console.error(`Database not found: ${DB_PATH}`);
  process.exit(1);
}

fs.mkdirSync(BACKUP_DIR, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const backupName = `chat-${timestamp}.db`;
const backupPath = path.join(BACKUP_DIR, backupName);

console.log(`Backing up ${DB_PATH} → ${backupPath}`);

let db;
try {
  db = new Database(DB_PATH);
  db.pragma("wal_checkpoint(TRUNCATE)");
  await db.backup(backupPath);

  const backupDb = new Database(backupPath, { readonly: true });
  const result = backupDb.pragma("integrity_check");
  backupDb.close();

  const ok = Array.isArray(result) ? result[0]?.integrity_check === "ok" : result === "ok";
  if (!ok) {
    console.error("Integrity check failed:", result);
    fs.unlinkSync(backupPath);
    process.exit(1);
  }

  const stats = fs.statSync(backupPath);
  console.log(`Backup complete: ${backupName} (${(stats.size / 1024).toFixed(1)} KB)`);
} catch (err) {
  console.error("Backup failed:", err.message);
  if (fs.existsSync(backupPath)) {
    try { fs.unlinkSync(backupPath); } catch {}
  }
  process.exit(1);
} finally {
  try { db?.close(); } catch {}
}
