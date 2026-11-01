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

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "attachment-capture-"));
  const config = loadDiscordBotConfig({ DISCORD_TOKEN: "T".repeat(60), AXIS_DISCORD_SECRET: "S".repeat(40),
    AXIS_DISCORD_GUILD_ID: "100000000000000001", AXIS_DISCORD_CHANNEL_IDS: "200000000000000001",
    AXIS_DISCORD_MATCH_PREFIX: "queue-", AXIS_DISCORD_STATE_PATH: join(directory, "state.db") });
  const f = { config, now: 10000, downloads: [], captures: [], ocr: [], replies: [], rest: 0, gates: [], sourceError: null, captureError: null, ocrStatus: 200 };
  f.gate = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); const gate = { promise, resolve }; f.gates.push(gate); return gate; };
  f.channel = { id: "300000000000000001", guildId: config.guildId, parentId: config.channelIds[0], name: "queue-5892" };
  f.message = (n = 1) => {
    const id = String(400000000000000000n + BigInt(n)), attachment = String(500000000000000000n + BigInt(n));
    return { id, guildId: config.guildId, channelId: f.channel.id, channel: f.channel,
      author: { id: "600000000000000001", bot: false }, attachments: new Map([[attachment,
        { id: attachment, name: "results.png", contentType: "image/png", url: `https://cdn.discordapp.com/attachments/${f.channel.id}/${attachment}/results.png?sig=private` }]]),
      reply: async (value) => { f.replies.push(value); } };
  };
  f.messages = new Map();
  f.channel.messages = { fetch: async (options) => options.message ? f.messages.get(options.message) : new Map() };
  f.client = { user: { id: "700000000000000001" }, channels: { fetch: async () => {
    f.rest++;
    if (f.sourceError) throw f.sourceError;
    return f.channel;
  } } };
  f.fetch = async (url, options = {}) => {
    if (String(url).startsWith("https://cdn.discordapp.com/")) {
      f.downloads.push(String(url));
      if (f.downloadGate) await f.downloadGate.promise;
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
    }
    const body = JSON.parse(options.body);
    if (body.captureOnly) {
      f.captures.push(body);
      if (f.uploadGate) await f.uploadGate.promise;
      if (f.captureError) throw f.captureError;
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
  f.drain = async () => { while (f.worker.downloadTasks.size || f.worker.uploadTasks.size) await Promise.all([...f.worker.downloadTasks, ...f.worker.uploadTasks]); };
  f.reopen = async () => { await f.worker.stop(); f.store.close(); f.store = new DiscordJobStore(config.statePath); f.worker = f.makeWorker(); };
  f.cleanup = async () => { for (const gate of f.gates) gate.resolve(); await f.worker.stop(); f.store.close(); await rm(directory, { recursive: true, force: true }); };
  return f;
}

test("Gateway attachments start downloading without REST, independently of a blocked OCR job", async () => {
  const f = await fixture();
  let processing;
  try {
    await f.accept();
    assert.equal(f.downloads.length, 1);
    assert.equal(f.rest, 0);
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
    assert.equal(f.rest, 0);
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
    assert.equal(saved.n, 3);
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
    assert.equal(f.store.db.prepare("SELECT stage,length(data) AS n FROM discord_attachment_captures").get().n, 3);
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
