import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MAX_BYTES, validateAttachmentUrl } from "./security.mjs";

const ID = /^\d{17,20}$/;
export const CAPTURE_STORAGE_LIMIT = 256 * 1024 * 1024;
const captureIds = (job) => [job.guild_id, job.channel_id, job.message_id, job.attachment_id];
const CAPTURE_KEY = "guild_id=? AND channel_id=? AND message_id=? AND attachment_id=?";

function validId(value) { return typeof value === "string" && ID.test(value); }
function reminderTable(job) {
  if (job.kind === "winner") return "discord_winner_reminders";
  if (job.kind === undefined || job.kind === "channel") return "discord_match_reminders";
  throw new TypeError("Invalid reminder kind");
}
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
      CREATE TABLE IF NOT EXISTS discord_winner_reminders (
        guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, match_number INTEGER NOT NULL,
        source_message_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0, message_id TEXT, last_error TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(guild_id,channel_id)
      );
      CREATE INDEX IF NOT EXISTS discord_winner_reminders_due ON discord_winner_reminders(status,next_attempt_at,created_at);
      CREATE TABLE IF NOT EXISTS discord_attachment_captures (
        guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT NOT NULL, attachment_id TEXT NOT NULL,
        url TEXT, name TEXT, content_type TEXT, data BLOB,
        stage TEXT NOT NULL DEFAULT 'pending', download_attempts INTEGER NOT NULL DEFAULT 0,
        upload_attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
        captured_at INTEGER, uploaded_at INTEGER, last_error TEXT,
        PRIMARY KEY(guild_id,channel_id,message_id,attachment_id)
      );
      CREATE INDEX IF NOT EXISTS discord_captures_due ON discord_attachment_captures(stage,next_attempt_at);
    `);
    const captureColumns = new Set(this.db.prepare("PRAGMA table_info(discord_attachment_captures)").all().map((row) => row.name));
    for (const column of ["downloading_notice_at", "downloaded_notice_at"]) {
      if (!captureColumns.has(column)) this.db.exec(`ALTER TABLE discord_attachment_captures ADD COLUMN ${column} INTEGER`);
    }
    // A process dying after claiming work must not leave the job invisible forever.
    this.db.prepare("UPDATE discord_jobs SET status='pending', updated_at=? WHERE status='running'").run(Date.now());
    this.db.exec("UPDATE discord_attachment_captures SET stage=CASE WHEN data IS NULL THEN 'pending' ELSE 'downloaded' END WHERE stage IN ('downloading','uploading')");
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
    for (const kind of ["channel", "winner"]) {
      const table = reminderTable({ kind });
      const row = this.db.prepare(`UPDATE ${table} SET attempts=attempts+1
        WHERE rowid=(SELECT rowid FROM ${table} WHERE status='pending' AND next_attempt_at<=?
          ORDER BY created_at LIMIT 1) RETURNING *`).get(now);
      if (row) return { ...row, kind };
    }
    return null;
  }

  hasWinnerReminder(guildId, channelId) {
    return Boolean(this.db.prepare("SELECT 1 FROM discord_winner_reminders WHERE guild_id=? AND channel_id=?").get(guildId, channelId));
  }

  enqueueWinnerReminder(guildId, channelId, matchNumber, sourceMessageId, now = Date.now()) {
    if (!validId(guildId) || !validId(channelId) || !validId(sourceMessageId)
      || !Number.isSafeInteger(matchNumber) || matchNumber <= 0) throw new TypeError("Invalid winner reminder");
    this.db.prepare(`INSERT OR IGNORE INTO discord_winner_reminders(guild_id,channel_id,match_number,source_message_id,created_at)
      VALUES(?,?,?,?,?)`).run(guildId, channelId, matchNumber, sourceMessageId, now);
  }

  completeReminder(job, messageId) {
    if (!validId(messageId)) throw new TypeError("Invalid Discord reminder message ID");
    this.db.prepare(`UPDATE ${reminderTable(job)} SET status='done',message_id=? WHERE guild_id=? AND channel_id=?`)
      .run(messageId, job.guild_id, job.channel_id);
  }

  deferReminder(job, error, delayMs, terminal = false, now = Date.now()) {
    this.db.prepare(`UPDATE ${reminderTable(job)} SET status=?,last_error=?,next_attempt_at=? WHERE guild_id=? AND channel_id=?`)
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
        if (job.capture) {
          if (typeof job.capture.url !== "string" || job.capture.url.length > 4096
            || typeof job.capture.name !== "string" || job.capture.name.length > 255
            || job.capture.contentType !== null && (typeof job.capture.contentType !== "string" || job.capture.contentType.length > 100)) throw new TypeError("Invalid capture metadata");
          validateAttachmentUrl(job.capture.url, [job.channelId, job.parentChannelId].filter(Boolean), job.attachmentId);
        }
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
        if (job.capture) this.db.prepare(`INSERT INTO discord_attachment_captures(guild_id,channel_id,message_id,attachment_id,url,name,content_type)
          VALUES(?,?,?,?,?,?,?)`).run(job.guildId, job.channelId, job.messageId, job.attachmentId, job.capture.url, job.capture.name, job.capture.contentType);
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
      const row = this.db.prepare(`SELECT j.* FROM discord_jobs j LEFT JOIN discord_attachment_captures c
        USING(guild_id,channel_id,message_id,attachment_id)
        WHERE j.status='pending' AND j.next_attempt_at<=?
          AND (j.response_json IS NOT NULL OR c.stage IS NULL OR c.stage='ready')
        ORDER BY j.created_at, j.message_id LIMIT 1`).get(now);
      if (!row) { this.db.exec("COMMIT"); return null; }
      this.db.prepare("UPDATE discord_jobs SET status='running', attempts=attempts+1, updated_at=? WHERE guild_id=? AND channel_id=? AND message_id=? AND attachment_id=?")
        .run(now, row.guild_id, row.channel_id, row.message_id, row.attachment_id);
      this.db.exec("COMMIT");
      return { ...row, status: "running", attempts: row.attempts + 1 };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  getCapture(job) {
    return this.db.prepare(`SELECT stage,captured_at,uploaded_at,download_attempts,upload_attempts,last_error,downloading_notice_at,downloaded_notice_at FROM discord_attachment_captures WHERE ${CAPTURE_KEY}`).get(...captureIds(job)) ?? null;
  }

  completeCaptureNotice(job, phase, now = Date.now()) {
    if (phase !== "downloading" && phase !== "downloaded") throw new TypeError("Invalid capture notice phase");
    this.db.prepare(`UPDATE discord_attachment_captures SET ${phase}_notice_at=? WHERE ${CAPTURE_KEY}`).run(now, ...captureIds(job));
  }

  claimCaptureDownload(now = Date.now()) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const used = this.db.prepare(`SELECT COALESCE(SUM(CASE WHEN data IS NOT NULL THEN length(data) WHEN stage='downloading' THEN ? ELSE 0 END),0) AS n FROM discord_attachment_captures`).get(MAX_BYTES).n;
      if (used + MAX_BYTES > CAPTURE_STORAGE_LIMIT) { this.db.exec("COMMIT"); return null; }
      const row = this.db.prepare(`SELECT c.* FROM discord_attachment_captures c JOIN discord_jobs j USING(guild_id,channel_id,message_id,attachment_id)
        WHERE c.stage='pending' AND c.next_attempt_at<=? AND j.status='pending' AND j.response_json IS NULL
        ORDER BY j.created_at,j.message_id LIMIT 1`).get(now);
      if (!row) { this.db.exec("COMMIT"); return null; }
      this.db.prepare(`UPDATE discord_attachment_captures SET stage='downloading',download_attempts=download_attempts+1 WHERE ${CAPTURE_KEY}`).run(...captureIds(row));
      this.db.exec("COMMIT");
      return { ...this.get(row), ...row, stage: "downloading", download_attempts: row.download_attempts + 1 };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  claimCaptureUpload(now = Date.now()) {
    const row = this.db.prepare(`UPDATE discord_attachment_captures SET stage='uploading',upload_attempts=upload_attempts+1
      WHERE rowid=(SELECT c.rowid FROM discord_attachment_captures c JOIN discord_jobs j USING(guild_id,channel_id,message_id,attachment_id)
        WHERE c.stage='downloaded' AND c.next_attempt_at<=? AND j.status='pending' AND j.response_json IS NULL
        ORDER BY j.created_at,j.message_id LIMIT 1) RETURNING guild_id,channel_id,message_id,attachment_id,upload_attempts`).get(now);
    return row ? { ...this.get(row), ...row } : null;
  }

  saveCapturePhoto(job, photo, now = Date.now()) {
    const data = Buffer.from(photo.data, "base64");
    if (!data.length || data.length > MAX_BYTES || photo.bytes !== data.length) throw new TypeError("Invalid captured photo");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const used = this.db.prepare("SELECT COALESCE(SUM(length(data)),0) AS n FROM discord_attachment_captures").get().n;
      if (used + data.length > CAPTURE_STORAGE_LIMIT) { const error = new Error("capture_storage_full"); error.transient = true; throw error; }
      this.db.prepare(`UPDATE discord_attachment_captures SET data=?,content_type=?,url=NULL,stage='downloaded',captured_at=?,next_attempt_at=0,last_error=NULL WHERE ${CAPTURE_KEY}`)
        .run(data, photo.contentType, now, ...captureIds(job));
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  readCapturePhoto(job) {
    const row = this.db.prepare(`SELECT data,content_type FROM discord_attachment_captures WHERE ${CAPTURE_KEY}`).get(...captureIds(job));
    return row?.data ? { data: Buffer.from(row.data).toString("base64"), bytes: row.data.byteLength, contentType: row.content_type } : null;
  }

  captureUploaded(job, now = Date.now()) {
    this.db.prepare(`UPDATE discord_attachment_captures SET stage='ready',uploaded_at=?,next_attempt_at=0,last_error=NULL WHERE ${CAPTURE_KEY}`).run(now, ...captureIds(job));
  }

  retryCapture(job, phase, error, delayMs, now = Date.now()) {
    const stage = phase === "download" ? "pending" : "downloaded";
    this.db.prepare(`UPDATE discord_attachment_captures SET stage=?,next_attempt_at=?,last_error=? WHERE ${CAPTURE_KEY}`)
      .run(stage, now + Math.max(1000, delayMs), safeError(error), ...captureIds(job));
  }

  failCapture(job, error, now = Date.now()) {
    this.db.prepare(`UPDATE discord_attachment_captures SET stage='failed',last_error=? WHERE ${CAPTURE_KEY}`).run(safeError(error), ...captureIds(job));
    this.saveResponse(job, { ok: false, error: String(error?.message || "capture_failed") }, now);
  }

  rejectCapture(job, error, now = Date.now()) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.failCapture(job, error, now);
      this.releaseCapturePhoto(job);
      this.db.exec("COMMIT");
    } catch (failure) { this.db.exec("ROLLBACK"); throw failure; }
  }

  releaseCapturePhoto(job, cancelled = false) {
    this.db.prepare(`UPDATE discord_attachment_captures SET data=NULL,url=NULL,stage=CASE WHEN ? THEN 'failed' ELSE stage END WHERE ${CAPTURE_KEY}`).run(cancelled ? 1 : 0, ...captureIds(job));
  }

  finishWithoutReply(job, reason, now = Date.now()) {
    this.db.prepare(`UPDATE discord_jobs SET status='done',last_error=?,updated_at=? WHERE ${CAPTURE_KEY}`).run(safeError(reason), now, ...captureIds(job));
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
