import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadDiscordBotConfig } from "../lib/discord-bot/config.mjs";
import { DiscordJobStore } from "../lib/discord-bot/state.mjs";
import { DiscordBotWorker } from "../lib/discord-bot/worker.mjs";
import { downloadAttachment, isAllowedMessage, MAX_BYTES, resolveMatchNumber, validateAttachmentUrl } from "../lib/discord-bot/security.mjs";
import { resultMessage } from "../lib/discord-bot/messages.mjs";

const ENV = {
  DISCORD_TOKEN: "A".repeat(60), AXIS_DISCORD_SECRET: "S".repeat(40), AXIS_DISCORD_GUILD_ID: "100000000000000001",
  AXIS_DISCORD_CHANNEL_IDS: "200000000000000001", AXIS_DISCORD_MATCH_CHANNELS: '{"200000000000000001":42}',
};

function closeStore(store) {
  try { store?.close(); } catch { /* cleanup must not replace the test assertion */ }
}

async function removeDirectory(directory) {
  try { await rm(directory, { recursive: true, force: true }); }
  catch { /* a cleanup failure must not mask the test assertion */ }
}

function discordApiError(code, status, message = `Discord API ${code}`) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

test("Discord config fails closed when a match binding is missing", () => {
  assert.throws(() => loadDiscordBotConfig({ ...ENV, AXIS_DISCORD_MATCH_CHANNELS: "" }), /MATCH_CHANNELS or .*PREFIX/);
  assert.throws(() => loadDiscordBotConfig({ ...ENV, AXIS_DISCORD_API_BASE_URL: "http://public.example" }), /HTTPS/);
  assert.throws(() => loadDiscordBotConfig({ ...ENV, AXIS_DISCORD_BOOTSTRAP_MESSAGES: "101" }), /0\.\.100/);
  const config = loadDiscordBotConfig(ENV);
  assert.equal(config.matchChannels.get("200000000000000001"), 42);
  assert.throws(() => loadDiscordBotConfig({ ...ENV, AXIS_DISCORD_REMINDER_TEXT: "x".repeat(1801) }), /1800/);
});

test("new match channels and newly created threads get one durable reminder", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axis-discord-reminder-"));
  let store;
  let worker;
  try {
    const config = loadDiscordBotConfig({ ...ENV, AXIS_DISCORD_STATE_PATH: join(directory, "state.db"),
      AXIS_DISCORD_MATCH_CHANNELS: "{}", AXIS_DISCORD_MATCH_PREFIX: "queue-" });
    const sent = [];
    const channel = { id: "200000000000000002", guildId: config.guildId, parentId: ENV.AXIS_DISCORD_CHANNEL_IDS,
      name: "queue-5771", send: async (value) => { sent.push(value); return { id: "600000000000000001" }; } };
    const client = new EventEmitter();
    client.channels = { fetch: async () => channel };
    store = new DiscordJobStore(config.statePath);
    worker = new DiscordBotWorker({ config, client, store });
    worker.runLoop = async () => {};
    worker.catchUpConfiguredChannels = async () => {};
    await worker.start();
    assert.equal(store.claimReminderDue(), null, "startup must not announce in old channels");
    client.emit("threadCreate", channel, false);
    client.emit("channelCreate", { ...channel, guildId: "100000000000000099" });
    client.emit("channelCreate", { ...channel, parentId: null });
    client.emit("channelCreate", { ...channel, name: "general" });
    assert.equal(store.claimReminderDue(), null, "joined threads and unrelated channels are ignored");
    client.emit("channelCreate", channel);
    client.emit("threadCreate", channel, true);
    await worker.processMatchReminder(store.claimReminderDue());
    assert.equal(sent.length, 1);
    assert.match(sent[0].content, /Перед выбором победителя.*скриншот/);
    assert.deepEqual(sent[0].allowedMentions, { parse: [] });
    assert.equal(sent[0].enforceNonce, true);
    await worker.stop();
    assert.equal(client.listenerCount("channelCreate"), 0);
    assert.equal(client.listenerCount("threadCreate"), 0);
    store.close();
    store = new DiscordJobStore(config.statePath);
    worker = new DiscordBotWorker({ config, client, store });
    worker.queueMatchReminder(channel);
    assert.equal(store.claimReminderDue(), null, "restart must preserve a sent reminder");
  } finally {
    await worker?.stop();
    closeStore(store);
    await removeDirectory(directory);
  }
});

test("pending reminders survive a permission outage and use private custom text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axis-discord-reminder-retry-"));
  let store;
  try {
    const config = loadDiscordBotConfig({ ...ENV, AXIS_DISCORD_STATE_PATH: join(directory, "state.db"),
      AXIS_DISCORD_REMINDER_TEXT: "Сначала скриншот, затем победитель." });
    let denied = true;
    const sent = [];
    const channel = { id: ENV.AXIS_DISCORD_CHANNEL_IDS, guildId: config.guildId, parentId: null, name: "match-42",
      send: async (value) => {
        if (denied) throw discordApiError(50013, 403);
        sent.push(value); return { id: "600000000000000002" };
      } };
    const client = { channels: { fetch: async () => channel } };
    store = new DiscordJobStore(config.statePath);
    const first = new DiscordBotWorker({ config, client, store, logger: { warn() {} } });
    first.queueMatchReminder(channel);
    await first.processMatchReminder(store.claimReminderDue());
    assert.equal(store.claimReminderDue(), null, "retry must back off");
    store.close();
    store = new DiscordJobStore(config.statePath);
    denied = false;
    const second = new DiscordBotWorker({ config, client, store });
    await second.processMatchReminder(store.claimReminderDue(Date.now() + 60_000));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].content, config.reminderText);
    assert.equal(store.claimReminderDue(Date.now() + 120_000), null);
  } finally {
    closeStore(store);
    await removeDirectory(directory);
  }
});

test("a queued reminder is cancelled when its match binding is revoked", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axis-discord-reminder-revoked-"));
  let store;
  try {
    const config = loadDiscordBotConfig({ ...ENV, AXIS_DISCORD_STATE_PATH: join(directory, "state.db") });
    let sends = 0;
    const channel = { id: ENV.AXIS_DISCORD_CHANNEL_IDS, guildId: config.guildId, parentId: null, name: "match-42",
      send: async () => { sends++; return { id: "600000000000000003" }; } };
    store = new DiscordJobStore(config.statePath);
    const client = { channels: { fetch: async () => channel } };
    const worker = new DiscordBotWorker({ config, client, store, logger: { warn() {} } });
    worker.queueMatchReminder(channel);
    const queued = store.claimReminderDue();
    config.matchChannels.set(channel.id, 43);
    await worker.processMatchReminder(queued);
    assert.equal(sends, 0);
    assert.equal(store.claimReminderDue(Date.now() + 60_000), null);
  } finally {
    closeStore(store);
    await removeDirectory(directory);
  }
});

test("confirmed queue-5771 chat binds to match 5771 within the channel allowlist", () => {
  const config = loadDiscordBotConfig({ ...ENV, AXIS_DISCORD_MATCH_CHANNELS: "{}", AXIS_DISCORD_MATCH_PREFIX: "queue-" });
  const channel = { id: "200000000000000001", parentId: null, name: "queue-5771" };
  assert.equal(resolveMatchNumber(channel, config), 5771);
  assert.equal(resolveMatchNumber({ ...channel, name: "queue-5771-copy" }, config), null);
  assert.equal(resolveMatchNumber({ ...channel, name: "queue-99999999999999999" }, config), null);
  const message = { guildId: config.guildId, channelId: channel.id, channel, author: { bot: false } };
  assert.equal(isAllowedMessage(message, config), true);
  assert.equal(isAllowedMessage({ ...message, channelId: "200000000000000099", channel: { ...channel, id: "200000000000000099" } }, config), false);
});

test("Discord reply names missing, unmatched and conflicting players safely", () => {
  const text = resultMessage("ru", { ok: true, needsReview: true, recognizedPlayers: 7, totalPlayers: 10, coveragePercent: 70,
    confidencePercent: null, missingPlayers: ["Missing *One*"], unmatchedNames: ["Wrong @Nick"], conflictPlayers: ["Conflict [Two]"] });
  assert.match(text, /Missing \\\*One\\\*/);
  assert.match(text, /Wrong \\\@Nick/);
  assert.match(text, /Conflict \\\[Two\\\]/);
  assert.doesNotMatch(text, /OCR 0%/);
  assert.ok(text.length <= 2000);
});

test("attachment URLs are restricted to Discord CDN and source channel", () => {
  assert.throws(() => validateAttachmentUrl("https://example.com/attachments/200000000000000001/300000000000000001/a.png?x=1", ["200000000000000001"]));
  assert.throws(() => validateAttachmentUrl("https://cdn.discordapp.com/attachments/999/300000000000000001/a.png?x=1", ["200000000000000001"]), /source/);
  const url = validateAttachmentUrl("https://cdn.discordapp.com/attachments/200000000000000001/300000000000000001/a.png?x=1", ["200000000000000001"]);
  assert.equal(url.hostname, "cdn.discordapp.com");
});

test("download bounds image body and rejects redirects", async () => {
  const attachment = { id: "300000000000000001", name: "result.png", contentType: "image/png", url: "https://cdn.discordapp.com/attachments/200000000000000001/300000000000000001/a.png?x=1" };
  const smallFetch = async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
  const result = await downloadAttachment(attachment, ["200000000000000001"], smallFetch);
  assert.equal(result.data, "AQID");
  const badFetch = async () => new Response(null, { status: 302, headers: { location: "https://example.com" } });
  await assert.rejects(() => downloadAttachment(attachment, ["200000000000000001"], badFetch), /attachment_http_302/);
});

test("download cancels an unread response body before rejecting metadata violations", async () => {
  const attachment = { id: "300000000000000001", name: "result.png", contentType: "image/png", url: "https://cdn.discordapp.com/attachments/200000000000000001/300000000000000001/a.png?x=1" };
  const streamWithSpy = () => {
    const state = { reads: 0, cancelled: false };
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1])); },
      pull(controller) { state.reads += 1; controller.enqueue(new Uint8Array([1])); },
      cancel() { state.cancelled = true; },
    });
    return { state, stream };
  };
  const oversized = streamWithSpy();
  await assert.rejects(() => downloadAttachment({ ...attachment }, ["200000000000000001"], async () => ({
    ok: true,
    headers: new Headers({ "content-type": "image/png", "content-length": String(MAX_BYTES + 1) }),
    body: oversized.stream,
  })), /attachment_too_large/);
  assert.equal(oversized.state.reads, 0);
  assert.equal(oversized.state.cancelled, true);

  const unsupported = streamWithSpy();
  await assert.rejects(() => downloadAttachment({ ...attachment }, ["200000000000000001"], async () => ({
    ok: true,
    headers: new Headers({ "content-type": "text/plain" }),
    body: unsupported.stream,
  })), /unsupported_attachment/);
  assert.equal(unsupported.state.reads, 0);
  assert.equal(unsupported.state.cancelled, true);
});

test("state store deduplicates source attachments and recovers running jobs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axis-discord-"));
  const path = join(directory, "state.db");
  let store;
  let reopened;
  try {
    store = new DiscordJobStore(path);
    const job = { guildId: "100000000000000001", channelId: "200000000000000001", parentChannelId: null, messageId: "400000000000000001", attachmentId: "300000000000000001", authorId: "500000000000000001", matchNumber: 42 };
    assert.equal(store.enqueue(job).inserted, true);
    assert.equal(store.enqueue(job).inserted, false);
    const claimed = store.claimDue();
    assert.equal(claimed.status, "running");
    closeStore(store);
    reopened = new DiscordJobStore(path);
    assert.equal(reopened.claimDue().status, "running");
  } finally {
    closeStore(store);
    closeStore(reopened);
    await removeDirectory(directory);
  }
});

test("a full attachment batch does not advance its checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axis-discord-atomic-"));
  let store;
  try {
    store = new DiscordJobStore(join(directory, "state.db"));
    const base = { guildId: "100000000000000001", channelId: "200000000000000001", parentChannelId: null, messageId: "400000000000000002", authorId: "500000000000000001", matchNumber: 42 };
    const jobs = [{ ...base, attachmentId: "300000000000000001" }, { ...base, attachmentId: "300000000000000002" }];
    assert.throws(() => store.enqueueMany(jobs, base.channelId, base.messageId, Date.now(), 1), /queue_full/);
    assert.equal(store.checkpoint(base.channelId), null);
    assert.equal(store.claimDue(), null);
  } finally {
    closeStore(store);
    await removeDirectory(directory);
  }
});

test("worker reads a fresh attachment URL, submits it and replies once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axis-discord-worker-"));
  let store;
  try {
    const config = loadDiscordBotConfig({ ...ENV, AXIS_DISCORD_STATE_PATH: join(directory, "state.db") });
    const replies = [];
    const sourceMessage = {
      id: "400000000000000001", guildId: config.guildId, channelId: "200000000000000001",
      author: { id: "500000000000000001", bot: false }, webhookId: null,
      channel: null,
      attachments: new Map([["300000000000000001", { id: "300000000000000001", name: "result.png", contentType: "image/png", url: "https://cdn.discordapp.com/attachments/200000000000000001/300000000000000001/result.png?sig=1" }]]),
      reply: async (value) => replies.push(value),
    };
    const channel = { id: "200000000000000001", parentId: null, name: "match-42", messages: { fetch: async (arg) => (typeof arg === "string" || arg?.message) ? sourceMessage : new Map() } };
    sourceMessage.channel = channel;
    const client = { user: { id: "900000000000000001" }, channels: { fetch: async () => channel } };
    const apiFetch = async (url) => {
      if (String(url).includes("/api/integrations/")) return new Response(JSON.stringify({ ok: true, matchNumber: 42, recognizedPlayers: 8, totalPlayers: 10, coveragePercent: 80, confidencePercent: 91, needsReview: false }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
    };
    store = new DiscordJobStore(config.statePath);
    const worker = new DiscordBotWorker({ config, client, store, fetchImpl: apiFetch });
    assert.equal(await worker.handleMessage(sourceMessage), 1);
    const job = store.claimDue();
    await worker.processJob(job);
    assert.equal(replies.length, 1);
    assert.match(replies[0].content, /80%/);
    assert.equal(store.get(job).status, "done");
    await worker.processJob(job);
    assert.equal(replies.length, 1);
  } finally {
    closeStore(store);
    await removeDirectory(directory);
  }
});

test("a saved backend response is acknowledged after restart without re-downloading OCR input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axis-discord-restart-"));
  let first;
  let store;
  try {
    const config = loadDiscordBotConfig({ ...ENV, AXIS_DISCORD_STATE_PATH: join(directory, "state.db") });
    const job = { guildId: config.guildId, channelId: "200000000000000001", parentChannelId: null, messageId: "400000000000000003", attachmentId: "300000000000000003", authorId: "500000000000000001", matchNumber: 42 };
    first = new DiscordJobStore(config.statePath);
    first.enqueue(job);
    const claimed = first.claimDue();
    first.saveResponse(claimed, { ok: true, matchNumber: 42, recognizedPlayers: 10, totalPlayers: 10, coveragePercent: 100, confidencePercent: 95, needsReview: false });
    closeStore(first);
    store = new DiscordJobStore(config.statePath);
    const replies = [];
    const source = { id: job.messageId, guildId: config.guildId, channelId: job.channelId, author: { id: job.authorId, bot: false }, webhookId: null, attachments: new Map(), channel: null, reply: async (value) => replies.push(value) };
    const channel = { id: job.channelId, parentId: null, name: "match-42", messages: { fetch: async (arg) => (typeof arg === "string" || arg?.message) ? source : new Map() } };
    source.channel = channel;
    const client = { user: { id: "900000000000000001" }, channels: { fetch: async () => channel } };
    const worker = new DiscordBotWorker({ config, client, store, fetchImpl: async () => { throw new Error("download must not run"); } });
    await worker.processJob(store.claimDue());
    assert.equal(replies.length, 1);
    assert.equal(store.get({ guild_id: job.guildId, channel_id: job.channelId, message_id: job.messageId, attachment_id: job.attachmentId }).status, "done");
  } finally {
    closeStore(first);
    closeStore(store);
    await removeDirectory(directory);
  }
});

test("category catch-up recovers direct match channels from REST after restart and on subsequent passes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axis-discord-category-"));
  let store;
  try {
    const config = loadDiscordBotConfig({ ...ENV, AXIS_DISCORD_STATE_PATH: join(directory, "state.db"),
      AXIS_DISCORD_MATCH_CHANNELS: "", AXIS_DISCORD_MATCH_PREFIX: "queue-" });
    const categoryId = config.channelIds[0];
    const attachment = { id: "300000000000000031", name: "result.png", contentType: "image/png" };
    const message = { id: "400000000000000031", guildId: config.guildId, channelId: "200000000000000031",
      author: { id: "500000000000000001", bot: false }, attachments: new Map([[attachment.id, attachment]]) };
    const requests = [];
    const matchChannel = { id: message.channelId, parentId: categoryId, guildId: config.guildId, name: "queue-5771",
      messages: { fetch: async options => { requests.push(options); return options.after ? new Map() : new Map([[message.id, message]]); } } };
    message.channel = matchChannel;
    let forbiddenFetches = 0;
    const forbidden = { id: "200000000000000032", parentId: "200000000000000099", name: "queue-5772",
      messages: { fetch: async () => { forbiddenFetches++; return new Map(); } } };
    const nested = { ...forbidden, id: "200000000000000033", parentId: matchChannel.id, name: "queue-5771" };
    const unrelated = { ...forbidden, id: "200000000000000034", parentId: categoryId, name: "general" };
    let discoveries = 0;
    const category = { id: categoryId, type: 4, guildId: config.guildId, guild: { channels: { fetch: async () => {
      discoveries++;
      return new Map([matchChannel, forbidden, nested, unrelated].map(channel => [channel.id, channel]));
    } } } };
    const client = { channels: { fetch: async () => category } };
    store = new DiscordJobStore(config.statePath);
    const worker = new DiscordBotWorker({ config, client, store });
    await worker.catchUpConfiguredChannels();
    assert.equal(store.checkpoint(matchChannel.id), message.id);
    const claimed = store.claimDue();
    assert.equal(claimed.match_number, 5771);
    assert.equal(claimed.parent_channel_id, categoryId);
    store.markAcked(claimed);
    await worker.catchUpConfiguredChannels();
    assert.equal(discoveries, 2, "periodic catch-up refreshes category children instead of relying on a stale cache");
    assert.equal(requests[1].after, message.id);
    store.close();
    store = new DiscordJobStore(config.statePath);
    await new DiscordBotWorker({ config, client, store }).catchUpConfiguredChannels();
    assert.equal(requests[2].after, message.id, "restart uses the persisted history checkpoint");
    assert.equal(forbiddenFetches, 0, "foreign, nested and unrelated channels are never read");
    assert.equal(store.claimDue(), null, "checkpointed images are not enqueued again");
  } finally {
    closeStore(store);
    await removeDirectory(directory);
  }
});

test("startup catch-up includes active threads under an allowed parent channel", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axis-discord-threads-"));
  let store;
  try {
    const config = loadDiscordBotConfig({ ...ENV, AXIS_DISCORD_STATE_PATH: join(directory, "state.db"), AXIS_DISCORD_MATCH_CHANNELS: '{"200000000000000001":42}' });
    const thread = { id: "200000000000000002", parentId: "200000000000000001", name: "match-thread", messages: { fetch: async () => new Map([["400000000000000004", { id: "400000000000000004", createdTimestamp: 1, guildId: config.guildId, channelId: "200000000000000002", author: { id: "500000000000000001", bot: false }, webhookId: null, channel: thread, attachments: new Map() }]]) } };
    const parent = { id: "200000000000000001", parentId: null, name: "matches", messages: { fetch: async () => new Map() }, threads: { fetchActive: async () => ({ threads: new Map([[thread.id, thread]]) }) } };
    const client = { channels: { fetch: async (id) => id === parent.id ? parent : thread }, user: { id: "900000000000000001" } };
    store = new DiscordJobStore(config.statePath);
    const worker = new DiscordBotWorker({ config, client, store });
    await worker.catchUpConfiguredChannels();
    assert.equal(store.checkpoint(thread.id), "400000000000000004");
  } finally {
    closeStore(store);
    await removeDirectory(directory);
  }
});

test("a later live message cannot advance past an image rejected by a full queue", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axis-discord-gap-"));
  let store;
  try {
    const config = loadDiscordBotConfig({ ...ENV, AXIS_DISCORD_STATE_PATH: join(directory, "state.db"), AXIS_DISCORD_MAX_PENDING: "1" });
    const attachment = { id: "300000000000000005", name: "result.png", contentType: "image/png", url: "https://cdn.discordapp.com/attachments/200000000000000001/300000000000000005/result.png?sig=1" };
    const image = { id: "400000000000000005", createdTimestamp: 1, guildId: config.guildId, channelId: "200000000000000001", author: { id: "500000000000000001", bot: false }, webhookId: null, attachments: new Map([[attachment.id, attachment]]), channel: null };
    const plain = { id: "400000000000000006", createdTimestamp: 2, guildId: config.guildId, channelId: "200000000000000001", author: { id: "500000000000000001", bot: false }, webhookId: null, attachments: new Map(), channel: null };
    const channel = { id: "200000000000000001", parentId: null, name: "match-42", messages: { fetch: async () => new Map([[image.id, image], [plain.id, plain]]) } };
    image.channel = channel; plain.channel = channel;
    const client = { user: { id: "900000000000000001" }, channels: { fetch: async () => channel } };
    store = new DiscordJobStore(config.statePath);
    const filler = { guildId: config.guildId, channelId: channel.id, parentChannelId: null, messageId: "400000000000000007", attachmentId: "300000000000000007", authorId: "500000000000000001", matchNumber: 42 };
    store.enqueue(filler);
    const worker = new DiscordBotWorker({ config, client, store });
    await assert.rejects(() => worker.handleMessage(image), /queue_full/);
    await worker.handleMessage(plain);
    assert.equal(store.checkpoint(channel.id), null);
    const claimed = store.claimDue();
    store.markAcked(claimed);
    await worker.catchUpChannel(channel);
    assert.equal(store.checkpoint(channel.id), plain.id);
    assert.equal(store.get({ guild_id: config.guildId, channel_id: channel.id, message_id: image.id, attachment_id: attachment.id }).status, "pending");
  } finally {
    closeStore(store);
    await removeDirectory(directory);
  }
});

test("distinct multi-image replies are not suppressed by history entries without nonces", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axis-discord-nonce-"));
  let store;
  try {
    const config = loadDiscordBotConfig({ ...ENV, AXIS_DISCORD_STATE_PATH: join(directory, "state.db") });
    const history = [];
    const replies = [];
    const sourceMessage = {
      id: "400000000000000010", guildId: config.guildId, channelId: "200000000000000001",
      author: { id: "500000000000000001", bot: false }, webhookId: null, channel: null,
      attachments: new Map([
        ["300000000000000010", { id: "300000000000000010", name: "one.png", contentType: "image/png", url: "https://cdn.discordapp.com/attachments/200000000000000001/300000000000000010/one.png?sig=1" }],
        ["300000000000000011", { id: "300000000000000011", name: "two.png", contentType: "image/png", url: "https://cdn.discordapp.com/attachments/200000000000000001/300000000000000011/two.png?sig=1" }],
      ]),
      reply: async (value) => {
        replies.push(value);
        // Discord history may omit the nonce even though the original reply had
        // one. Keep the content so the worker can distinguish these replies.
        history.push({ author: { id: "900000000000000001" }, reference: { messageId: sourceMessage.id }, content: value.content, nonce: null });
      },
    };
    const channel = {
      id: sourceMessage.channelId, parentId: null, name: "match-42", messages: {
        fetch: async (arg) => (typeof arg === "string" || arg?.message) ? sourceMessage : new Map(history.map((item, index) => [String(index), item])),
      },
    };
    sourceMessage.channel = channel;
    let submissions = 0;
    const client = { user: { id: "900000000000000001" }, channels: { fetch: async () => channel } };
    const apiFetch = async (url) => {
      if (String(url).includes("/api/integrations/")) {
        submissions += 1;
        const complete = submissions === 2;
        return new Response(JSON.stringify({ ok: true, matchNumber: 42, recognizedPlayers: complete ? 10 : 8, totalPlayers: 10,
          coveragePercent: complete ? 100 : 80, confidencePercent: 91, needsReview: false }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
    };
    store = new DiscordJobStore(config.statePath);
    const worker = new DiscordBotWorker({ config, client, store, fetchImpl: apiFetch });
    assert.equal(await worker.handleMessage(sourceMessage), 2);
    for (let job = store.claimDue(); job; job = store.claimDue()) await worker.processJob(job);
    assert.equal(replies.length, 2);
    assert.match(replies[0].content, /80%/);
    assert.match(replies[1].content, /100%/);
    assert.equal(await worker.findExistingAck(channel, sourceMessage.id, "nonce-not-present", replies[0].content), true);
  } finally {
    closeStore(store);
    await removeDirectory(directory);
  }
});

test("a revoked source fails a queued job without fetching Discord or submitting it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axis-discord-revoked-"));
  let store;
  try {
    const config = loadDiscordBotConfig({ ...ENV, AXIS_DISCORD_STATE_PATH: join(directory, "state.db") });
    const job = { guildId: config.guildId, channelId: "200000000000000001", parentChannelId: null, messageId: "400000000000000012", attachmentId: "300000000000000012", authorId: "500000000000000001", matchNumber: 42 };
    store = new DiscordJobStore(config.statePath);
    store.enqueue(job);
    const claimed = store.claimDue();
    config.channelIdSet.clear();
    let channelFetches = 0;
    let apiCalls = 0;
    const client = { user: { id: "900000000000000001" }, channels: { fetch: async () => { channelFetches += 1; throw new Error("must not fetch"); } } };
    const worker = new DiscordBotWorker({ config, client, store, fetchImpl: async () => { apiCalls += 1; throw new Error("must not submit"); } });
    await worker.processJob(claimed);
    const failed = store.get(claimed);
    assert.equal(failed.status, "failed");
    assert.equal(failed.last_error, "source_revoked");
    assert.equal(channelFetches, 0);
    assert.equal(apiCalls, 0);
  } finally {
    closeStore(store);
    await removeDirectory(directory);
  }
});

test("a fresh message whose match binding changed is failed without acknowledgement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axis-discord-stale-binding-"));
  let store;
  try {
    const config = loadDiscordBotConfig({ ...ENV, AXIS_DISCORD_STATE_PATH: join(directory, "state.db"), AXIS_DISCORD_MATCH_CHANNELS: "", AXIS_DISCORD_MATCH_PREFIX: "match-" });
    const job = { guildId: config.guildId, channelId: "200000000000000001", parentChannelId: null, messageId: "400000000000000013", attachmentId: "300000000000000013", authorId: "500000000000000001", matchNumber: 42 };
    const replies = [];
    const source = { id: job.messageId, guildId: config.guildId, channelId: job.channelId, author: { id: job.authorId, bot: false }, webhookId: null, attachments: new Map([[job.attachmentId, { id: job.attachmentId, name: "result.png", contentType: "image/png", url: `https://cdn.discordapp.com/attachments/${job.channelId}/${job.attachmentId}/result.png?sig=1` }]]), channel: null,
      reply: async (value) => replies.push(value) };
    const channel = { id: job.channelId, parentId: null, name: "match-43", messages: { fetch: async (arg) => (typeof arg === "string" || arg?.message) ? source : new Map() } };
    source.channel = channel;
    let apiCalls = 0;
    store = new DiscordJobStore(config.statePath);
    store.enqueue(job);
    const client = { user: { id: "900000000000000001" }, channels: { fetch: async () => channel } };
    const worker = new DiscordBotWorker({ config, client, store, fetchImpl: async () => { apiCalls += 1; throw new Error("must not submit"); } });
    const claimed = store.claimDue();
    await worker.processJob(claimed);
    assert.equal(store.get(claimed).status, "failed");
    assert.equal(store.get(claimed).last_error, "source_revoked");
    assert.equal(replies.length, 0);
    assert.equal(apiCalls, 0);
  } finally {
    closeStore(store);
    await removeDirectory(directory);
  }
});

test("a deleted Discord source fails before OCR without API submission or acknowledgement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axis-discord-deleted-before-ocr-"));
  let store;
  try {
    const config = loadDiscordBotConfig({ ...ENV, AXIS_DISCORD_STATE_PATH: join(directory, "state.db") });
    const job = { guildId: config.guildId, channelId: "200000000000000001", parentChannelId: null, messageId: "400000000000000016", attachmentId: "300000000000000016", authorId: "500000000000000001", matchNumber: 42 };
    store = new DiscordJobStore(config.statePath);
    store.enqueue(job);
    const claimed = store.claimDue();
    let channelFetches = 0;
    let apiCalls = 0;
    const client = { user: { id: "900000000000000001" }, channels: { fetch: async () => { channelFetches += 1; throw discordApiError(10003, 404, "Unknown Channel"); } } };
    const worker = new DiscordBotWorker({ config, client, store, logger: { warn() {} }, fetchImpl: async () => { apiCalls += 1; throw new Error("OCR must not run"); } });
    await worker.processJob(claimed);
    const failed = store.get(claimed);
    assert.equal(failed.status, "failed");
    assert.equal(failed.last_error, "source_revoked");
    assert.equal(failed.response_json, null);
    assert.equal(channelFetches, 1);
    assert.equal(apiCalls, 0);
  } finally {
    closeStore(store);
    await removeDirectory(directory);
  }
});

test("a deleted source after a saved response preserves that response for audit and does not retry acknowledgement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axis-discord-deleted-after-ocr-"));
  let store;
  try {
    const config = loadDiscordBotConfig({ ...ENV, AXIS_DISCORD_STATE_PATH: join(directory, "state.db") });
    const job = { guildId: config.guildId, channelId: "200000000000000001", parentChannelId: null, messageId: "400000000000000017", attachmentId: "300000000000000017", authorId: "500000000000000001", matchNumber: 42 };
    const response = { ok: true, matchNumber: 42, recognizedPlayers: 10, totalPlayers: 10, coveragePercent: 100, confidencePercent: 95, needsReview: false };
    store = new DiscordJobStore(config.statePath);
    store.enqueue(job);
    const claimed = store.claimDue();
    store.saveResponse(claimed, response);
    let channelFetches = 0;
    let apiCalls = 0;
    const client = { user: { id: "900000000000000001" }, channels: { fetch: async () => { channelFetches += 1; throw discordApiError(10008, 404, "Unknown Message"); } } };
    const worker = new DiscordBotWorker({ config, client, store, logger: { warn() {} }, fetchImpl: async () => { apiCalls += 1; throw new Error("OCR must not run"); } });
    await worker.processJob(claimed);
    const failed = store.get(claimed);
    assert.equal(failed.status, "failed");
    assert.equal(failed.last_error, "source_revoked");
    assert.deepEqual(JSON.parse(failed.response_json), response);
    assert.equal(channelFetches, 1);
    assert.equal(apiCalls, 0);
  } finally {
    closeStore(store);
    await removeDirectory(directory);
  }
});

test("a Discord permission error retries without saving a failure and succeeds after access returns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axis-discord-permission-retry-"));
  let store;
  try {
    const config = loadDiscordBotConfig({ ...ENV, AXIS_DISCORD_STATE_PATH: join(directory, "state.db") });
    const job = { guildId: config.guildId, channelId: "200000000000000001", parentChannelId: null, messageId: "400000000000000018", attachmentId: "300000000000000018", authorId: "500000000000000001", matchNumber: 42 };
    const attachment = { id: job.attachmentId, name: "result.png", contentType: "image/png", url: `https://cdn.discordapp.com/attachments/${job.channelId}/${job.attachmentId}/result.png?sig=1` };
    const replies = [];
    const source = { id: job.messageId, guildId: config.guildId, channelId: job.channelId, author: { id: job.authorId, bot: false }, webhookId: null, attachments: new Map([[attachment.id, attachment]]), channel: null, reply: async (value) => replies.push(value) };
    const channel = { id: job.channelId, parentId: null, name: "match-42", messages: { fetch: async (arg) => (typeof arg === "string" || arg?.message) ? source : new Map() } };
    source.channel = channel;
    let denied = true;
    let channelFetches = 0;
    let apiCalls = 0;
    const permission = discordApiError(50013, 403, "Missing Permissions");
    const client = { user: { id: "900000000000000001" }, channels: { fetch: async () => { channelFetches += 1; if (denied) throw permission; return channel; } } };
    const apiFetch = async (url) => {
      if (String(url).includes("/api/integrations/")) {
        apiCalls += 1;
        return new Response(JSON.stringify({ ok: true, matchNumber: 42, recognizedPlayers: 10, totalPlayers: 10, coveragePercent: 100, confidencePercent: 95, needsReview: false }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
    };
    store = new DiscordJobStore(config.statePath);
    store.enqueue(job);
    const first = store.claimDue();
    let caught;
    try { await new DiscordBotWorker({ config, client, store, logger: { warn() {} }, fetchImpl: apiFetch }).processJob(first); }
    catch (error) { caught = error; }
    assert.equal(caught, permission);
    const worker = new DiscordBotWorker({ config, client, store, logger: { warn() {} }, fetchImpl: apiFetch });
    await worker.handleProcessingError(first, caught);
    assert.equal(store.get(first).status, "pending");
    assert.equal(store.get(first).response_json, null);
    assert.equal(apiCalls, 0);
    denied = false;
    const retried = store.claimDue(Date.now() + 60_000);
    assert.ok(retried);
    await worker.processJob(retried);
    assert.equal(store.get(retried).status, "done");
    assert.equal(apiCalls, 1);
    assert.equal(replies.length, 1);
    assert.ok(channelFetches >= 2);
  } finally {
    closeStore(store);
    await removeDirectory(directory);
  }
});

test("backend match_not_found remains a transient 404, not a deleted Discord source", async () => {
  const config = loadDiscordBotConfig(ENV);
  const job = { guild_id: config.guildId, channel_id: "200000000000000001", parent_channel_id: null, message_id: "400000000000000019", attachment_id: "300000000000000019", author_id: "500000000000000001", match_number: 42 };
  const worker = new DiscordBotWorker({ config, client: { user: { id: "900000000000000001" } }, store: {}, fetchImpl: async () => new Response(JSON.stringify({ error: "match_not_found" }), { status: 404 }) });
  await assert.rejects(() => worker.postSubmission(job, { data: "AQID" }), (error) => {
    assert.equal(error.status, 404);
    assert.equal(error.transient, true);
    return true;
  });
});

test("catch-up processes same-timestamp messages by snowflake ID order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axis-discord-order-"));
  let store;
  try {
    const config = loadDiscordBotConfig({ ...ENV, AXIS_DISCORD_STATE_PATH: join(directory, "state.db") });
    const low = { id: "400000000000000014", createdTimestamp: 1, guildId: config.guildId, channelId: "200000000000000001", author: { id: "500000000000000001", bot: false }, webhookId: null, channel: null, attachments: new Map() };
    const high = { id: "400000000000000015", createdTimestamp: 1, guildId: config.guildId, channelId: "200000000000000001", author: { id: "500000000000000001", bot: false }, webhookId: null, channel: null, attachments: new Map() };
    const channel = { id: "200000000000000001", parentId: null, name: "match-42", messages: { fetch: async () => new Map([[high.id, high], [low.id, low]]) } };
    low.channel = channel; high.channel = channel;
    store = new DiscordJobStore(config.statePath);
    const worker = new DiscordBotWorker({ config, client: { user: { id: "900000000000000001" } }, store });
    const seen = [];
    worker.handleMessage = async (message) => { seen.push(message.id); };
    await worker.catchUpChannel(channel);
    assert.deepEqual(seen, [low.id, high.id]);
    assert.equal(store.checkpoint(channel.id), high.id);
  } finally {
    closeStore(store);
    await removeDirectory(directory);
  }
});

// Use the SDK manager here: a string lookup can silently use its cached message.
test("source verification bypasses Discord's message cache and refreshes signed attachments", async () => {
  const { Client, GatewayIntentBits, MessageManager } = await import("discord.js");
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  let store;
  try {
    const config = loadDiscordBotConfig(ENV);
    const channel = { id: ENV.AXIS_DISCORD_CHANNEL_IDS, guildId: config.guildId, parentId: null, name: "match-42", client, _patch(data) { this.name = data.name; this.parentId = data.parent_id; } };
    client.channels.cache.set(channel.id, channel);
    channel.messages = new MessageManager(channel);
    const attachmentId = "300000000000000020";
    const messageId = "400000000000000020";
    const raw = {
      id: messageId, channel_id: channel.id, guild_id: config.guildId,
      author: { id: "500000000000000001", username: "player", discriminator: "0", bot: false },
      content: "", timestamp: "2026-10-25T00:00:00.000Z", edited_timestamp: null, type: 0,
      attachments: [{ id: attachmentId, filename: "result.png", size: 3, content_type: "image/png",
        url: `https://cdn.discordapp.com/attachments/${channel.id}/${attachmentId}/result.png?sig=expired` }],
    };
    channel.messages._add(raw);
    let fetches = 0;
    let deleted = false;
    client.rest.get = async (route) => {
      if (route === `/channels/${channel.id}`) return { id: channel.id, name: "match-42", parent_id: null };
      fetches++;
      if (deleted) throw discordApiError(10008, 404, "Unknown Message");
      return { ...raw, attachments: [{ ...raw.attachments[0], url: raw.attachments[0].url.replace("expired", "fresh") }] };
    };
    store = new DiscordJobStore(":memory:");
    const worker = new DiscordBotWorker({ config, client, store });
    const job = { guild_id: config.guildId, channel_id: channel.id, parent_channel_id: null,
      message_id: messageId, attachment_id: attachmentId, author_id: raw.author.id, match_number: 42 };
    const source = await worker.fetchFreshAttachment(job);
    assert.match(source.attachment.url, /sig=fresh$/);
    assert.equal(fetches, 1);
    deleted = true;
    await assert.rejects(() => worker.fetchFreshAttachment(job), { code: 10008, status: 404 });
    assert.equal(fetches, 2, "a cached success must not hide deletion on a retry");
  } finally {
    closeStore(store);
    try { await client.destroy(); } catch { /* cleanup must not replace the test assertion */ }
  }
});

test("source checks refresh a cached channel binding before reading a screenshot or sending a reminder", async () => {
  const { Client, GatewayIntentBits, MessageManager } = await import("discord.js");
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  let store;
  try {
    const config = loadDiscordBotConfig({ ...ENV, AXIS_DISCORD_MATCH_CHANNELS: "{}", AXIS_DISCORD_MATCH_PREFIX: "match-" });
    let sends = 0;
    const channel = { id: ENV.AXIS_DISCORD_CHANNEL_IDS, guildId: config.guildId, parentId: null, name: "match-42", client,
      _patch(data) { this.name = data.name; this.parentId = data.parent_id; },
      send: async () => { sends++; return { id: "600000000000000020" }; } };
    client.channels.cache.set(channel.id, channel);
    channel.messages = new MessageManager(channel);
    let channelFetches = 0;
    client.rest.get = async (route) => {
      if (route === `/channels/${channel.id}`) {
        channelFetches++;
        return { id: channel.id, name: "match-43", parent_id: null };
      }
      return { id: job.message_id, channel_id: channel.id, guild_id: config.guildId,
        author: { id: job.author_id, username: "player", discriminator: "0", bot: false },
        content: "", timestamp: "2026-10-25T00:00:00.000Z", edited_timestamp: null, type: 0, attachments: [] };
    };
    store = new DiscordJobStore(":memory:");
    const worker = new DiscordBotWorker({ config, client, store, logger: { warn() {} } });
    const job = { guild_id: config.guildId, channel_id: channel.id, parent_channel_id: null,
      message_id: "400000000000000021", attachment_id: "300000000000000021", author_id: "500000000000000001", match_number: 42 };
    await assert.rejects(() => worker.fetchSourceMessage(job), /source_revoked/);
    channel.name = "match-42";
    worker.queueMatchReminder(channel);
    await worker.processMatchReminder(store.claimReminderDue());
    assert.equal(sends, 0, "a stale cached binding must not authorize a reminder");
    assert.equal(channelFetches, 2);
  } finally {
    closeStore(store);
    try { await client.destroy(); } catch { /* cleanup must not replace the test assertion */ }
  }
});
