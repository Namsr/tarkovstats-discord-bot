import assert from "node:assert/strict";
import { dict } from "../lib/i18n/dictionary.mjs";

const keys = Object.keys(dict.en).sort();
assert.deepEqual(Object.keys(dict.ru).sort(), keys);
for (const key of ["downloading", "downloaded", "reminder", "accepted", "review", "confidence", "failed", "invalid", "disabled", "notScoreboard", "missing", "unmatched", "conflicts"]) {
  assert.ok(keys.includes(`axis.discord.${key}`), `Missing message ${key}`);
}
for (const key of keys) {
  for (const lang of ["en", "ru"]) assert.ok(typeof dict[lang][key] === "string" && dict[lang][key].trim(), `${lang}: ${key}`);
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  assert.deepEqual(placeholders(dict.en[key]), placeholders(dict.ru[key]), `Placeholder mismatch: ${key}`);
}
console.log(`i18n: ${keys.length} matching English/Russian messages`);
