# TarkovStats Discord bot

Standalone AXIS match screenshot worker for [TarkovStats](https://github.com/Namsr/tarkov-stats).
The worker reads allowed Discord match channels, sends images to the website's authenticated
submission API, and replies to the original message. OCR, player matching and statistics
storage remain on the website. The bot has no access to the website's database volumes.

The runtime and its regression tests were extracted from `Namsr/tarkov-stats`
revision `9ab828d9fb8a0de5980b5ad1eaf3d253a8cc4eb8`.
The legacy worker remains available in the website repository until the production cutover.

## Requirements and installation

Use Node.js 22.18 or newer; CI and the Docker image use Node.js 22.23.3.

```sh
npm ci --ignore-scripts
npm run i18n:check
npm test
npm run smoke
```

The smoke check does not log in to Discord, send messages or call the website.

Create a private `.env.discord` file yourself. All `.env*` files, including examples,
are ignored by Git and excluded from the Docker build context. Never commit a bot token,
integration secret or a copy of the website's environment files.

```dotenv
DISCORD_TOKEN=<your Discord bot token>
AXIS_DISCORD_SECRET=<same integration secret as the website, at least 32 characters>
AXIS_DISCORD_GUILD_ID=<your server ID>
AXIS_DISCORD_CHANNEL_IDS=<allowed category or text channel IDs, comma-separated>
AXIS_DISCORD_MATCH_PREFIX=queue-
AXIS_DISCORD_MATCH_CHANNELS={}
AXIS_DISCORD_API_BASE_URL=http://127.0.0.1:3000
AXIS_DISCORD_STATE_PATH=./data/axis-discord.db
AXIS_DISCORD_LANG=ru
```

Run against a local website:

```sh
node --env-file=.env.discord --experimental-sqlite scripts/axis-discord-bot.mjs
```

`npm start` expects environment variables to have already been supplied by the process manager.

Enable the Message Content privileged intent in the Discord Developer Portal. Invite the
bot with View Channel, Read Message History and Send Messages permissions for its match
channels. Threads additionally need Send Messages in Threads. Administrator is unnecessary.

## Channel selection

- Only the configured server and allowed channels are accepted. Bot and webhook messages are ignored.
- Allow a **category ID** to handle newly created direct child text channels automatically.
  The permanent Join Queue text channel is not the parent of the match channels.
- `queue-5771` selects match 5771. The entire name must match the configured prefix and a positive integer.
- Explicit `AXIS_DISCORD_MATCH_CHANNELS` mappings override names. Leave it `{}` for ordinary queue channels.
- A category allowlist does not recursively allow threads inside its child channels. Allow the
  thread itself or its parent text channel if threads are required.
- Replies stay attached to the source message. A reminder is queued when an allowed new match
  channel is created while the worker is online. Existing channels do not receive a startup reminder.

Keep `AXIS_DISCORD_SECRET`, `AXIS_DISCORD_GUILD_ID` and `AXIS_DISCORD_CHANNEL_IDS` synchronized
with the website's integration configuration. The website never needs the Discord bot token.

## Docker

Set `AXIS_DISCORD_API_BASE_URL` in your private `.env.discord` to the website's **HTTPS URL**
when using ordinary Docker hosting. `127.0.0.1` inside a container refers to that container,
not the host or the website. Plain HTTP is permitted only for `web`, `localhost` and `127.0.0.1`.

```sh
docker compose up -d --build bot
docker compose logs --tail 100 bot
```

The container runs as UID/GID 1001 with a read-only root filesystem. The named volume stores
`/data/axis-discord.db`, including durable jobs, history checkpoints and reminder state.
It exposes no ports. Preserve the volume across updates and never run two workers on the same queue.

### Existing TarkovStats VPS

`compose.vps.yaml` reuses the existing external network `tarkovstats_default` and external
volume `tarkovstats_axis_discord_data`. It keeps the existing queue path, UID, background
slice and CPU/memory/PID limits. It overrides the API URL to `http://web:3000`.
Docker will fail if those external resources are missing rather than silently create an empty queue.

After this code is reviewed and merged, build the image before stopping the legacy worker.
Back up the stopped worker's SQLite queue, then start exactly one standalone worker:

```sh
docker compose -f compose.yaml -f compose.vps.yaml build bot
# Stop the legacy axis-discord service in its original Compose project first.
# Preserve and back up its state volume before starting the standalone worker.
docker compose -f compose.yaml -f compose.vps.yaml up -d --no-build bot
```

Keep the private bot environment separate from the website's environment. The host's existing
Discord network connectivity setup remains necessary. This repository does not configure the host network.

## Messages and language

The language is configured once for the whole worker: `AXIS_DISCORD_LANG=en` selects English;
every other value, including an unset value, selects Russian. There is no per-user or per-channel
language detection. `AXIS_DISCORD_REMINDER_TEXT` optionally replaces the reminder exactly as written,
independently of the selected language.

New match reminder:

> Перед выбором победителя отправьте в этот чат скриншот итоговой таблицы результатов, чтобы статистика попала на TarkovStats.

> Before choosing the winner, send a screenshot of the final results table in this chat so the statistics can be recorded on TarkovStats.

Screenshot replies report accepted statistics, required manual review, a mismatched match,
unavailable OCR, or a processing failure. Successful replies can include missing players,
unmatched nicknames, conflicting statistics and an OCR score. Both languages live in
`lib/i18n/dictionary.mjs`; placeholders and key sets are checked by `npm run i18n:check`.

## Recovery and integration

The website endpoint is `POST /api/integrations/discord/axis-submission`, authorized with
`Bearer AXIS_DISCORD_SECRET`. The payload carries the match number, source server/channel/message/
attachment/author IDs and a base64 image. Only Discord attachment CDN URLs are downloaded,
with source-ID validation, a 10 MiB size bound and a timeout. The API's recognized-player
counts, coverage and review details are validated before replying.

On startup and reconnect, the worker recovers channel history. It also checks periodically:

| Setting | Default | Meaning |
| --- | --- | --- |
| `AXIS_DISCORD_BOOTSTRAP_MESSAGES` | `100` | Initial history window per channel, `0` disables recovery |
| `AXIS_DISCORD_CATCHUP_MS` | `60000` | History recovery interval |
| `AXIS_DISCORD_MAX_PENDING` | `1000` | Maximum pending screenshot attachments |
| `AXIS_DISCORD_MAX_ATTEMPTS` | `8` | Processing retry budget |

State and stored acknowledgements survive restarts. A channel's source authorization is
refetched before processing or replying. Important archived threads should be configured
explicitly because active-thread discovery does not include every archived thread.
