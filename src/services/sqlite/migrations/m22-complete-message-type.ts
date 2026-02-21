import { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';
import type { TableColumnInfo, TableNameRow, SchemaVersion } from '../../../types/database.js';

/**
 * Migration 22: Allow 'complete' control messages in pending_messages.message_type
 *
 * SQLite cannot ALTER CHECK constraints, so we rebuild the table when needed.
 * Shared between SessionStore and MigrationRunner to avoid duplication.
 */
export function allowCompleteMessageType(db: Database): void {
  const applied = db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(22) as SchemaVersion | undefined;
  if (applied) return;

  // Nothing to do if pending_messages doesn't exist yet
  const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all() as TableNameRow[];
  if (tables.length === 0) {
    db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(22, new Date().toISOString());
    return;
  }

  // Check if the existing table already allows 'complete'
  const tableSqlRow = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type='table' AND name='pending_messages'
  `).get() as { sql: string | null } | undefined;
  const tableSql = tableSqlRow?.sql || '';

  if (tableSql.includes("'complete'")) {
    db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(22, new Date().toISOString());
    return;
  }

  logger.debug('DB', 'Rebuilding pending_messages to allow message_type=complete');

  // Determine whether failed_at_epoch exists so we can preserve data
  const tableInfo = db.query('PRAGMA table_info(pending_messages)').all() as TableColumnInfo[];
  const hasFailedAtEpoch = tableInfo.some(col => col.name === 'failed_at_epoch');

  db.run('BEGIN TRANSACTION');
  try {
    db.run(`
      CREATE TABLE pending_messages_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER NOT NULL,
        content_session_id TEXT NOT NULL,
        message_type TEXT NOT NULL CHECK(message_type IN ('observation', 'summarize', 'complete')),
        tool_name TEXT,
        tool_input TEXT,
        tool_response TEXT,
        cwd TEXT,
        last_user_message TEXT,
        last_assistant_message TEXT,
        prompt_number INTEGER,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'processed', 'failed')),
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at_epoch INTEGER NOT NULL,
        started_processing_at_epoch INTEGER,
        completed_at_epoch INTEGER,
        failed_at_epoch INTEGER,
        FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      )
    `);

    // Copy data from old table
    const selectFailedAtEpoch = hasFailedAtEpoch ? 'failed_at_epoch' : 'NULL as failed_at_epoch';
    db.run(`
      INSERT INTO pending_messages_new (
        id, session_db_id, content_session_id, message_type,
        tool_name, tool_input, tool_response, cwd,
        last_user_message, last_assistant_message, prompt_number,
        status, retry_count, created_at_epoch,
        started_processing_at_epoch, completed_at_epoch, failed_at_epoch
      )
      SELECT
        id, session_db_id, content_session_id, message_type,
        tool_name, tool_input, tool_response, cwd,
        last_user_message, last_assistant_message, prompt_number,
        status, retry_count, created_at_epoch,
        started_processing_at_epoch, completed_at_epoch, ${selectFailedAtEpoch}
      FROM pending_messages
    `);

    db.run('DROP TABLE pending_messages');
    db.run('ALTER TABLE pending_messages_new RENAME TO pending_messages');

    // Recreate indexes
    db.run('CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)');
    db.run('CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)');

    db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(22, new Date().toISOString());
    db.run('COMMIT');
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
}
