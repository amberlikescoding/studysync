/**
 * db.js — SQLite database via better-sqlite3
 *
 * WHY SQLITE FOR A HACKATHON:
 *   • Zero setup — just a file, no separate DB server to spin up
 *   • better-sqlite3 is synchronous, so code stays simple to read
 *   • Easily swappable to Postgres later (same query shapes)
 *
 * SCHEMA OVERVIEW:
 *   users          — one row per student who connects WhatsApp
 *   authorized_groups — the groups a student explicitly allowed us to read
 *   extracted_items   — assignments/classes/reminders extracted by Claude
 *                       raw message text is NEVER stored here
 */

const Database = require('better-sqlite3');
const path     = require('path');
require('dotenv').config();

const DB_PATH = path.resolve(__dirname, process.env.DB_PATH || './studysync.db');
const db = new Database(DB_PATH);

// ── Enable WAL mode for better concurrent read performance ──
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── CREATE TABLES (idempotent — safe to run on every boot) ──
db.exec(`
  -- One row per connected student
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,          -- UUID
    phone         TEXT UNIQUE,               -- WhatsApp phone number (E.164)
    name          TEXT,                      -- Display name from WhatsApp
    whapi_session TEXT,                      -- whapi.cloud channel/session ID
    created_at    INTEGER DEFAULT (unixepoch()),
    last_seen     INTEGER DEFAULT (unixepoch())
  );

  -- Groups a student has explicitly authorized for monitoring.
  -- PRIVACY GUARANTEE: messages from any group NOT in this table
  -- are silently dropped in webhook.js before any processing occurs.
  CREATE TABLE IF NOT EXISTS authorized_groups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id    TEXT NOT NULL,               -- WhatsApp group JID (e.g. "1234@g.us")
    group_name  TEXT NOT NULL,
    authorized_at INTEGER DEFAULT (unixepoch()),
    UNIQUE(user_id, group_id)
  );

  -- Structured academic data extracted by Claude.
  -- Raw chat text is NEVER stored — only the structured output.
  CREATE TABLE IF NOT EXISTS extracted_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type        TEXT NOT NULL CHECK(type IN ('assignment','class','reminder')),
    title       TEXT NOT NULL,
    subject     TEXT,                        -- e.g. "CS301"
    due_date    TEXT,                        -- ISO-8601 string or null
    description TEXT,
    location    TEXT,                        -- for classes
    priority    TEXT DEFAULT 'medium' CHECK(priority IN ('high','medium','low')),
    confidence  REAL DEFAULT 1.0,            -- 0.0–1.0, from Claude
    status      TEXT DEFAULT 'active' CHECK(status IN ('active','done','dismissed','needs_review')),
    source_group TEXT,                       -- group_id it came from (for audit, not the message)
    created_at  INTEGER DEFAULT (unixepoch()),
    updated_at  INTEGER DEFAULT (unixepoch())
  );
`);

// ─────────────────────────────────────────────────────────────────────────────
// USER FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

/** Upsert a user by their UUID. Returns the user row. */
function upsertUser({ id, phone, name, whapiSession }) {
  db.prepare(`
    INSERT INTO users (id, phone, name, whapi_session)
    VALUES (@id, @phone, @name, @whapiSession)
    ON CONFLICT(id) DO UPDATE SET
      phone         = excluded.phone,
      name          = excluded.name,
      whapi_session = excluded.whapi_session,
      last_seen     = unixepoch()
  `).run({ id, phone: phone || null, name: name || null, whapiSession: whapiSession || null });

  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

/** Find user by their UUID. */
function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

/** Find user by their whapi session ID. */
function getUserBySession(whapiSession) {
  return db.prepare('SELECT * FROM users WHERE whapi_session = ?').get(whapiSession);
}

/** Delete a user and cascade-delete all their data. */
function deleteUser(id) {
  return db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTHORIZED GROUPS FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

/** Replace a user's authorized groups atomically (all-or-nothing). */
function setAuthorizedGroups(userId, groups) {
  // groups = [{ groupId, groupName }, ...]
  const deleteOld = db.prepare('DELETE FROM authorized_groups WHERE user_id = ?');
  const insertNew = db.prepare(`
    INSERT OR IGNORE INTO authorized_groups (user_id, group_id, group_name)
    VALUES (?, ?, ?)
  `);

  const transaction = db.transaction((groups) => {
    deleteOld.run(userId);
    for (const g of groups) {
      insertNew.run(userId, g.groupId, g.groupName);
    }
  });

  transaction(groups);
}

/** Get all authorized group IDs for a user (just the IDs, for fast lookup). */
function getAuthorizedGroupIds(userId) {
  const rows = db.prepare('SELECT group_id FROM authorized_groups WHERE user_id = ?').all(userId);
  return new Set(rows.map(r => r.group_id));
}

/** Get all authorized groups with names for a user. */
function getAuthorizedGroups(userId) {
  return db.prepare('SELECT * FROM authorized_groups WHERE user_id = ?').all(userId);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXTRACTED ITEMS FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

/** Insert a batch of extracted items from Claude. */
function insertExtractedItems(userId, items, sourceGroup) {
  const stmt = db.prepare(`
    INSERT INTO extracted_items
      (user_id, type, title, subject, due_date, description, location, priority, confidence, status, source_group)
    VALUES
      (@userId, @type, @title, @subject, @dueDate, @description, @location, @priority, @confidence, @status, @sourceGroup)
  `);

  const insertMany = db.transaction((items) => {
    for (const item of items) {
      stmt.run({
        userId,
        type:        item.type,
        title:       item.title,
        subject:     item.subject     || null,
        dueDate:     item.dueDate     || null,
        description: item.description || null,
        location:    item.location    || null,
        priority:    item.priority    || 'medium',
        // If Claude confidence is below 0.70, send to needs_review queue
        confidence:  item.confidence  || 1.0,
        status:      (item.confidence && item.confidence < 0.70) ? 'needs_review' : 'active',
        sourceGroup,
      });
    }
  });

  insertMany(items);
}

/** Get all active items for a user, newest first. */
function getItemsForUser(userId) {
  return db.prepare(`
    SELECT * FROM extracted_items
    WHERE user_id = ? AND status != 'dismissed'
    ORDER BY
      CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      due_date ASC NULLS LAST,
      created_at DESC
  `).all(userId);
}

/** Get items by type. */
function getItemsByType(userId, type) {
  return db.prepare(`
    SELECT * FROM extracted_items
    WHERE user_id = ? AND type = ? AND status != 'dismissed'
    ORDER BY due_date ASC NULLS LAST
  `).all(userId, type);
}

/** Update item status (done / dismissed / active). */
function updateItemStatus(itemId, userId, status) {
  return db.prepare(`
    UPDATE extracted_items
    SET status = ?, updated_at = unixepoch()
    WHERE id = ? AND user_id = ?
  `).run(status, itemId, userId);
}

/** Get stats summary for the dashboard header cards. */
function getStatsForUser(userId) {
  const assignments = db.prepare(`
    SELECT COUNT(*) as count FROM extracted_items
    WHERE user_id = ? AND type = 'assignment' AND status = 'active'
  `).get(userId);

  const done = db.prepare(`
    SELECT COUNT(*) as count FROM extracted_items
    WHERE user_id = ? AND status = 'done'
    AND updated_at > unixepoch() - 604800
  `).get(userId);

  const classesToday = db.prepare(`
    SELECT COUNT(*) as count FROM extracted_items
    WHERE user_id = ? AND type = 'class' AND status = 'active'
  `).get(userId);

  const reminders = db.prepare(`
    SELECT COUNT(*) as count FROM extracted_items
    WHERE user_id = ? AND type = 'reminder' AND status = 'active'
  `).get(userId);

  return {
    assignments: assignments.count,
    completedThisWeek: done.count,
    classesToday: classesToday.count,
    reminders: reminders.count,
  };
}

module.exports = {
  upsertUser,
  getUserById,
  getUserBySession,
  deleteUser,
  setAuthorizedGroups,
  getAuthorizedGroupIds,
  getAuthorizedGroups,
  insertExtractedItems,
  getItemsForUser,
  getItemsByType,
  updateItemStatus,
  getStatsForUser,
  clearUserItems: (userId) => {
    db.prepare('DELETE FROM extracted_items WHERE user_id = ?').run(userId);
  },
};
