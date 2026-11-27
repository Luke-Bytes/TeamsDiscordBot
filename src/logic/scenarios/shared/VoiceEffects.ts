import { sampleDistinct, type ScenarioRandom } from "./ScenarioRandom";

const minute = 60_000;
export const voiceEffects = {
  "radio-silence": { operation: "mute", durationMs: 3 * minute },
  blackout: { operation: "deafen", durationMs: minute },
  quarantine: { operation: "move", durationMs: 2 * minute },
  "communications-split": { operation: "move", durationMs: 2 * minute },
  "solitary-confinement": { operation: "move", durationMs: 3 * minute },
  leaderless: { operation: "mute", durationMs: 2 * minute },
} as const;
export type VoiceEffectId = keyof typeof voiceEffects;
export type VoiceOperation = typeof voiceEffects[VoiceEffectId]["operation"];

export interface VoiceParticipant {
  id: string;
  channelId: string | null;
  eligible: boolean;
  serverMute: boolean;
  serverDeaf: boolean;
}

export function selectVoiceTargets(
  effect: VoiceEffectId,
  channelId: string,
  participants: readonly VoiceParticipant[],
  captainId?: string,
  random?: ScenarioRandom
): string[] {
  const connected = participants.filter((p) => p.eligible && p.channelId === channelId);
  const pool = connected.filter((p) => !p.serverMute && !p.serverDeaf);
  if (effect === "leaderless")
    return pool.some((p) => p.id === captainId) ? [captainId!] : [];
  if (connected.length < 2) return [];
  const count =
    effect === "radio-silence" ? Math.max(1, Math.round(connected.length * 0.3)) :
    effect === "blackout" ? Math.max(1, Math.round(connected.length * 0.2)) :
    effect === "quarantine" ? (connected.length >= 10 ? 3 : 2) :
    effect === "communications-split" ? Math.floor(connected.length / 2) : 1;
  if (count > pool.length || count >= connected.length) return [];
  return sampleDistinct(pool.map((p) => p.id), count, random);
}
