import { sampleDistinct, type ScenarioRandom } from "../shared/ScenarioRandom";
import { voiceEffects, type VoiceEffectId } from "../shared/VoiceEffects";

const minute = 60_000;
const windows = [20, 30, 40];
const catalogue = Object.keys(voiceEffects) as VoiceEffectId[];

export interface ImpostorVoiceSlot {
  ownerId: string;
  effect: VoiceEffectId;
  windowIndex: number;
}

export function drawVoiceSlots(owners: readonly string[], random: ScenarioRandom = Math.random): ImpostorVoiceSlot[] {
  const order = sampleDistinct(owners, owners.length, random);
  const effects = sampleDistinct(catalogue, owners.length, random);
  if (owners.length > windows.length || new Set(owners).size !== owners.length)
    throw new Error("Invalid voice slot allocation.");
  return order.map((ownerId, windowIndex) => ({ ownerId, windowIndex, effect: effects[windowIndex] }));
}

export function slotTiming(slot: ImpostorVoiceSlot, announcedStart: number, random: ScenarioRandom = Math.random) {
  if (!Number.isFinite(announcedStart) || !windows[slot.windowIndex])
    throw new Error("Invalid sabotage timing.");
  const estimate = announcedStart + 3 * minute;
  const opens = estimate + windows[slot.windowIndex] * minute;
  const closes = opens + 4 * minute;
  const latestStart = closes - voiceEffects[slot.effect].durationMs;
  const fallback = opens + Math.floor(random() * (latestStart - opens + 1));
  return { opens, closes, latestStart, fallback };
}
