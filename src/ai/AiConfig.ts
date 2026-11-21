/** Opt-in settings, independent of HiveOps. No provider keys are read on startup. */
export type AiSettings = {
  enabled: boolean;
  channelIds: ReadonlySet<string>;
  model: string;
  dailyRequestLimit: number;
};

export function getAiSettings(
  env: NodeJS.ProcessEnv = process.env
): AiSettings {
  const channels = (env.TEAMS_AI_CHANNEL_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const model = env.TEAMS_AI_GROQ_MODEL ?? "";
  const validChannels =
    channels.length > 0 && channels.every((id) => /^\d{8,25}$/.test(id));
  // Model is an operator-supplied ID, never selected by Discord users or tools.
  const validModel =
    /^[a-zA-Z0-9][a-zA-Z0-9._/-]{1,100}$/.test(model) && !model.includes("..");
  const desiredCap = Number(env.TEAMS_AI_DAILY_REQUESTS ?? "50");
  const dailyRequestLimit =
    Number.isInteger(desiredCap) && desiredCap >= 1 && desiredCap <= 200
      ? desiredCap
      : 50;
  return {
    enabled:
      env.TEAMS_AI_ENABLED === "true" &&
      env.TEAMS_AI_EGRESS_APPROVED === "true" &&
      validChannels &&
      validModel,
    channelIds: new Set(validChannels ? channels : []),
    model: validModel ? model : "",
    dailyRequestLimit,
  };
}
