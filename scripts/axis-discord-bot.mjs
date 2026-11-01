import { pathToFileURL } from "node:url";
import { DiscordJobStore } from "../lib/discord-bot/state.mjs";
import { DiscordBotWorker } from "../lib/discord-bot/worker.mjs";
import { loadDiscordBotConfig } from "../lib/discord-bot/config.mjs";

function safeError(error) {
  return String(error?.message || error)
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 240);
}

export async function runDiscordBot({ env = process.env, logger = console } = {}) {
  const config = loadDiscordBotConfig(env);
  const { Client, GatewayIntentBits } = await import("discord.js");
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  const store = new DiscordJobStore(config.statePath);
  const worker = new DiscordBotWorker({ config, client, store, logger });
  let started = false;
  let stopping = null;
  const stop = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      if (!started) { store.close(); client.destroy(); return; }
      await worker.stop();
      store.close();
      client.destroy();
      started = false;
    })();
    return stopping;
  };
  const handleSignal = () => { void stop().catch((error) => logger.error?.("Discord bot shutdown failed", error)); };
  process.once("SIGTERM", handleSignal);
  process.once("SIGINT", handleSignal);
  client.once("ready", () => {
    started = true;
    void worker.start().catch(async (error) => {
      logger.error?.(`Discord bot worker failed: ${safeError(error)}`);
      try { await stop(); }
      catch (shutdownError) {
        logger.error?.(`Discord bot shutdown failed: ${safeError(shutdownError)}`);
      }
      process.exitCode = 1;
    });
  });
  try { await client.login(config.token); }
  catch (error) {
    await stop();
    const code = typeof error?.code === "string" ? ` (${error.code})` : "";
    throw new Error(`Discord login failed${code}`);
  }
  return { client, worker, store, stop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDiscordBot().catch((error) => { console.error(`Discord bot failed to start: ${error.message}`); process.exitCode = 1; });
}
