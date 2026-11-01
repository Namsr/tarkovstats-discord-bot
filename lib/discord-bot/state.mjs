import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const ID = /^\d{17,20}$/;

function validId(value) { return typeof value === "string" && ID.test(value); }
function safeError(error) {
  return String(error?.message || error).replace(/https?:\/\/\S+/gi, "[url]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 240);
}

export class DiscordJobStore {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS discord_jobs (
        guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, parent_channel_id TEXT,
        message_id TEXT NOT NULL, attachment_id TEXT NOT NULL, author_id TEXT NOT NULL,
        match_number INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT, response_json TEXT, response_at INTEGER, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, acked_at INTEGER,
        PRIMARY KEY (guild_id, channel_id, message_id, attachment_id)
      );
      CREATE INDEX IF NOT EXISTS discord_jobs_due ON discord_jobs(status, next_attempt_at, created_at);
      CREATE TABLE IF NOT EXISTS discord_checkpoints (
        channel_id TEXT PRIMARY KEY, last_message_id TEXT, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS discord_match_reminders (
        guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, match_number INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0, message_id TEXT, last_error TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(guild_id,channel_id)
      );
      CREATE INDEX IF NOT EXISTS discord_reminders_due ON discord_match_reminders(status,next_attempt_at,created_at);
    `);
    // A process dying after claiming work must not leave the job invisible forever.
    this.db.prepare("UPDATE discord_jobs SET status='pending', updated_at=? WHERE status='running'").run(Date.now());
  }

  close() { this.db.close(); }

  enqueueReminder(guildId, channelId, matchNumber, now = Date.now()) {
    if (!validId(guildId) || !validId(channelId) || !Number.isSafeInteger(matchNumber) || matchNumber <= 0) {
      throw new TypeError("Invalid Discord match reminder");
    }
    this.db.prepare(`INSERT OR IGNORE INTO discord_match_reminders(guild_id,channel_id,match_number,created_at)
      VALUES(?,?,?,?)`).run(guildId, channelId, matchNumber, now);
  }

  claimReminderDue(now = Date.now()) {
    // The worker drains one job at a time; returning the incremented row also
    // keeps the attempt count durable if the process exits during Discord I/O.
    return this.db.prepare(`UPDATE discord_match_reminders SET attempts=attempts+1
      WHERE rowid=(SELECT rowid FROM discord_match_reminders WHERE status='pending' AND next_attempt_at<=?
        ORDER BY created_at LIMIT 1) RETURNING *`).get(now) ?? null;
  }

  completeReminder(job, messageId) {
    if (!validId(messageId)) throw new TypeError("Invalid Discord reminder message ID");
    this.db.prepare("UPDATE discord_match_reminders SET status='done',message_id=? WHERE guild_id=? AND channel_id=?")
      .run(messageId, job.guild_id, job.channel_id);
  }

  deferReminder(job, error, delayMs, terminal = false, now = Date.now()) {
    this.db.prepare("UPDATE discord_match_reminders SET status=?,last_error=?,next_attempt_at=? WHERE guild_id=? AND channel_id=?")
      .run(terminal ? "failed" : "pending", safeError(error), now + delayMs, job.guild_id, job.channel_id);
  }

  enqueue(job, now = Date.now()) {
    return this.enqueueMany([job], null, null, now)[0];
  }

  /** Insert a message's complete attachment set and advance its checkpoint atomically. */
  enqueueMany(jobs, channelId, messageId, now = Date.now(), maxPending = 1000) {
    if (!Array.isArray(jobs) || jobs.length > 50) throw new TypeError("Invalid Discord job batch");
    if (channelId !== null && (!validId(channelId) || messageId !== null && !validId(messageId))) throw new TypeError("Invalid Discord checkpoint");
    const inserted = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const pending = this.db.prepare("SELECT COUNT(*) AS count FROM discord_jobs WHERE status IN ('pending','running')").get().count;
      const seen = new Set();
      const rows = [];
      for (const job of jobs) {
        if (!validId(job.guildId) || !validId(job.channelId) || job.parentChannelId !== null && !validId(job.parentChannelId)
          || !validId(job.messageId) || !validId(job.attachmentId) || !validId(job.authorId)
          || !Number.isSafeInteger(job.matchNumber) || job.matchNumber <= 0) throw new TypeError("Invalid Discord job");
        const key = `${job.guildId}:${job.channelId}:${job.messageId}:${job.attachmentId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const existing = this.db.prepare("SELECT status FROM discord_jobs WHERE guild_id=? AND channel_id=? AND message_id=? AND attachment_id=?")
          .get(job.guildId, job.channelId, job.messageId, job.attachmentId);
        if (existing) { inserted.push({ inserted: false, status: existing.status }); continue; }
        rows.push(job);
      }
      if (pending + rows.length > maxPending) { const error = new Error("discord_queue_full"); error.transient = true; throw error; }
      const insert = this.db.prepare(`INSERT INTO discord_jobs(guild_id,channel_id,parent_channel_id,message_id,attachment_id,author_id,match_number,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'pending',?,?)`);
      for (const job of rows) {
        insert.run(job.guildId, job.channelId, job.parentChannelId ?? null, job.messageId, job.attachmentId, job.authorId, job.matchNumber, now, now);
        inserted.push({ inserted: true, status: "pending" });
      }
      if (channelId !== null) {
        const previous = this.db.prepare("SELECT last_message_id FROM discord_checkpoints WHERE channel_id=?").get(channelId)?.last_message_id ?? null;
        if (messageId !== null && (previous === null || BigInt(messageId) > BigInt(previous))) {
          this.db.prepare(`INSERT INTO discord_checkpoints(channel_id,last_message_id,updated_at) VALUES(?,?,?)
            ON CONFLICT(channel_id) DO UPDATE SET last_message_id=excluded.last_message_id,updated_at=excluded.updated_at`).run(channelId, messageId, now);
        }
      }
      this.db.exec("COMMIT");
      return inserted;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  claimDue(now = Date.now()) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`SELECT * FROM discord_jobs WHERE status='pending' AND next_attempt_at<=? ORDER BY created_at, message_id LIMIT 1`).get(now);
      if (!row) { this.db.exec("COMMIT"); return null; }
      this.db.prepare("UPDATE discord_jobs SET status='running', attempts=attempts+1, updated_at=? WHERE guild_id=? AND channel_id=? AND message_id=? AND attachment_id=?")
        .run(now, row.guild_id, row.channel_id, row.message_id, row.attachment_id);
      this.db.exec("COMMIT");
      return { ...row, status: "running", attempts: row.attempts + 1 };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  saveResponse(job, response, now = Date.now()) {
    this.db.prepare(`UPDATE discord_jobs SET response_json=?,response_at=?,updated_at=? WHERE guild_id=? AND channel_id=? AND message_id=? AND attachment_id=?`)
      .run(JSON.stringify(response), now, now, job.guild_id, job.channel_id, job.message_id, job.attachment_id);
  }

  markAcked(job, now = Date.now()) {
    this.db.prepare("UPDATE discord_jobs SET status='done',acked_at=?,updated_at=? WHERE guild_id=? AND channel_id=? AND message_id=? AND attachment_id=?")
      .run(now, now, job.guild_id, job.channel_id, job.message_id, job.attachment_id);
  }

  retry(job, error, delayMs, now = Date.now()) {
    this.db.prepare("UPDATE discord_jobs SET status='pending',last_error=?,next_attempt_at=?,updated_at=? WHERE guild_id=? AND channel_id=? AND message_id=? AND attachment_id=?")
      .run(safeError(error), now + Math.max(1000, delayMs), now, job.guild_id, job.channel_id, job.message_id, job.attachment_id);
  }

  fail(job, error, now = Date.now()) {
    this.db.prepare("UPDATE discord_jobs SET status='failed',last_error=?,updated_at=? WHERE guild_id=? AND channel_id=? AND message_id=? AND attachment_id=?")
      .run(safeError(error), now, job.guild_id, job.channel_id, job.message_id, job.attachment_id);
  }

  get(job) {
    return this.db.prepare("SELECT * FROM discord_jobs WHERE guild_id=? AND channel_id=? AND message_id=? AND attachment_id=?")
      .get(job.guild_id, job.channel_id, job.message_id, job.attachment_id) ?? null;
  }

  checkpoint(channelId) {
    return this.db.prepare("SELECT last_message_id FROM discord_checkpoints WHERE channel_id=?").get(channelId)?.last_message_id ?? null;
  }

  saveCheckpoint(channelId, messageId, now = Date.now()) {
    if (!validId(channelId) || messageId !== null && !validId(messageId)) throw new TypeError("Invalid Discord checkpoint");
    if (messageId !== null) {
      const previous = this.db.prepare("SELECT last_message_id FROM discord_checkpoints WHERE channel_id=?").get(channelId)?.last_message_id ?? null;
      if (previous !== null && BigInt(messageId) <= BigInt(previous)) return;
    }
    this.db.prepare(`INSERT INTO discord_checkpoints(channel_id,last_message_id,updated_at) VALUES(?,?,?)
      ON CONFLICT(channel_id) DO UPDATE SET last_message_id=excluded.last_message_id,updated_at=excluded.updated_at`).run(channelId, messageId, now);
  }
}

export function backoffMs(attempt) { return Math.min(15 * 60_000, 5_000 * 2 ** Math.min(8, Math.max(0, attempt - 1))); }
