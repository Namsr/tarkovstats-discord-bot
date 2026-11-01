import { dict } from "../i18n/dictionary.mjs";

function fill(value, vars = {}) {
  return value.replace(/\{(\w+)\}/g, (_, key) => Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : `{${key}}`);
}

export function messageText(language, key, vars) {
  const lang = language === "en" ? "en" : "ru";
  const dictKey = `axis.discord.${key}`;
  const text = dict?.[lang]?.[dictKey] || dict?.en?.[dictKey] || dictKey;
  return fill(text, vars);
}

export function resultMessage(language, result) {
  const vars = { ...result, coverage: bounded(result.coveragePercent), players: bounded(result.recognizedPlayers), total: bounded(result.totalPlayers) };
  let text;
  if (result.ok && result.needsReview) text = `${messageText(language, "review", vars)}${confidenceText(language, result)}`;
  else if (result.ok) text = `${messageText(language, "accepted", vars)}${confidenceText(language, result)}`;
  else if (result.error === "screenshot_match_mismatch" || result.error === "invalid_submission") text = messageText(language, "invalid", result);
  else if (result.error === "ocr_unavailable") text = messageText(language, "disabled", result);
  else text = messageText(language, "failed", { reason: result.error || "unknown" });

  if (result.ok) {
    const details = [
      ["missing", result.missingPlayers],
      ["unmatched", result.unmatchedNames],
      ["conflicts", result.conflictPlayers],
    ];
    for (const [key, value] of details) {
      const names = safeNames(value);
      if (names.length) text += `\n${messageText(language, key, { names: names.join(", ") })}`;
    }
  }
  return limitMessage(text);
}

function bounded(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 0;
}

function confidenceText(language, result) {
  if (result.confidencePercent == null) return "";
  const confidence = Number(result.confidencePercent);
  return Number.isFinite(confidence) ? ` · ${messageText(language, "confidence", { confidence: Math.max(0, Math.min(99, confidence)) })}` : "";
}

function safeNames(value) {
  if (!Array.isArray(value)) return [];
  const names = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const clean = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
    if (!clean) continue;
    const bounded = Array.from(clean).slice(0, 32).join("");
    const escaped = bounded.replace(/([\\`*_~|>#[\]()@!{}])/g, "\\$1");
    if (escaped && !names.includes(escaped)) names.push(escaped);
    if (names.length >= 10) break;
  }
  return names;
}

function limitMessage(value) {
  const characters = Array.from(String(value));
  return characters.length <= 2000 ? String(value) : `${characters.slice(0, 1997).join("")}...`;
}
