import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { loadDiscordBotConfig } from "../lib/discord-bot/config.mjs";
import { DiscordJobStore, CAPTURE_STORAGE_LIMIT } from "../lib/discord-bot/state.mjs";
import { MAX_BYTES } from "../lib/discord-bot/security.mjs";
import { DiscordBotWorker } from "../lib/discord-bot/worker.mjs";
import { messageText } from "../lib/discord-bot/messages.mjs";

const PNG_BYTES = Buffer.from("89504e470d0a1a0a", "hex");

async function fixture(language = "ru") {
  const directory = await mkdtemp(join(tmpdir(), "attachment-capture-"));
  const config = loadDiscordBotConfig({ DISCORD_TOKEN: "T".repeat(60), AXIS_DISCORD_SECRET: "S".repeat(40),
    AXIS_DISCORD_GUILD_ID: "100000000000000001", AXIS_DISCORD_CHANNEL_IDS: "200000000000000001",
    AXIS_DISCORD_MATCH_PREFIX: "queue-", AXIS_DISCORD_LANG: language, AXIS_DISCORD_STATE_PATH: join(directory, "state.db") });
  const f = { config, now: 10000, downloads: [], captures: [], ocr: [], replies: [], notices: [], events: [], rest: 0, gates: [], sourceError: null, captureError: null, ocrStatus: 200 };
  f.gate = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); const gate = { promise, resolve }; f.gates.push(gate); return gate; };
  f.channel = { id: "300000000000000001", guildId: config.guildId, parentId: config.channelIds[0], name: "queue-5892" };
  f.message = (n = 1) => {
    const id = String(400000000000000000n + BigInt(n)), attachment = String(500000000000000000n + BigInt(n));
    return { id, guildId: config.guildId, channelId: f.channel.id, channel: f.channel,
      author: { id: "600000000000000001", bot: false }, attachments: new Map([[attachment,
        { id: attachment, name: "results.png", contentType: "image/png", url: `https://cdn.discordapp.com/attachments/${f.channel.id}/${attachment}/results.png?sig=private` }]]),
      reply: async (value) => {
        const phase = ["downloading", "downloaded"].find((key) => value.content === messageText(config.language, key));
        if (phase) {
          f.notices.push({ ...value, phase });
          if (f.noticeGate) await f.noticeGate.promise;
          if (f.noticeError) throw f.noticeError;
        } else f.replies.push(value);
      } };
  };
  f.messages = new Map();
  f.channel.messages = { fetch: async (options) => options.message ? f.messages.get(options.message) : new Map() };
  f.client = { user: { id: "700000000000000001" }, channels: { fetch: async () => {
    f.rest++; f.events.push("discord");
    if (f.sourceError) throw f.sourceError;
    return f.channel;
  } } };
  f.fetch = async (url, options = {}) => {
    if (String(url).startsWith("https://cdn.discordapp.com/")) {
      f.events.push("download"); f.downloads.push(String(url));
      if (f.downloadGate) await f.downloadGate.promise;
      return new Response(PNG_BYTES, { headers: { "content-type": "image/png" } });
    }
    const body = JSON.parse(options.body);
    if (body.captureOnly) {
      f.captures.push(body);
      if (f.uploadGate) await f.uploadGate.promise;
      if (f.captureError) throw f.captureError;
      if (f.captureStatus) return Response.json({ error: f.captureCode }, { status: f.captureStatus });
      if (f.captureResponse) return Response.json(f.captureResponse);
      return Response.json({ ok: true, captured: true, matchNumber: 5892, photo: { revision: "a".repeat(64), width: 1, height: 1 } });
    }
    f.ocr.push(body);
    if (f.ocrGate) await f.ocrGate.promise;
    if (f.ocrStatus !== 200) return Response.json({ error: "screenshot_match_mismatch" }, { status: f.ocrStatus });
    return Response.json({ ok: true, matchNumber: 5892, recognizedPlayers: 8, totalPlayers: 10, coveragePercent: 80, confidencePercent: 90, needsReview: true });
  };
  f.store = new DiscordJobStore(config.statePath);
  f.makeWorker = () => new DiscordBotWorker({ config, client: f.client, store: f.store, fetchImpl: f.fetch, logger: { warn() {} }, now: () => f.now });
  f.worker = f.makeWorker();
  f.accept = async (n = 1) => { const message = f.message(n); f.messages.set(message.id, message); await f.worker.handleMessage(message); return message; };
  f.drainCaptures = async () => { while (f.worker.downloadTasks.size || f.worker.uploadTasks.size) await Promise.all([...f.worker.downloadTasks, ...f.worker.uploadTasks]); };
  f.drain = async () => { await f.drainCaptures(); await Promise.all([...f.worker.captureNoticeTasks.values()]); };
  f.reopen = async () => { await f.worker.stop(); f.store.close(); f.store = new DiscordJobStore(config.statePath); f.worker = f.makeWorker(); };
  f.cleanup = async () => { for (const gate of f.gates) gate.resolve(); await f.worker.stop(); f.store.close(); await rm(directory, { recursive: true, force: true }); };
  return f;
}

test("Gateway ignores WebP and other unsupported attachments before enqueue, notices or CDN access", async () => {
  const f = await fixture();
  try {
    for (const [name, contentType] of [["image.png", "image/webp"], ["image.webp", "image/webp"], ["image.gif", "image/gif"]]) {
      const message = f.message();
      Object.assign([...message.attachments.values()][0], { name, contentType });
      assert.equal(await f.worker.handleMessage(message), 0);
    }
    await f.drain();
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM discord_jobs").get().n, 0);
    assert.equal(f.downloads.length, 0);
    assert.equal(f.notices.length, 0);
    assert.equal(f.captures.length, 0);
  } finally { await f.cleanup(); }
});

test("Gateway downloads start before Discord REST, independently of a blocked OCR job", async () => {
  const f = await fixture();
  let processing;
  try {
    await f.accept();
    assert.equal(f.downloads.length, 1);
    assert.equal(f.events[0], "download", "downloading must start before any Discord REST operation");
    await f.drain();
    f.ocrGate = f.gate();
    processing = f.worker.processJob(f.store.claimDue(f.now));
    assert.equal(f.ocr.length, 1);
    await f.accept(2);
    assert.equal(f.downloads.length, 2, "OCR must not own the downloader");
    await f.drain();
    assert.equal(f.captures.length, 2, "second image must reach the site before first OCR finishes");
    f.ocrGate.resolve();
    await processing;
  } finally { for (const gate of f.gates) gate.resolve(); await processing; await f.cleanup(); }
});

test("deleting the channel after receipt does not prevent capture or OCR of the accepted image", async () => {
  const f = await fixture();
  try {
    f.downloadGate = f.gate();
    await f.accept();
    f.sourceError = Object.assign(new Error("Unknown Channel"), { status: 404, code: 10003 });
    f.downloadGate.resolve();
    await f.drain();
    assert.equal(f.captures.length, 1);
    assert.equal(f.events[0], "download", "downloading must start before any Discord REST operation");
    const job = f.store.claimDue(f.now);
    await f.worker.processJob(job);
    const saved = f.store.get(job);
    assert.equal(saved.status, "done");
    assert.equal(JSON.parse(saved.response_json).ok, true);
    assert.equal(saved.acked_at, null);
    assert.equal(saved.last_error, "reply_source_unavailable");
    assert.equal(f.ocr.length, 1);
    assert.equal(f.store.readCapturePhoto(job), null, "local bytes may be released only after the site has them");
  } finally { await f.cleanup(); }
});

test("a slow site upload does not block new downloads and upload concurrency stays bounded", async () => {
  const f = await fixture();
  try {
    f.uploadGate = f.gate();
    await f.accept();
    await setImmediate();
    assert.equal(f.captures.length, 1);
    await f.accept(2);
    await f.accept(3);
    await setImmediate();
    assert.equal(f.downloads.length, 3);
    assert.equal(f.captures.length, 1);
    assert.equal(f.worker.uploadTasks.size, 1);
    assert.equal(f.store.claimDue(f.now), null, "OCR must wait for confirmed website capture");
    f.uploadGate.resolve();
    await f.drain();
    assert.equal(f.captures.length, 3);
  } finally { await f.cleanup(); }
});

test("at most two image downloads are active while later source URLs remain durable", async () => {
  const f = await fixture();
  try {
    f.downloadGate = f.gate();
    await f.accept(); await f.accept(2); await f.accept(3);
    assert.equal(f.downloads.length, 2);
    assert.equal(f.worker.downloadTasks.size, 2);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM discord_attachment_captures").get().n, 3);
    f.downloadGate.resolve();
    await f.drain();
    assert.equal(f.downloads.length, 3);
    assert.equal(f.captures.length, 3);
  } finally { await f.cleanup(); }
});

test("stop waits for the download commit and an interrupted upload resumes from SQLite without CDN", async () => {
  const f = await fixture();
  try {
    f.downloadGate = f.gate();
    await f.accept();
    let stopped = false;
    const stopping = f.worker.stop().then(() => { stopped = true; });
    await setImmediate();
    assert.equal(stopped, false);
    f.downloadGate.resolve();
    await stopping;
    assert.equal(f.captures.length, 0);
    const interrupted = f.store.claimCaptureUpload(f.now);
    assert.ok(interrupted);
    assert.ok(f.store.readCapturePhoto(interrupted));
    await f.reopen();
    f.worker.kickCaptures();
    await f.drain();
    assert.equal(f.downloads.length, 1);
    assert.equal(f.captures.length, 1);
    assert.equal(f.store.getCapture(interrupted).stage, "ready");
  } finally { await f.cleanup(); }
});

test("a lost capture response retries the same durable bytes instead of downloading again", async () => {
  const f = await fixture();
  try {
    f.captureError = new TypeError("fetch failed");
    await f.accept(); await f.drain();
    const saved = f.store.db.prepare("SELECT stage,length(data) AS n FROM discord_attachment_captures").get();
    assert.equal(saved.stage, "downloaded");
    assert.equal(saved.n, PNG_BYTES.length);
    f.captureError = null;
    f.now += 60000;
    await f.reopen(); f.worker.kickCaptures(); await f.drain();
    assert.equal(f.downloads.length, 1);
    assert.equal(f.captures.length, 2);
    assert.deepEqual(f.captures[0], f.captures[1]);
  } finally { await f.cleanup(); }
});

test("an old backend response cannot unlock OCR and retained bytes can be uploaded after the website upgrade", async () => {
  const f = await fixture();
  try {
    f.captureResponse = { ok: true, matchNumber: 5892, recognizedPlayers: 8, totalPlayers: 10, coveragePercent: 80 };
    await f.accept(); await f.drain();
    assert.equal(f.store.claimDue(f.now), null);
    assert.equal(f.store.db.prepare("SELECT stage,length(data) AS n FROM discord_attachment_captures").get().n, PNG_BYTES.length);
    f.captureResponse = null; f.now += 60000;
    f.worker.kickCaptures(); await f.drain();
    assert.ok(f.store.claimDue(f.now));
    assert.equal(f.downloads.length, 1);
    assert.equal(f.ocr.length, 0);
  } finally { await f.cleanup(); }
});

test("a reply retry remains claimable after BLOB cleanup and never repeats OCR", async () => {
  const f = await fixture();
  try {
    await f.accept(); await f.drain();
    f.sourceError = Object.assign(new Error("Missing Access"), { status: 403, code: 50001 });
    const job = f.store.claimDue(f.now);
    let failure;
    try { await f.worker.processJob(job); } catch (error) { failure = error; }
    assert.ok(failure);
    await f.worker.handleProcessingError(job, failure);
    assert.equal(f.store.readCapturePhoto(job), null);
    f.sourceError = null; f.now += 60000;
    await f.reopen();
    const retry = f.store.claimDue(f.now);
    assert.ok(retry);
    await f.worker.processJob(retry);
    assert.equal(f.ocr.length, 1);
    assert.equal(f.replies.length, 1);
    assert.equal(f.store.get(job).status, "done");
  } finally { await f.cleanup(); }
});

test("an OCR mismatch keeps the already captured website photo and reports the mismatch", async () => {
  const f = await fixture();
  try {
    await f.accept(); await f.drain();
    f.ocrStatus = 422;
    const job = f.store.claimDue(f.now);
    await f.worker.processJob(job);
    assert.equal(f.captures.length, 1);
    assert.equal(f.store.getCapture(job).uploaded_at, f.now);
    assert.equal(JSON.parse(f.store.get(job).response_json).error, "screenshot_match_mismatch");
    assert.match(f.replies[0].content, /не соответствует этому матчу/);
  } finally { await f.cleanup(); }
});

test("capture reservations stop at the byte bound without losing queued metadata", async () => {
  const f = await fixture();
  try {
    f.worker.kickCaptures = () => {};
    for (let n = 1; n <= 26; n++) await f.accept(n);
    const count = Math.floor(CAPTURE_STORAGE_LIMIT / MAX_BYTES);
    const claims = Array.from({ length: count }, () => f.store.claimCaptureDownload(f.now));
    assert.ok(claims.every(Boolean));
    assert.equal(f.store.claimCaptureDownload(f.now), null);
    f.store.saveCapturePhoto(claims[0], { data: "AQ==", bytes: 1, contentType: "image/png" }, f.now);
    assert.ok(f.store.claimCaptureDownload(f.now), "completed small download releases the unused reservation");
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM discord_attachment_captures").get().n, 26);
  } finally { await f.cleanup(); }
});

test("revoking the configured category blocks captured OCR and releases local data", async () => {
  const f = await fixture();
  try {
    await f.accept(); await f.drain();
    const job = f.store.claimDue(f.now);
    f.config.channelIdSet.clear();
    await f.worker.processJob(job);
    assert.equal(f.ocr.length, 0);
    assert.equal(f.store.readCapturePhoto(job), null);
    assert.equal(f.store.get(job).status, "failed");
    assert.equal(f.store.getCapture(job).stage, "failed");
  } finally { await f.cleanup(); }
});

test("a mismatched CDN attachment ID is rejected before enqueue or download", async () => {
  const f = await fixture();
  try {
    const message = f.message();
    const attachment = [...message.attachments.values()][0];
    attachment.url = attachment.url.replace(attachment.id, "500000000000000099");
    await assert.rejects(() => f.worker.handleMessage(message), /attachment_source_mismatch/);
    assert.equal(f.downloads.length, 0);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM discord_jobs").get().n, 0);
  } finally { await f.cleanup(); }
});


test("a definitive non-scoreboard rejection deletes local bytes and does not enter OCR", async () => {
  const f = await fixture();
  try {
    f.captureStatus = 422; f.captureCode = "not_scoreboard";
    await f.accept(); await f.drain();
    const job = f.store.claimDue(f.now);
    assert.ok(job);
    assert.equal(f.store.readCapturePhoto(job), null);
    assert.equal(f.store.getCapture(job).uploaded_at, null);
    assert.equal(f.store.getCapture(job).stage, "failed");
    await f.worker.processJob(job);
    assert.equal(f.ocr.length, 0);
    assert.match(f.replies[0].content, /итоговая таблица результатов не обнаружена/);
    assert.equal(f.store.get(job).status, "done");
    await f.reopen(); f.worker.kickCaptures(); await f.drain();
    assert.equal(f.downloads.length, 1, "rejected attachments must not be downloaded again");
  } finally { await f.cleanup(); }
});

test("other rejection types do not delete the last local copy", async () => {
  const f = await fixture();
  try {
    f.captureStatus = 422; f.captureCode = "screenshot_match_mismatch";
    await f.accept(); await f.drain();
    const job = f.store.claimDue(f.now);
    assert.ok(job);
    assert.equal(f.store.readCapturePhoto(job).bytes, PNG_BYTES.length);
    assert.equal(f.ocr.length, 0);
  } finally { await f.cleanup(); }
});

test("reject cleanup is atomic if storing the failure response fails", async () => {
  const f = await fixture();
  try {
    f.worker.kickCaptures = () => {};
    await f.accept();
    const capture = f.store.claimCaptureDownload(f.now);
    f.store.saveCapturePhoto(capture, { data: "AQID", bytes: 3, contentType: "image/png" }, f.now);
    f.store.db.exec("CREATE TRIGGER reject_failure BEFORE UPDATE OF response_json ON discord_jobs BEGIN SELECT RAISE(ABORT, 'forced response failure'); END");
    assert.throws(() => f.store.rejectCapture(capture, new Error("not_scoreboard"), f.now), /forced response failure/);
    assert.equal(f.store.readCapturePhoto(capture).bytes, 3);
    assert.equal(f.store.getCapture(capture).stage, "downloaded");
  } finally { await f.cleanup(); }
});


test("two ordered progress replies bracket the durable download and precede the final result", async () => {
  const f = await fixture();
  try {
    f.downloadGate = f.gate();
    await f.accept();
    await setImmediate();
    assert.deepEqual(f.notices.map((n) => n.phase), ["downloading"]);
    const job = f.store.db.prepare("SELECT * FROM discord_jobs").get();
    assert.equal(f.store.readCapturePhoto(job), null);
    assert.equal(f.store.getCapture(job).downloaded_notice_at, null);
    f.downloadGate.resolve(); await f.drain();
    assert.deepEqual(f.notices.map((n) => n.phase), ["downloading", "downloaded"]);
    assert.equal(f.store.readCapturePhoto(job).bytes, PNG_BYTES.length);
    assert.equal(f.store.getCapture(job).downloaded_notice_at, f.now);
    assert.equal(f.ocr.length, 0);
    assert.equal(f.replies.length, 0);
    assert.ok(f.notices.every((n) => n.enforceNonce && n.allowedMentions.parse.length === 0));
    assert.notEqual(f.notices[0].nonce, f.notices[1].nonce);
    await f.worker.processJob(f.store.claimDue(f.now));
    assert.equal(f.replies.length, 1);
    assert.notEqual(f.replies[0].nonce, f.notices[1].nonce);
  } finally { await f.cleanup(); }
});

test("a stalled progress reply never blocks downloads, website retention or later attachments", async () => {
  const f = await fixture(); let processing;
  try {
    f.noticeGate = f.gate();
    await f.accept(); await f.drainCaptures();
    assert.equal(f.captures.length, 1);
    assert.deepEqual(f.notices.map((n) => n.phase), ["downloading"]);
    processing = f.worker.processJob(f.store.claimDue(f.now));
    await setImmediate();
    assert.equal(f.ocr.length, 1);
    assert.equal(f.replies.length, 0, "the final reply must not overtake progress replies");
    await f.accept(2); await f.drainCaptures();
    assert.equal(f.downloads.length, 2);
    assert.equal(f.captures.length, 2);
    f.noticeGate.resolve(); await f.drain(); await processing;
    assert.equal(f.replies.length, 1);
    assert.equal(f.notices.length, 4);
  } finally { for (const gate of f.gates) gate.resolve(); await processing; await f.cleanup(); }
});

test("progress failures preserve captured bytes and do not become download retries", async () => {
  const f = await fixture();
  try {
    f.noticeError = Object.assign(new Error("Missing Permissions"), { status: 403, code: 50013 });
    await f.accept(); await f.drain();
    assert.equal(f.downloads.length, 1);
    assert.equal(f.captures.length, 1);
    const job = f.store.claimDue(f.now);
    assert.equal(f.store.readCapturePhoto(job).bytes, PNG_BYTES.length);
    f.noticeError = null;
    await f.worker.processJob(job);
    assert.equal(f.ocr.length, 1);
    assert.equal(f.replies.length, 1);
  } finally { await f.cleanup(); }
});

test("catch-up and upload retries after restart do not duplicate completed progress notices", async () => {
  const f = await fixture();
  try {
    f.captureError = new TypeError("fetch failed");
    await f.accept(); await f.drain();
    assert.equal(f.notices.length, 2);
    f.captureError = null; f.now += 60000;
    await f.reopen();
    await f.worker.handleMessage(f.messages.values().next().value);
    await f.drain();
    assert.equal(f.downloads.length, 1);
    assert.equal(f.captures.length, 2);
    assert.equal(f.notices.length, 2);
  } finally { await f.cleanup(); }
});


test("progress replies use the configured English language", async () => {
  const f = await fixture("en");
  try {
    await f.accept(); await f.drain();
    assert.deepEqual(f.notices.map((n) => n.content), ["Image received. Starting the download.", "Image downloaded and saved by the bot. Checking the results."]);
  } finally { await f.cleanup(); }
});

test("existing capture databases acquire notice fields without losing durable image bytes", async () => {
  const f = await fixture();
  try {
    await f.accept(); await f.drain();
    const job = f.store.db.prepare("SELECT * FROM discord_jobs").get();
    f.store.db.exec("ALTER TABLE discord_attachment_captures DROP COLUMN downloading_notice_at; ALTER TABLE discord_attachment_captures DROP COLUMN downloaded_notice_at");
    await f.reopen();
    assert.equal(f.store.readCapturePhoto(job).bytes, PNG_BYTES.length);
    assert.equal(f.store.getCapture(job).stage, "ready");
    assert.equal(f.store.getCapture(job).downloading_notice_at, null);
    assert.equal(f.store.getCapture(job).downloaded_notice_at, null);
  } finally { await f.cleanup(); }
});

test("a notice delivered before a crash is recovered from Discord without sending it twice", async () => {
  const f = await fixture();
  try {
    const message = await f.accept(); await f.drain();
    const delivered = f.notices.find((n) => n.phase === "downloaded");
    const job = f.store.db.prepare("SELECT * FROM discord_jobs").get();
    f.store.db.exec("UPDATE discord_attachment_captures SET downloaded_notice_at=NULL");
    await f.reopen();
    f.channel.messages.fetch = async (options) => options.message ? message : new Map([["notice", { ...delivered, author: f.client.user, reference: { messageId: message.id } }]]);
    f.worker.queueCaptureNotice(job, "downloaded"); await f.drain();
    assert.equal(f.notices.length, 2);
    assert.equal(f.store.getCapture(job).downloaded_notice_at, f.now);
  } finally { await f.cleanup(); }
});
