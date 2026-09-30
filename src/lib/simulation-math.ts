import type { Action, Actor, Metrics } from "./types";

/** These are descriptive statistics of synthetic actors, not forecast probabilities. */
export function calculateMetrics(actors: Actor[], actions: Action[]): Metrics {
  if (actors.length === 0) return { support: 0, polarization: 0, activity: 0 };
  const mean =
    actors.reduce((sum, actor) => sum + actor.stance, 0) / actors.length;
  const variance =
    actors.reduce((sum, actor) => sum + (actor.stance - mean) ** 2, 0) /
    actors.length;
  const rounded = (value: number) => Math.round(value * 100) / 100;
  return {
    support: rounded((mean + 1) * 50),
    polarization: rounded(Math.min(100, Math.sqrt(variance) * 100)),
    activity: actions.filter((action) => action.kind !== "observe").length,
  };
}

export function clamp(value: number, min = -1, max = 1) {
  return Math.max(min, Math.min(max, value));
}

/** Stable per-key randomness avoids changes caused by asynchronous completion order. */
export function seededValue(seed: number, key: string): number {
  let value = (seed | 0) ^ 2166136261;
  for (let index = 0; index < key.length; index++) {
    value = Math.imul(value ^ key.charCodeAt(index), 16777619);
  }
  value ^= value >>> 16;
  value = Math.imul(value, 0x21f0aaad);
  value ^= value >>> 15;
  value = Math.imul(value, 0x735a2d97);
  return ((value ^ (value >>> 15)) >>> 0) / 4294967296;
}
