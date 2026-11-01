# TarkovStats Discord Bot

Discord bot for AXIS Arena League matches in Escape from Tarkov: Arena, integrated with [TarkovStats](https://github.com/Namsr/tarkov-stats).

Used in `queue-<match number>` channels on the AXIS Discord server. The bot reminds players to upload the final scoreboard when a match channel opens and again when the winner-voting menu appears. It sends their screenshots to TarkovStats for recognition and replies with the processing result in the same channel.

Screenshots are downloaded as they arrive and saved on TarkovStats before recognition. They remain available for manual review if recognition fails; player statistics are credited only after the usual checks.
