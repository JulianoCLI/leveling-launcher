'use strict';

const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const LOG_MAX = 300;

function normalizeInterval(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL_MS;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.floor(n)));
}

function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const disabled = Array.isArray(source.disabled)
    ? [...new Set(source.disabled.map(Number).filter(Number.isInteger).filter(n => n >= 0))]
    : [];
  return {
    enabled: !!source.enabled,
    intervalMs: normalizeInterval(source.intervalMs),
    daily: source.daily !== false,
    bestTeam: source.bestTeam !== false,
    mail: source.mail !== false,
    disabled
  };
}

function accountEnabled(config, index) {
  return !normalizeConfig(config).disabled.includes(Number(index));
}

function defaultConfig() {
  return normalizeConfig({});
}

module.exports = {
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  DEFAULT_INTERVAL_MS,
  LOG_MAX,
  normalizeConfig,
  accountEnabled,
  defaultConfig
};
