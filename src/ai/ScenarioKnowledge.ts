import { scenarioMetadata } from "../logic/scenarios/ScenarioMetadata";

/** Route explicit scenario questions and distinctive mechanics, not ordinary
 * registration, class bans, captain selection or draft questions. */
export function scenarioQuestionHeadings(question: string): Set<string> {
  const q = question.toLowerCase().replace(/[’‘]/g, "'");
  const headings = new Set<string>();
  const general = "Friendly Wars scenarios - guide, registration and private prompts";
  const announce = "Announce and prepare a scenario game";
  const status = "Scenario status, reminders and resend prompts";
  const start = "Scenario game start, team selection and Cursed Classes pool";
  const recovery = "Scenario recovery, manual start, resume and cancel";
  const privacy = "Scenario privacy and live questions";
  const matches: [keyof typeof scenarioMetadata, RegExp][] = [
    ["mystery-dungeon", /\bmystery dungeon\b|\bpersonality (?:test|quiz|type|answers?)\b|\bquiz\b/],
    ["peoples-captains", /\bpeople'?s captains\b|\b(?:captain election|elected captains?|ballots?|self.vot(?:e|ing)|vot(?:e|ing) for (?:myself|captains?)|different voting options|not enough (?:people vote|votes))\b/],
    ["partners-in-crime", /\bpartners in crime\b|\b(?:mutual pairs?|partner preferences?|choose (?:my|a) partner|partner.*(?:choose|pick) me|someone know if i picked them|guaranteed.*same team)\b/],
    ["masked-draft", /\bmasked draft\b|\banonymous cards?\b|\b(?:player identities|see who i(?:'m| am) picking|mystery cards?)\b/],
    ["draft-roulette", /\bdraft roulette\b|\brerolls?\b|\bpick from (?:up to )?three players\b/],
    ["captains-wildcards", /\bcaptain'?s wildcards?\b|\bwildcards?\b|\bswitcheroo\b|\bveto\b/],
    ["class-hex", /\bcursed classes\b|\bclass hex\b|\bcurs(?:e|ed|es)\b|\bassigned class\b|\breport-class\b/],
  ];
  for (const [id, pattern] of matches) {
    if (pattern.test(q)) headings.add(scenarioMetadata[id].name);
  }
  const explicit = /\bscenarios?\b|\bopen my scenario\b/.test(q);
  const prompt = /\b(?:scenario prompt|private prompt|scenario interaction|resend.*prompt|resend.*interaction|missed.*dm|sent me a dm|closed.*prompt)\b/.test(q);
  if (!explicit && !prompt && !headings.size) return headings;

  if (prompt || /\b(?:guide|browse|register|registration|join|dm|open|all the scenarios|what scenario)\b/.test(q) || (explicit && !headings.size)) headings.add(general);
  if (/\b(?:announce|announcing|organise|organize)\b/.test(q)) headings.add(announce);
  if (/\b(?:resend|status|dashboard|respond|remind|still needs|delivery)\b/.test(q)) headings.add(status);
  if (/\b(?:pool|start the game|game start|report-class|team selection)\b/.test(q)) headings.add(start);
  if (/\b(?:restarts?|restarted|resume|cancel|recover|hasn'?t (?:the scenario )?started|manual start|fallback)\b/.test(q)) headings.add(recovery);
  if (/\b(?:what scenario|current scenario|private|hidden|unrevealed|live)\b/.test(q)) headings.add(privacy);
  return headings;
}
