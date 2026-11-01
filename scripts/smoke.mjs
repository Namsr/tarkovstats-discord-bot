import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { Client, GatewayIntentBits } from "discord.js";
import { runDiscordBot } from "./axis-discord-bot.mjs";
import { DiscordJobStore } from "../lib/discord-bot/state.mjs";
import { messageText } from "../lib/discord-bot/messages.mjs";

assert.equal(typeof runDiscordBot, "function");
assert.match(messageText("en", "reminder"), /Before choosing/);
assert.match(messageText("ru", "reminder"), /Перед выбором/);
const directory = await mkdtemp(join(tmpdir(), "discord-smoke-"));
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let store;
try {
  assert.equal(client.isReady(), false);
  store = new DiscordJobStore(join(directory, "state.db"));
  assert.equal(store.claimDue(), null);
} finally {
  store?.close();
  await client.destroy();
  await rm(directory, { recursive: true, force: true });
}
console.log("Runtime smoke passed without Discord login or API requests");
