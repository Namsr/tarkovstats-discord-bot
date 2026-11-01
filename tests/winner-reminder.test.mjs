import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { loadDiscordBotConfig } from "../lib/discord-bot/config.mjs";
import { DiscordJobStore } from "../lib/discord-bot/state.mjs";
import { DiscordBotWorker } from "../lib/discord-bot/worker.mjs";

async function fixture(language = "ru") {
  const directory = await mkdtemp(join(tmpdir(), "winner-reminder-"));
  const config = loadDiscordBotConfig({ DISCORD_TOKEN: "A".repeat(60), AXIS_DISCORD_SECRET: "S".repeat(40),
    AXIS_DISCORD_GUILD_ID: "100000000000000001", AXIS_DISCORD_CHANNEL_IDS: "200000000000000001",
    AXIS_DISCORD_MATCH_PREFIX: "queue-", AXIS_DISCORD_LANG: language, AXIS_DISCORD_STATE_PATH: join(directory, "state.db") });
  const f = { config, sent: [], reads: [], error: null };
  f.channel = { id: "300000000000000001", guildId: config.guildId, parentId: config.channelIds[0], name: "queue-5892",
    send: async (value) => { f.sent.push(value); return { id: String(600000000000000001n + BigInt(f.sent.length)) }; },
    messages: { fetch: async (options) => {
      f.reads.push(options);
      if (f.error) throw f.error;
      if (options.message) {
        assert.equal(options.force, true);
        assert.equal(options.message, f.menu.id);
        return f.menu;
      }
      return options.after ? new Map() : new Map([[f.menu.id, f.menu]]);
    } } };
  f.menu = { id: "400000000000000001", guildId: config.guildId, channelId: f.channel.id, channel: f.channel,
    author: { id: "857633321064595466", bot: true },
    embeds: [{ title: "🏆 Winner For Queue#5892 🏆" }],
    components: [{ type: 1, components: [
      { type: 2, custom_id: "team1_5892", label: "Team A" },
      { type: 2, custom_id: "team2_5892", label: "Team B" },
    ] }] };
  f.client = new EventEmitter();
  f.client.channels = { fetch: async (_id, options) => { assert.equal(options.force, true); return f.channel; } };
  f.makeWorker = () => {
    const worker = new DiscordBotWorker({ config, client: f.client, store: f.store, logger: { warn() {} }, now: () => 10_000 });
    worker.runLoop = async () => {};
    worker.catchUpConfiguredChannels = async () => {};
    return worker;
  };
  f.store = new DiscordJobStore(config.statePath);
  f.worker = f.makeWorker();
  f.reopen = async () => {
    await f.worker.stop();
    f.store.close();
    f.store = new DiscordJobStore(config.statePath);
    f.worker = f.makeWorker();
  };
  f.cleanup = async () => {
    await f.worker.stop();
    f.store.close();
    await rm(directory, { recursive: true, force: true });
  };
  return f;
}

test("a NeatQueue edit sends a second reminder, with no duplicate after votes or restart", async () => {
  const f = await fixture();
  try {
    await f.worker.start();
    f.client.emit("channelCreate", f.channel);
    await f.worker.processMatchReminder(f.store.claimReminderDue());
    assert.equal(f.sent.length, 1);
    f.client.emit("messageCreate", { ...f.menu, embeds: [], components: [] });
    await setImmediate();
    assert.equal(f.store.claimReminderDue(), null);
    f.client.emit("messageUpdate", {}, f.menu);
    await setImmediate();
    await f.worker.processMatchReminder(f.store.claimReminderDue());
    assert.equal(f.sent.length, 2);
    assert.notEqual(f.sent[0].nonce, f.sent[1].nonce, "phases must have distinct Discord nonces");
    assert.equal(f.sent[0].content, f.sent[1].content);
    assert.match(f.sent[1].content, /Перед тем, как выбрать победителя/);
    assert.deepEqual(f.sent[1].allowedMentions, { parse: [] });
    assert.equal(f.sent[1].enforceNonce, true);
    f.client.emit("messageUpdate", {}, f.menu);
    f.client.emit("messageCreate", f.menu);
    await setImmediate();
    assert.equal(f.store.claimReminderDue(), null);
    await f.reopen();
    assert.equal(f.client.listenerCount("messageUpdate"), 0);
    f.worker.queueMatchReminder(f.channel);
    await f.worker.queueWinnerReminder(f.menu);
    assert.equal(f.store.claimReminderDue(), null, "both phases must stay acknowledged after reopen");
  } finally { await f.cleanup(); }
});

test("winner-menu creation uses the selected language and does not enqueue screenshots from bots", async () => {
  const f = await fixture("en");
  try {
    assert.equal(await f.worker.handleMessage(f.menu), 0);
    await f.worker.processMatchReminder(f.store.claimReminderDue());
    assert.match(f.sent[0].content, /Before choosing the winner/);
    assert.equal(f.store.claimDue(), null);
  } finally { await f.cleanup(); }
});

test("only the trusted bot's matching, active winner controls trigger a reminder", async () => {
  const f = await fixture();
  try {
    const variants = [
      { ...f.menu, author: { id: "857633321064595466", bot: false } },
      { ...f.menu, author: { id: "900000000000000001", bot: true } },
      { ...f.menu, webhookId: "900000000000000002" },
      { ...f.menu, guildId: "100000000000000099" },
      { ...f.menu, channel: { ...f.channel, parentId: null } },
      { ...f.menu, embeds: [{ title: "🏆 Winner For Queue#5893 🏆" }] },
      { ...f.menu, components: [{ components: [{ type: 2, custom_id: "team1_5893" }, { type: 2, custom_id: "team2_5893" }] }] },
      { ...f.menu, components: [{ components: [{ type: 2, custom_id: "team1_5892", disabled: true }, { type: 2, custom_id: "team2_5892" }] }] },
      { ...f.menu, components: [{ components: [{ type: 2, custom_id: "team1_5892" }] }] },
    ];
    for (const message of variants) await f.worker.queueWinnerReminder(message);
    assert.equal(f.store.claimReminderDue(), null);
    f.menu.components = [{ components: [{ type: 2, customId: "team1_5892" }, { type: 2, customId: "team2_5892" }] }];
    await f.worker.queueWinnerReminder(f.menu);
    assert.ok(f.store.claimReminderDue(), "SDK camelCase controls must also be recognized");
  } finally { await f.cleanup(); }
});

test("an uncached message edit is fetched only in an allowed match channel", async () => {
  const f = await fixture();
  try {
    let fetched = 0;
    const partial = { ...f.menu, author: null, partial: true, fetch: async () => { fetched++; return f.menu; } };
    await f.worker.start();
    f.client.emit("messageUpdate", {}, { ...partial, guildId: "100000000000000099" });
    await setImmediate();
    assert.equal(fetched, 0);
    f.client.emit("messageUpdate", {}, partial);
    await setImmediate();
    assert.equal(fetched, 1);
    await f.worker.processMatchReminder(f.store.claimReminderDue());
    assert.equal(f.sent.length, 1);
  } finally { await f.cleanup(); }
});

for (const reason of ["closed", "deleted", "changed-author", "moved-channel"]) {
  test(`a queued winner reminder is cancelled when its source is ${reason}`, async () => {
    const f = await fixture();
    try {
      await f.worker.queueWinnerReminder(f.menu);
      const job = f.store.claimReminderDue();
      if (reason === "closed") f.menu.components[0].components[0].disabled = true;
      if (reason === "deleted") f.error = Object.assign(new Error("Unknown Message"), { status: 404, code: 10008 });
      if (reason === "changed-author") f.menu.author.id = "900000000000000001";
      if (reason === "moved-channel") f.channel.parentId = null;
      await f.worker.processMatchReminder(job);
      assert.equal(f.sent.length, 0);
      assert.equal(f.store.claimReminderDue(Date.now() + 60_000), null);
    } finally { await f.cleanup(); }
  });
}

test("a pending winner reminder keeps its source and phase across permission failure and restart", async () => {
  const f = await fixture();
  try {
    await f.worker.queueWinnerReminder(f.menu);
    f.error = Object.assign(new Error("Missing Access"), { status: 403, code: 50001 });
    await f.worker.processMatchReminder(f.store.claimReminderDue());
    assert.equal(f.sent.length, 0);
    assert.equal(f.store.claimReminderDue(10_000), null);
    await f.reopen();
    f.error = null;
    const job = f.store.claimReminderDue(70_000);
    assert.equal(job.kind, "winner");
    assert.equal(job.source_message_id, f.menu.id);
    await f.worker.processMatchReminder(job);
    assert.equal(f.sent.length, 1);
  } finally { await f.cleanup(); }
});

test("catch-up recovers a menu edited before the saved checkpoint", async () => {
  const f = await fixture();
  try {
    f.store.saveCheckpoint(f.channel.id, "400000000000000099");
    await f.worker.catchUpChannel(f.channel);
    assert.equal(f.store.checkpoint(f.channel.id), "400000000000000099");
    await f.worker.processMatchReminder(f.store.claimReminderDue());
    assert.equal(f.sent.length, 1);
    f.reads.length = 0;
    await f.worker.catchUpChannel(f.channel);
    assert.equal(f.reads.length, 1, "completed winner phase must not keep re-scanning recent history");
    assert.ok(f.reads[0].after);
  } finally { await f.cleanup(); }
});

test("adding the winner queue preserves reminders from an older database", async () => {
  const f = await fixture();
  try {
    f.worker.queueMatchReminder(f.channel);
    await f.worker.processMatchReminder(f.store.claimReminderDue());
    f.store.db.exec("DROP TABLE discord_winner_reminders");
    await f.reopen();
    f.worker.queueMatchReminder(f.channel);
    assert.equal(f.store.claimReminderDue(), null);
    await f.worker.queueWinnerReminder(f.menu);
    await f.worker.processMatchReminder(f.store.claimReminderDue());
    assert.equal(f.sent.length, 2);
  } finally { await f.cleanup(); }
});
