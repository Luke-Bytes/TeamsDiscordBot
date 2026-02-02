export type Pronouns = "HE_HIM" | "SHE_HER" | "THEY_THEM" | "ANY" | "ASK";
export type Language =
  | "ENGLISH"
  | "SPANISH"
  | "JAPANESE"
  | "DUTCH"
  | "GERMAN"
  | "TURKISH"
  | "OTHER";
export type Region = "NA" | "SA" | "EU" | "JP" | "AS" | "AF" | "AU";
export type PlayerRank =
  | "NOVICE"
  | "SILVER"
  | "GOLD"
  | "MASTER"
  | "GRANDMASTER_I"
  | "GRANDMASTER_II"
  | "GRANDMASTER_III"
  | "ANNIHILATOR";
export type Role =
  | "RUSHER"
  | "MID"
  | "FLEX"
  | "GRIEFER"
  | "MINERUSHER"
  | "ICEMAN"
  | "DEFENDER"
  | "SKY_TP"
  | "WALL_BUILDER"
  | "BUNKER"
  | "FARMER"
  | "GOLD_MINER";
export type Playstyle =
  | "TEAM_FIRST"
  | "SHOTCALLER"
  | "PROACTIVE"
  | "DEFENSIVE"
  | "GAP_DROPPER"
  | "SUPPORTER"
  | "FLEXIBLE"
  | "STRATEGIST"
  | "SUPPORTIVE"
  | "INTELLECTUAL"
  | "CLUTCH"
  | "CHILL"
  | "EGOIST"
  | "WHIMSICAL"
  | "ADAPTABLE"
  | "INVIS_OPPORTUNIST";

export type ProfileTitle =
  | "THE_SUC"
  | "DEPPIES_DEMON"
  | "SKYLORD"
  | "VOID_RUNNER"
  | "WALL_WHISPERER"
  | "MID_MAESTRO"
  | "BUNKER_BARON"
  | "GRIEF_GOBLIN";

export const PRONOUNS_LABELS: Record<Pronouns, string> = {
  HE_HIM: "he/him",
  SHE_HER: "she/her",
  THEY_THEM: "they/them",
  ANY: "any",
  ASK: "ask",
};

export const TITLE_LABELS: Record<ProfileTitle, string> = {
  THE_SUC: "The Suc",
  DEPPIES_DEMON: "Deppies Demon",
  SKYLORD: "Skylord",
  VOID_RUNNER: "Void Runner",
  WALL_WHISPERER: "Wall Whisperer",
  MID_MAESTRO: "Mid Maestro",
  BUNKER_BARON: "Bunker Baron",
  GRIEF_GOBLIN: "Grief Goblin",
};

export const LANGUAGE_LABELS: Record<Language, string> = {
  ENGLISH: "English",
  SPANISH: "Spanish",
  JAPANESE: "Japanese",
  DUTCH: "Dutch",
  GERMAN: "German",
  TURKISH: "Turkish",
  OTHER: "Other",
};

export const REGION_LABELS: Record<Region, string> = {
  NA: "NA",
  SA: "SA",
  EU: "EU",
  JP: "JP",
  AS: "AS",
  AF: "AF",
  AU: "AU",
};

export const RANK_LABELS: Record<PlayerRank, string> = {
  NOVICE: "Novice",
  SILVER: "Silver",
  GOLD: "Gold",
  MASTER: "Master",
  GRANDMASTER_I: "Grandmaster I",
  GRANDMASTER_II: "Grandmaster II",
  GRANDMASTER_III: "Grandmaster III",
  ANNIHILATOR: "Annihilator",
};

export const ROLE_LABELS: Record<Role, string> = {
  RUSHER: "Rusher",
  MID: "Mid",
  FLEX: "Flex",
  GRIEFER: "Griefer",
  MINERUSHER: "Minerusher",
  ICEMAN: "Iceman",
  DEFENDER: "Defender",
  SKY_TP: "Sky TP",
  WALL_BUILDER: "Wall Builder",
  BUNKER: "Bunker",
  FARMER: "Farmer",
  GOLD_MINER: "Gold Miner",
};

export const PLAYSTYLE_LABELS: Record<Playstyle, string> = {
  TEAM_FIRST: "Team-first",
  SHOTCALLER: "Shotcaller",
  PROACTIVE: "Proactive",
  DEFENSIVE: "Defensive",
  GAP_DROPPER: "Gap Dropper",
  SUPPORTER: "Supporter",
  FLEXIBLE: "Flexible",
  STRATEGIST: "Strategist",
  SUPPORTIVE: "Supportive",
  INTELLECTUAL: "Intellectual",
  CLUTCH: "Clutch",
  CHILL: "Chill",
  EGOIST: "Egoist",
  WHIMSICAL: "Whimsical",
  ADAPTABLE: "Adaptable",
  INVIS_OPPORTUNIST: "Invis Opportunist",
};

export const ROLE_LIST = Object.keys(ROLE_LABELS) as Role[];
export const PLAYSTYLE_LIST = Object.keys(PLAYSTYLE_LABELS) as Playstyle[];
export const LANGUAGE_LIST = Object.keys(LANGUAGE_LABELS) as Language[];
export const PRONOUNS_LIST = Object.keys(PRONOUNS_LABELS) as Pronouns[];
export const REGION_LIST = Object.keys(REGION_LABELS) as Region[];
export const RANK_LIST = Object.keys(RANK_LABELS) as PlayerRank[];
export const TITLE_LIST = Object.keys(TITLE_LABELS) as ProfileTitle[];

export function formatEnumList<T extends string>(
  values: T[] | null | undefined,
  labels: Record<T, string>
): string {
  if (!values || values.length === 0) return "";
  return values.map((v) => labels[v]).join(", ");
}
