FROM node:22.23.3-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production AXIS_DISCORD_STATE_PATH=/data/axis-discord.db
RUN groupadd --gid 1001 bot && useradd --uid 1001 --gid 1001 --no-create-home bot
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force \
    && mkdir -p /data && chown bot:bot /data
COPY --chown=bot:bot lib ./lib
COPY --chown=bot:bot scripts ./scripts
USER bot
CMD ["node", "--experimental-sqlite", "scripts/axis-discord-bot.mjs"]
