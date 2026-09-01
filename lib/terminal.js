"use strict";

const { safeText } = require("./safety");

const ANSI = Object.freeze({
  reset: "\u001b[0m",
  clearLine: "\r\u001b[2K",
  bold: "1",
  dim: "2",
  brand: "38;2;208;254;29",
  success: "38;2;74;222;128",
  warning: "38;2;250;204;21",
  error: "38;2;255;82;82",
});

function colorEnabled({ color, stream = process.stdout, env = process.env } = {}) {
  if (color === false || env?.NO_COLOR !== undefined) return false;
  return Boolean(stream?.isTTY);
}

function animationEnabled({ stream = process.stdout, env = process.env, background = false } = {}) {
  if (background || !stream?.isTTY) return false;
  if (env?.CI || env?.TERM === "dumb") return false;
  return true;
}

function paint(code, value, color = false) {
  const text = String(value);
  return color ? `\u001b[${code}m${text}${ANSI.reset}` : text;
}

function formatInteger(value) {
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function formatUsd(value) {
  const number = Number(value);
  const digits = number > 0 && number < 0.01 ? 4 : 2;
  return `$${number.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

function providerReceiptLines(payload, color) {
  const providers = Array.isArray(payload?.providers) ? payload.providers : [];
  return providers
    .filter((row) => Number(row.totalTokens) > 0 || Number(row.costUsd) > 0)
    .map(
      (row) =>
        `  ${paint(ANSI.dim, String(row.name), color)} ${formatInteger(row.totalTokens)} tokens · ${formatUsd(row.costUsd)} estimated`,
    );
}

function renderNotice(message, { color = false, kind = "success" } = {}) {
  const clean = safeText(message, { fallback: "Cribble finished.", maxLength: 2_000 });
  const code = ANSI[kind] ?? ANSI.brand;
  const icon = kind === "error" ? "✕" : kind === "warning" ? "!" : "✓";
  return `${paint(code, icon, color)} ${clean}`;
}

function renderCliError(message, { color = false } = {}) {
  const clean = safeText(message, { fallback: "Unknown failure", maxLength: 1_000 });
  return `${paint(ANSI.error, "Cribble error", color)}: ${clean}`;
}

function renderSyncReceipt({ payload, result, counts }, { color = false } = {}) {
  const daily = Array.isArray(payload?.daily) ? payload.daily : [];
  const firstDate = daily.at(0)?.date ?? "unknown date";
  const lastDate = daily.at(-1)?.date ?? firstDate;
  const range = firstDate === lastDate ? firstDate : `${firstDate} → ${lastDate}`;
  const totalTokens = daily.reduce((sum, row) => sum + Number(row.totalTokens ?? 0), 0);
  const totalCost = daily.reduce((sum, row) => sum + Number(row.costUsd ?? 0), 0);
  const dayLabel = `${daily.length} usage day${daily.length === 1 ? "" : "s"}`;
  const endpoint = safeText(result?.endpoint, { fallback: "Cribble", maxLength: 300 });
  const httpStatus = Number.isInteger(result?.status) ? `HTTP ${result.status}` : "accepted";
  const inserted = Number.isInteger(counts?.inserted) ? counts.inserted : 0;
  const replaced = Number.isInteger(counts?.replaced) ? counts.replaced : 0;
  const stale = Number.isInteger(counts?.stale) ? counts.stale : 0;

  return [
    paint(ANSI.brand, "Cribble · Sync complete", color),
    `${paint(ANSI.success, "✓", color)} Synced ${dayLabel} · ${range}`,
    `  ${paint(ANSI.bold, formatInteger(totalTokens), color)} tokens · ${paint(ANSI.success, formatUsd(totalCost), color)} estimated`,
    ...providerReceiptLines(payload, color),
    `  ${inserted} new · ${replaced} updated · ${stale} unchanged`,
    paint(ANSI.dim, `  ${endpoint} · ${httpStatus}`, color),
  ].join("\n");
}

function createActivity({
  output = process.stdout,
  enabled = false,
  color = false,
  intervalMs = 80,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let frameIndex = 0;
  let label = "";
  let timer = null;
  let active = false;

  const draw = () => {
    if (!active) return;
    const frame = paint(ANSI.brand, frames[frameIndex % frames.length], color);
    frameIndex += 1;
    output.write(`${ANSI.clearLine}${frame} ${safeText(label, { maxLength: 160 })}`);
  };

  const stop = () => {
    if (!active) return;
    active = false;
    if (timer !== null) clearIntervalFn(timer);
    timer = null;
    output.write(ANSI.clearLine);
  };

  return {
    start(nextLabel) {
      if (!enabled || active) return;
      label = nextLabel;
      active = true;
      draw();
      timer = setIntervalFn(draw, intervalMs);
      timer?.unref?.();
    },
    update(nextLabel) {
      if (!enabled || !active) return;
      label = nextLabel;
      draw();
    },
    stop,
  };
}

module.exports = {
  ANSI,
  animationEnabled,
  colorEnabled,
  createActivity,
  paint,
  renderCliError,
  renderNotice,
  renderSyncReceipt,
};
