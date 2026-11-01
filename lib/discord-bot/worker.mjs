import { createHash } from "node:crypto";
import { loadDiscordBotConfig } from "./config.mjs";
import { backoffMs } from "./state.mjs";
import { classifyError, downloadAttachment, isAllowedMessage, isImageAttachment, resolveMatchNumber } from "./security.mjs";
import { messageText, resultMessage } from "./messages.mjs";

const IMAGE_LIMIT = 10 * 1024 * 1024;
const MAX_CATCHUP_PAGES = 100;
const DELETED_SOURCE_CODES = new Set(["10003", "10008"]);
const DISCORD_PERMISSION_CODES = new Set(["50001", "50013"]);

function attachmentList(message) {
  const values = message?.attachments?.values;
  return typeof values === "function" ? [...values.call(message.attachments)] : Array.isArray(message?.attachments) ? message.attachments : [];
}

function channelIdOf(message) { return String(message?.channelId || message?.channel?.id || ""); }
function channelIdsOf(job) { return [job.channel_id, job.parent_channel_id].filter((id, index, list) => id && list.indexOf(id) === index); }
function sourceRevokedError() {
  const error = new Error("source_revoked");
  error.sourceRevoked = true;
  return error;
}
function discordCode(error) {
  const value = error?.code ?? error?.rawError?.code ?? error?.data?.code;
  return value === null || value === undefined ? null : String(value);
}
function discordStatus(error) {
  const value = error?.status ?? error?.statusCode ?? error?.httpStatus;
  const status = Number(value);
  return Number.isFinite(status) ? status : null;
}
function isDeletedSourceError(error) {
  return discordStatus(error) === 404 && DELETED_SOURCE_CODES.has(discordCode(error));
}
function isSourceRevoked(error) { return error?.sourceRevoked === true || error?.message === "source_revoked" || isDeletedSourceError(error); }
function isRetryable(error) {
  const status = discordStatus(error);
  return status === 403 && DISCORD_PERMISSION_CODES.has(discordCode(error)) || classifyError(error) === "transient";
}

function compareMessages(left, right) {
  try {
    const leftId = BigInt(String(left.id));
    const rightId = BigInt(String(right.id));
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  } catch {
    return Number(left.createdTimestamp || 0) - Number(right.createdTimestamp || 0);
  }
}

export class DiscordBotWorker {
  constructor({ config, client, store, fetchImpl = fetch, logger = console, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => Date.now() }) {
    this.config = config;
    this.client = client;
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.sleep = sleep;
    this.now = now;
    this.stopping = false;
    this.loopPromise = null;
    this.catchUpPromise = null;
    this.lastCatchupAt = 0;
    this.onMessage = (message) => { void this.handleMessage(message).catch((error) => this.logError("message", error)); };
    this.onResume = () => { void this.catchUpConfiguredChannels().catch((error) => this.logError("resume", error)); };
    this.onChannelCreate = (channel) => {
      try { this.queueMatchReminder(channel); } catch (error) { this.logError("reminder", error); }
    };
    // Discord also emits threadCreate when the bot joins an existing thread.
    this.onThreadCreate = (channel, newlyCreated) => { if (newlyCreated === true) this.onChannelCreate(channel); };
  }

  async start() {
    if (!this.client || !this.store) throw new TypeError("Discord worker requires a client and state store");
    this.client.on("messageCreate", this.onMessage);
    this.client.on("shardResume", this.onResume);
    this.client.on("shardReady", this.onResume);
    this.client.on("channelCreate", this.onChannelCreate);
    this.client.on("threadCreate", this.onThreadCreate);
    this.loopPromise = this.runLoop();
    void this.catchUpConfiguredChannels().catch((error) => this.logError("startup", error));
    return this.loopPromise;
  }

  async catchUpConfiguredChannels() {
    if (this.catchUpPromise) return this.catchUpPromise;
    this.lastCatchupAt = this.now();
    this.catchUpPromise = (async () => {
    const channels = [];
    const seen = new Set();
    const add = (channel) => { if (channel?.messages?.fetch && !seen.has(channel.id)) { seen.add(channel.id); channels.push(channel); } };
    let guildChannels;
    for (const channelId of this.config.channelIds) {
      try {
        const channel = await this.client.channels.fetch(channelId);
        add(channel);
        // Categories have no message history. Discover their direct children
        // over REST so screenshots sent during downtime (or rejected while
        // the durable queue was full) are recovered on the next catch-up.
        if (channel?.type === 4 && channel.guildId === this.config.guildId) {
          guildChannels ??= await channel.guild.channels.fetch();
          for (const child of guildChannels.values()) {
            if (child?.parentId === channelId && resolveMatchNumber(child, this.config) !== null) add(child);
          }
        }
        if (channel?.threads?.fetchActive) {
          const active = await channel.threads.fetchActive();
          for (const thread of active?.threads?.values?.() ?? []) add(thread);
        }
      } catch (error) { this.logError("channel", error); }
    }
    // Explicit thread mappings may be used when the parent is only an allowlist
    // entry. Fetching them also lets a bot recover work after a restart.
    for (const channelId of this.config.matchChannels.keys()) {
      if (seen.has(channelId)) continue;
      try { add(await this.client.channels.fetch(channelId)); } catch (error) { this.logError("channel", error); }
    }
    for (const channel of channels) await this.catchUpChannel(channel);
    })().finally(() => { this.catchUpPromise = null; });
    return this.catchUpPromise;
  }

  async stop() {
    this.stopping = true;
    this.client?.off?.("messageCreate", this.onMessage);
    this.client?.off?.("shardResume", this.onResume);
    this.client?.off?.("shardReady", this.onResume);
    this.client?.off?.("channelCreate", this.onChannelCreate);
    this.client?.off?.("threadCreate", this.onThreadCreate);
    await this.catchUpPromise?.catch?.(() => {});
    await this.loopPromise?.catch?.(() => {});
  }

  async catchUpChannel(channel) {
    const configured = this.config.bootstrapMessages;
    if (configured === 0) return;
    const checkpoint = this.store.checkpoint(channel.id);
    let after = checkpoint;
    let remaining = checkpoint ? Number.MAX_SAFE_INTEGER : configured;
    let firstPage = true;
    let pages = 0;
    while (!this.stopping && (firstPage || checkpoint) && remaining > 0 && pages < MAX_CATCHUP_PAGES) {
      const limit = Math.min(100, remaining, configured || 100);
      let messages;
      try { messages = await channel.messages.fetch({ limit, ...(after ? { after } : {}) }); }
      catch (error) { this.logError("history", error); return; }
      const rows = [...(messages?.values?.() ?? [])];
      if (!rows.length) break;
      // Discord snowflakes are a unique total order. Timestamps can collide,
      // and a reversed page would otherwise advance the checkpoint past work.
      rows.sort(compareMessages);
      for (const message of rows) {
        try { await this.handleMessage(message); this.store.saveCheckpoint(channel.id, message.id, this.now()); }
        catch (error) { this.logError("queue", error); return; }
      }
      after = rows.at(-1).id;
      firstPage = false;
      pages++;
      if (!checkpoint) remaining -= rows.length;
      if (rows.length < limit) break;
    }
  }

  async handleMessage(message) {
    if (!isAllowedMessage(message, this.config)) return 0;
    const matchNumber = resolveMatchNumber(message.channel, this.config);
    const channelId = channelIdOf(message);
    // Gateway delivery is live and can arrive out of order. Do not advance the
    // history cursor here: a later plain message must never skip an earlier
    // image that was rejected because the durable queue was full. Catch-up is
    // the only path that advances checkpoints, after enqueue succeeds.
    if (matchNumber === null) return 0;
    const attachments = attachmentList(message).filter(isImageAttachment);
    const parentChannelId = typeof message.channel?.parentId === "string" ? message.channel.parentId : null;
    const jobs = attachments.map((attachment) => ({ guildId: message.guildId, channelId, parentChannelId,
      messageId: message.id, attachmentId: String(attachment.id), authorId: String(message.author.id), matchNumber }));
    const results = this.store.enqueueMany(jobs, null, null, this.now(), this.config.maxPending);
    return results.filter((result) => result.inserted).length;
  }

  async runLoop() {
    while (!this.stopping) {
      if (!this.catchUpPromise && this.now() - this.lastCatchupAt >= this.config.catchupMs) {
        void this.catchUpConfiguredChannels().catch((error) => this.logError("periodic", error));
      }
      const reminder = this.store.claimReminderDue(this.now());
      if (reminder) await this.processMatchReminder(reminder);
      if (this.stopping) break;
      const job = this.store.claimDue(this.now());
      if (!job) { await this.sleep(1000); continue; }
      try { await this.processJob(job); }
      catch (error) { await this.handleProcessingError(job, error); }
    }
  }

  isReminderChannelAllowed(channel, matchNumber = resolveMatchNumber(channel, this.config)) {
    return channel?.guildId === this.config.guildId && typeof channel.send === "function"
      && (this.config.channelIdSet.has(channel.id) || this.config.channelIdSet.has(channel.parentId))
      && matchNumber !== null && resolveMatchNumber(channel, this.config) === matchNumber;
  }

  queueMatchReminder(channel) {
    if (this.stopping || !this.isReminderChannelAllowed(channel)) return;
    this.store.enqueueReminder(channel.guildId, channel.id, resolveMatchNumber(channel, this.config), this.now());
  }

  async processMatchReminder(job) {
    try {
      const channel = await this.client.channels.fetch(job.channel_id, { force: true });
      if (job.guild_id !== this.config.guildId || !this.isReminderChannelAllowed(channel, job.match_number)) {
        throw sourceRevokedError();
      }
      const nonce = createHash("sha256").update(`reminder:${job.guild_id}:${job.channel_id}`).digest("hex").slice(0, 24);
      const message = await channel.send({
        content: this.config.reminderText || messageText(this.config.language, "reminder"),
        allowedMentions: { parse: [] }, nonce, enforceNonce: true,
      });
      this.store.completeReminder(job, message.id);
    } catch (error) {
      const terminal = isSourceRevoked(error) || !isRetryable(error) || job.attempts >= this.config.maxAttempts;
      this.store.deferReminder(job, error, backoffMs(job.attempts), terminal, this.now());
      this.logError("reminder", error);
    }
  }

  isJobAllowed(job) {
    const guildId = String(job?.guild_id || "");
    const channelId = String(job?.channel_id || "");
    const parentChannelId = typeof job?.parent_channel_id === "string" ? job.parent_channel_id : null;
    return guildId === this.config.guildId
      && (this.config.channelIdSet.has(channelId) || parentChannelId !== null && this.config.channelIdSet.has(parentChannelId));
  }

  revokeJob(job) {
    const error = sourceRevokedError();
    this.store.fail(job, error, this.now());
    this.logError("source_revoked", error);
  }

  assertCurrentSource(job, message, channel) {
    const actualChannelId = channelIdOf(message) || String(channel?.id || "");
    const parentChannelId = typeof message?.channel?.parentId === "string"
      ? message.channel.parentId
      : typeof channel?.parentId === "string" ? channel.parentId : null;
    const guildId = String(message?.guildId || channel?.guildId || "");
    const matchNumber = resolveMatchNumber(message?.channel || channel, this.config);
    if (!message || message.author?.bot || message.webhookId || guildId !== this.config.guildId
      || actualChannelId !== String(job.channel_id)
      || !this.config.channelIdSet.has(actualChannelId) && (parentChannelId === null || !this.config.channelIdSet.has(parentChannelId))
      || matchNumber !== Number(job.match_number)) {
      throw sourceRevokedError();
    }
    return { actualChannelId, parentChannelId };
  }

  // Source authorization and expiring attachment URLs must come from Discord,
  // even when the SDK already cached this channel and message.
  async fetchSourceMessage(job) {
    const channel = await this.client.channels.fetch(job.channel_id, { force: true });
    if (!channel?.messages?.fetch) throw new Error("channel_unavailable");
    if (String(channel.guildId || job.guild_id) !== this.config.guildId
      || !this.config.channelIdSet.has(String(channel.id))
        && (typeof channel.parentId !== "string" || !this.config.channelIdSet.has(channel.parentId))) {
      throw sourceRevokedError();
    }
    const message = await channel.messages.fetch({ message: job.message_id, force: true });
    const source = this.assertCurrentSource(job, message, channel);
    return { channel, message, sourceChannelIds: [...new Set([source.actualChannelId, source.parentChannelId, ...channelIdsOf(job)].filter(Boolean))] };
  }

  async fetchFreshAttachment(job) {
    const { message, sourceChannelIds } = await this.fetchSourceMessage(job);
    const attachment = attachmentList(message).find((item) => String(item.id) === job.attachment_id);
    if (!attachment) { const error = new Error("attachment_not_found"); error.status = 404; throw error; }
    return { message, attachment, sourceChannelIds };
  }

  async postSubmission(job, photo) {
    const response = await this.fetchImpl(`${this.config.apiBaseUrl}/api/integrations/discord/axis-submission`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${this.config.secret}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ matchNumber: job.match_number, guildId: job.guild_id, channelId: job.channel_id,
        parentChannelId: job.parent_channel_id, messageId: job.message_id, attachmentId: job.attachment_id,
        authorId: job.author_id, photo: { data: photo.data } }),
    });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok) {
      const error = new Error(typeof body?.error === "string" ? body.error : `backend_http_${response.status}`);
      error.status = response.status;
      error.body = body;
      if (response.status === 404 && body?.error === "match_not_found") error.transient = true;
      throw error;
    }
    const matchNumber = Number(body?.matchNumber);
    const totalPlayers = Number(body?.totalPlayers);
    const recognizedPlayers = Number(body?.recognizedPlayers);
    const coveragePercent = Number(body?.coveragePercent);
    const confidencePercent = body?.confidencePercent == null ? null : Number(body.confidencePercent);
    const readNames = (field) => {
      const value = body?.[field];
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.length > 100 || value.some((name) => typeof name !== "string" || name.length > 200)) throw new Error("invalid_backend_response");
      return value;
    };
    const missingPlayers = readNames("missingPlayers");
    const unmatchedNames = readNames("unmatchedNames");
    const conflictPlayers = readNames("conflictPlayers");
    if (!body || body.ok !== true || matchNumber !== job.match_number || !Number.isSafeInteger(matchNumber)
      || !Number.isSafeInteger(totalPlayers) || totalPlayers < 0 || !Number.isSafeInteger(recognizedPlayers)
      || recognizedPlayers < 0 || recognizedPlayers > totalPlayers || !Number.isFinite(coveragePercent)
      || coveragePercent < 0 || coveragePercent > 100 || confidencePercent !== null && (!Number.isFinite(confidencePercent) || confidencePercent < 0 || confidencePercent > 99)) {
      throw new Error("invalid_backend_response");
    }
    return { ok: true, matchNumber, recognizedPlayers, totalPlayers,
      coveragePercent, confidencePercent,
      needsReview: Boolean(body.needsReview),
      missingPlayers, unmatchedNames, conflictPlayers };
  }

  async processJob(job) {
    if (!this.isJobAllowed(job)) {
      this.revokeJob(job);
      return;
    }
    try {
      const saved = this.store.get(job);
      if (saved?.response_json) {
        const { message } = await this.fetchSourceMessage(job);
        await this.acknowledge(job, message, JSON.parse(saved.response_json));
        return;
      }
      const { message, attachment, sourceChannelIds } = await this.fetchFreshAttachment(job);
      const photo = await downloadAttachment(attachment, sourceChannelIds, this.fetchImpl);
      if (photo.bytes > IMAGE_LIMIT) throw new Error("attachment_too_large");
      const result = await this.postSubmission(job, photo);
      await this.acknowledge(job, message, result);
    } catch (error) {
      if (isSourceRevoked(error)) {
        this.revokeJob(job);
        return;
      }
      if (isRetryable(error)) throw error;
      const status = Number(error?.status);
      const terminal = { ok: false, error: status === 413 ? "attachment_too_large" : error?.message || "processing_failed" };
      let message = null;
      try { ({ message } = await this.fetchSourceMessage(job)); }
      catch (sourceError) {
        if (isSourceRevoked(sourceError)) {
          this.revokeJob(job);
          return;
        }
      }
      await this.acknowledge(job, message, terminal);
    }
  }

  async handleProcessingError(job, error) {
    if (!this.isJobAllowed(job)) {
      this.revokeJob(job);
      return;
    }
    if (isSourceRevoked(error)) {
      this.revokeJob(job);
      return;
    }
    const current = this.store.get(job);
    // A response saved before Discord acknowledgement must remain deliverable
    // after a crash or a permissions outage; never turn it into an unclaimable
    // terminal row just because its OCR attempt budget was exhausted.
    if (current?.response_json) {
      this.store.retry(job, error, backoffMs(job.attempts), this.now());
      return;
    }
    if (isRetryable(error) && job.attempts < this.config.maxAttempts) {
      this.store.retry(job, error, backoffMs(job.attempts), this.now());
      return;
    }
    const terminal = { ok: false, error: "processing_failed" };
    this.store.saveResponse(job, terminal, this.now());
    try {
      let message = null;
      try { ({ message } = await this.fetchSourceMessage(job)); }
      catch (sourceError) {
        if (isSourceRevoked(sourceError)) {
          this.revokeJob(job);
          return;
        }
      }
      await this.acknowledge(job, message, terminal);
    } catch (replyError) {
      this.store.retry(job, replyError, backoffMs(job.attempts), this.now());
      this.logError("reply", replyError);
    }
  }

  async acknowledge(job, message, result) {
    if (!this.isJobAllowed(job)) {
      this.revokeJob(job);
      return;
    }
    const existing = this.store.get(job);
    if (existing?.acked_at) return;
    const channel = message?.channel || await this.client.channels.fetch(job.channel_id, { force: true });
    if (!channel) throw new Error("channel_unavailable");
    if (message) {
      try { this.assertCurrentSource(job, message, channel); }
      catch (error) {
        if (isSourceRevoked(error)) {
          this.revokeJob(job);
          return;
        }
        throw error;
      }
    }
    if (!existing?.response_json) this.store.saveResponse(job, result, this.now());
    const response = existing?.response_json ? JSON.parse(existing.response_json) : result;
    const nonce = createHash("sha256")
      .update(`${job.guild_id}:${job.channel_id}:${job.message_id}:${job.attachment_id}`)
      .digest("hex").slice(0, 24);
    const content = resultMessage(this.config.language, response);
    const found = await this.findExistingAck(channel, message?.id, nonce, content);
    if (!found) {
      if (!message?.reply) throw new Error("message_unavailable");
      await message.reply({ content, allowedMentions: { parse: [] }, nonce, enforceNonce: true });
    }
    this.store.markAcked(job, this.now());
  }

  async findExistingAck(channel, messageId, nonce, expectedContent) {
    if (!channel?.messages?.fetch || !messageId) return false;
    try {
      const messages = await channel.messages.fetch({ limit: 50 });
      return [...(messages?.values?.() ?? [])].some((message) => message.author?.id === this.client.user?.id
        && message.reference?.messageId === messageId
        && (message.nonce === nonce || message.nonce == null && message.content === expectedContent));
    } catch { return false; }
  }

  logError(area, error) {
    const message = String(error?.message || error).replace(/https?:\/\/\S+/gi, "[url]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 240);
    this.logger?.warn?.(`Discord bot ${area} failed: ${message}`);
  }
}

export function createDiscordBotConfig(env = process.env) { return loadDiscordBotConfig(env); }
