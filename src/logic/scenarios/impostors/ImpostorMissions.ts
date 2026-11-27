import { sampleDistinct, type ScenarioRandom } from "../shared/ScenarioRandom";

export const impostorMissions = [
  { id: "confession", label: "Confession", objective: "Place a sign in the open in your base saying 'THE IMPOSTER? ITS ME'" },
  { id: "furnace-failure", label: "Furnace Failure", objective: "Break 1 of your bunker's furnaces while it's cooking gold" },
  { id: "crop-failure", label: "Crop Failure", objective: "Break 15 of your farm's crops as NOT farmer" },
  { id: "potion-waster", label: "Potion Waster", objective: "Waste a potion in front of a team mate" },
  { id: "bunker-blockade", label: "Bunker Blockade", objective: "Block your own bunker off with at least 3 blocks" },
  { id: "witch-hunt", label: "Witch Hunt", objective: "Hide your own team's witch" },
  { id: "diamond-denial", label: "Diamond Denial", objective: "Cover 1 of the dia while your team controls mid" },
  { id: "fake-gapple", label: "Fake Gapple", objective: "Convince your team 1 of the enemies they are fighting ate a gapple when they didn't" },
  { id: "property-development", label: "Property Development", objective: "Build a house on your team's path to mid" },
  { id: "hoe-donation", label: "Hoe Donation", objective: "Drop 10 wooden hoes on the level 1 enchanting table" },
  { id: "inside-job", label: "Inside Job", objective: "Grief your gold mine and get your team to believe the enemy did it" },
] as const;

export type MissionId = typeof impostorMissions[number]["id"];
const catalogue = impostorMissions.map((mission) => mission.id);
export type ImpostorTeam = "RED" | "BLUE";
export type ImpostorRoster = Readonly<Record<ImpostorTeam, readonly string[]>>;

export function impostorsPerTeam(roster: ImpostorRoster): number {
  const all = [...roster.RED, ...roster.BLUE];
  const smaller = Math.min(roster.RED.length, roster.BLUE.length);
  if (smaller < 8 || all.some((id) => !id) || new Set(all).size !== all.length)
    throw new Error("The Impostors requires at least eight distinct players on each team.");
  return smaller === 8 ? 1 : smaller < 16 ? 2 : 3;
}

export function drawImpostors(roster: ImpostorRoster, random?: ScenarioRandom) {
  const count = impostorsPerTeam(roster);
  return {
    RED: sampleDistinct(roster.RED, count, random),
    BLUE: sampleDistinct(roster.BLUE, count, random),
  };
}

export function drawMissionHand(random?: ScenarioRandom): MissionId[] {
  return sampleDistinct(catalogue, 5, random);
}

export function rerollMission(hand: readonly MissionId[], unwanted: MissionId, random?: ScenarioRandom): MissionId[] {
  if (hand.length !== 5 || new Set(hand).size !== 5 ||
      hand.some((id) => !catalogue.includes(id)) || !hand.includes(unwanted))
    throw new Error("Invalid mission selection.");
  const replacement = sampleDistinct(catalogue.filter((id) => !hand.includes(id)), 1, random)[0];
  return hand.map((id) => id === unwanted ? replacement : id);
}

export function validateMissionClaims(hand: readonly MissionId[], claims: readonly MissionId[]): MissionId[] {
  if (new Set(claims).size !== claims.length || claims.some((id) => !hand.includes(id)))
    throw new Error("Invalid mission claim.");
  return [...claims];
}
