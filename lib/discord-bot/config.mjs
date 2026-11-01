const SNOWFLAKE = /^\d{17,20}$/;

function snowflake(value, name) {
  if (typeof value !== "string" || !SNOWFLAKE.test(value)) {
    throw new Error(`${name} must be a Discord snowflake`);
  }
  return value;
}

function positiveMatch(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  return number;
}

function csv(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (!values.length || values.some((item) => !SNOWFLAKE.test(item))) throw new Error(`${name} contains an invalid channel ID`);
  return [...new Set(values)];
}

function parseMatchChannels(value) {
  if (typeof value !== "string" || !value.trim()) return new Map();
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error("AXIS_DISCORD_MATCH_CHANNELS must be valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("AXIS_DISCORD_MATCH_CHANNELS must be an object");
  const result = new Map();
  for (const [channelId, matchNumber] of Object.entries(parsed)) {
    snowflake(channelId, "AXIS_DISCORD_MATCH_CHANNELS channel ID");
    result.set(channelId, positiveMatch(matchNumber, `AXIS_DISCORD_MATCH_CHANNELS[${channelId}]`));
  }
  return result;
}

function apiUrl(value) {
  const raw = value || "http://web:3000";
  let url;
  try { url = new URL(raw); } catch { throw new Error("AXIS_DISCORD_API_BASE_URL must be a URL"); }
  if (!url.hostname) throw new Error("AXIS_DISCORD_API_BASE_URL must include a hostname");
  const internalHttp = url.protocol === "http:" && ["web", "localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !internalHttp) throw new Error("AXIS_DISCORD_API_BASE_URL must use HTTPS unless it targets web/localhost");
  if (url.username || url.password || url.search || url.hash) throw new Error("AXIS_DISCORD_API_BASE_URL cannot contain credentials or query parameters");
  return url.href.replace(/\/$/, "");
}

export function loadDiscordBotConfig(env = process.env) {
  const tokenValue = typeof env.DISCORD_TOKEN === "string" ? env.DISCORD_TOKEN : env.DISCORD_BOT_TOKEN;
  const token = typeof tokenValue === "string" ? tokenValue.trim() : "";
  if (token.length < 20) throw new Error("DISCORD_BOT_TOKEN is required");
  const secret = typeof env.AXIS_DISCORD_SECRET === "string" ? env.AXIS_DISCORD_SECRET : "";
  if (secret.length < 32) throw new Error("AXIS_DISCORD_SECRET must contain at least 32 characters");
  const guildId = snowflake(env.AXIS_DISCORD_GUILD_ID, "AXIS_DISCORD_GUILD_ID");
  const channelIds = csv(env.AXIS_DISCORD_CHANNEL_IDS, "AXIS_DISCORD_CHANNEL_IDS");
  const matchChannels = parseMatchChannels(env.AXIS_DISCORD_MATCH_CHANNELS);
  const prefix = typeof env.AXIS_DISCORD_MATCH_PREFIX === "string" ? env.AXIS_DISCORD_MATCH_PREFIX.trim() : "";
  if (prefix.length > 64 || /[\r\n]/.test(prefix)) throw new Error("AXIS_DISCORD_MATCH_PREFIX is invalid");
  if (!matchChannels.size && !prefix) throw new Error("Configure AXIS_DISCORD_MATCH_CHANNELS or AXIS_DISCORD_MATCH_PREFIX");
  const statePath = typeof env.AXIS_DISCORD_STATE_PATH === "string" && env.AXIS_DISCORD_STATE_PATH.trim()
    ? env.AXIS_DISCORD_STATE_PATH.trim() : "/data/axis-discord-state.db";
  const language = env.AXIS_DISCORD_LANG === "en" ? "en" : "ru";
  const reminderText = typeof env.AXIS_DISCORD_REMINDER_TEXT === "string" ? env.AXIS_DISCORD_REMINDER_TEXT.trim() : "";
  if (reminderText.length > 1800) throw new Error("AXIS_DISCORD_REMINDER_TEXT must be at most 1800 characters");
  const bootstrapMessages = env.AXIS_DISCORD_BOOTSTRAP_MESSAGES == null ? 100 : Number(env.AXIS_DISCORD_BOOTSTRAP_MESSAGES);
  if (!Number.isSafeInteger(bootstrapMessages) || bootstrapMessages < 0 || bootstrapMessages > 100) throw new Error("AXIS_DISCORD_BOOTSTRAP_MESSAGES must be 0..100");
  const maxAttempts = env.AXIS_DISCORD_MAX_ATTEMPTS == null ? 8 : Number(env.AXIS_DISCORD_MAX_ATTEMPTS);
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 50) throw new Error("AXIS_DISCORD_MAX_ATTEMPTS must be 1..50");
  const maxPending = env.AXIS_DISCORD_MAX_PENDING == null ? 1000 : Number(env.AXIS_DISCORD_MAX_PENDING);
  if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 100_000) throw new Error("AXIS_DISCORD_MAX_PENDING must be 1..100000");
  const catchupMs = env.AXIS_DISCORD_CATCHUP_MS == null ? 60_000 : Number(env.AXIS_DISCORD_CATCHUP_MS);
  if (!Number.isSafeInteger(catchupMs) || catchupMs < 10_000 || catchupMs > 3_600_000) throw new Error("AXIS_DISCORD_CATCHUP_MS must be 10000..3600000");
  return Object.freeze({ token, secret, guildId, channelIds, channelIdSet: new Set(channelIds), matchChannels, prefix,
    apiBaseUrl: apiUrl(env.AXIS_DISCORD_API_BASE_URL), statePath, language, reminderText, bootstrapMessages, maxAttempts, maxPending, catchupMs });
}

export function isSnowflake(value) { return typeof value === "string" && SNOWFLAKE.test(value); }
export { SNOWFLAKE };
