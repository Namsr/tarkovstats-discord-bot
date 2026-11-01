import { isSnowflake } from "./config.mjs";

const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

export function resolveMatchNumber(channel, config) {
  const id = String(channel?.id || "");
  const parentId = typeof channel?.parentId === "string" ? channel.parentId : null;
  const direct = config.matchChannels.get(id) ?? (parentId ? config.matchChannels.get(parentId) : undefined);
  if (direct !== undefined) return direct;
  if (!config.prefix) return null;
  const name = typeof channel?.name === "string" ? channel.name : "";
  const match = name.match(new RegExp(`^${escapeRegex(config.prefix)}(\\d+)$`));
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export function isAllowedMessage(message, config) {
  if (!message || message.author?.bot || message.webhookId || !message.guildId || message.guildId !== config.guildId) return false;
  const channelId = String(message.channelId || message.channel?.id || "");
  const parentId = typeof message.channel?.parentId === "string" ? message.channel.parentId : null;
  return config.channelIdSet.has(channelId) || parentId !== null && config.channelIdSet.has(parentId);
}

export function isImageAttachment(attachment) {
  if (!attachment || typeof attachment.id !== "string" || !isSnowflake(attachment.id)) return false;
  const type = typeof attachment.contentType === "string" ? attachment.contentType.split(";", 1)[0].toLowerCase() : "";
  if (type && TYPES.has(type)) return true;
  return /\.(?:png|jpe?g|webp)$/i.test(String(attachment.name || attachment.url || ""));
}

export function validateAttachmentUrl(value, sourceChannelIds, attachmentId = null) {
  let url;
  try { url = new URL(value); } catch { throw new Error("invalid_attachment_url"); }
  if (url.protocol !== "https:" || url.port || !HOSTS.has(url.hostname) || url.username || url.password) {
    throw new Error("invalid_attachment_url");
  }
  const match = url.pathname.match(/^\/attachments\/(\d{17,20})\/(\d{17,20})\//);
  if (!match || !sourceChannelIds.includes(match[1]) || attachmentId !== null && match[2] !== attachmentId) throw new Error("attachment_source_mismatch");
  return url;
}

export async function downloadAttachment(attachment, sourceChannelIds, fetchImpl = fetch, timeoutMs = 20_000) {
  if (!isImageAttachment(attachment)) throw new Error("unsupported_attachment");
  const url = validateAttachmentUrl(attachment.url, sourceChannelIds, attachment.id);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { redirect: "error", signal: controller.signal, headers: { accept: "image/png,image/jpeg,image/webp" } });
    if (!response.ok) {
      const error = new Error(`attachment_http_${response.status}`);
      error.status = response.status;
      await response.body?.cancel().catch(() => {});
      throw error;
    }
    const type = (response.headers.get("content-type") || "").split(";", 1)[0].toLowerCase();
    const declared = Number(response.headers.get("content-length"));
    const unsupported = type && !TYPES.has(type);
    const oversized = Number.isFinite(declared) && declared > MAX_BYTES;
    if (unsupported || oversized) {
      await response.body?.cancel().catch(() => {});
      throw new Error(unsupported ? "unsupported_attachment" : "attachment_too_large");
    }
    if (!response.body) throw new Error("attachment_empty");
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_BYTES) throw new Error("attachment_too_large");
        chunks.push(part.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
    if (!size) throw new Error("attachment_empty");
    const bytes = Buffer.concat(chunks.map((part) => Buffer.from(part)));
    return { data: bytes.toString("base64"), contentType: type || null, bytes: size };
  } catch (error) {
    if (error?.name === "AbortError") { const timeout = new Error("attachment_timeout"); timeout.transient = true; throw timeout; }
    throw error;
  } finally { clearTimeout(timer); }
}

export function classifyError(error) {
  const status = Number(error?.status);
  if (status === 429 || status >= 500 || error?.transient || error?.name === "TypeError" || /network|fetch|timeout|ECONN|socket/i.test(String(error?.message))) return "transient";
  return "permanent";
}

export { MAX_BYTES, TYPES, HOSTS };
