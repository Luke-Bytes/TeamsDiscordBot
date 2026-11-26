import { ScenarioDefinition } from "./ScenarioTypes";
import { scenarioMetadata } from "./ScenarioMetadata";
import { mysteryDungeon } from "./mysteryDungeon/MysteryDungeon";
import { partnersInCrime } from "./partnersInCrime/PartnersInCrime";
import { peoplesCaptains } from "./peoplesCaptains/PeoplesCaptains";
import { draftRoulette, maskedDraft } from "./drafts/DraftScenarios";
import { captainsWildcards } from "./captainsWildcards/CaptainsWildcards";
import { classHex } from "./classHex/ClassHex";

/** Catalogue only. An unavailable definition cannot be selected on a live match. */
export const plannedScenarios: ScenarioDefinition[] = [
  { id: "mystery-dungeon", ...scenarioMetadata["mystery-dungeon"], category: "team-formation", stage: "registration", version: 1, capabilities: { teams: true }, enabled: true, get implementation() { return mysteryDungeon; }, triggers: [{ id: "questionnaire", type: "on_registration", kind: "questionnaire", allowUpdates: true }, { id: "lock", type: "before_game_start", offsetMinutes: 15, manual: true, minPlayers: 2, captureRoster: true }] },
  { id: "peoples-captains", ...scenarioMetadata["peoples-captains"], category: "captain-selection", stage: "captains", version: 2, capabilities: { captains: true, normalDraft: true }, enabled: true, get implementation() { return peoplesCaptains; }, triggers: [{ id: "election", type: "before_game_start", offsetMinutes: 35, manual: true, minPlayers: 4, captureRoster: true }, { id: "close", type: "before_game_start", offsetMinutes: 20, manual: true, minPlayers: 4, captureRoster: true }] },
  { id: "partners-in-crime", ...scenarioMetadata["partners-in-crime"], category: "team-formation", stage: "registration", version: 1, capabilities: { teams: true }, enabled: true, get implementation() { return partnersInCrime; }, triggers: [{ id: "preferences", type: "on_registration", kind: "preferences", allowUpdates: true }, { id: "lock", type: "before_game_start", offsetMinutes: 15, manual: true, minPlayers: 2, captureRoster: true }] },
  { id: "masked-draft", ...scenarioMetadata["masked-draft"], category: "draft", stage: "draft", version: 1, capabilities: { draft: true }, enabled: true, get implementation() { return maskedDraft; }, triggers: [{ id: "draft", type: "on_draft_start", manual: true, requireCaptains: true, minPlayers: 4, captureRoster: true }] },
  { id: "draft-roulette", ...scenarioMetadata["draft-roulette"], category: "draft", stage: "draft", version: 1, capabilities: { draft: true }, enabled: true, get implementation() { return draftRoulette; }, triggers: [{ id: "draft", type: "on_draft_start", manual: true, requireCaptains: true, minPlayers: 4, captureRoster: true }] },
  { id: "captains-wildcards", ...scenarioMetadata["captains-wildcards"], category: "draft-extension", stage: "draft", version: 1, capabilities: { normalDraft: true }, enabled: true, get implementation() { return captainsWildcards; }, compatibility: ["draft", "snake"], triggers: [{ id: "wildcards", type: "on_draft_start", manual: true, requireCaptains: true }] },
  { id: "class-hex", ...scenarioMetadata["class-hex"], category: "gameplay-restriction", stage: "pre-game", version: 1, capabilities: { requiresFinalTeams: true }, enabled: true, get implementation() { return classHex; }, triggers: [{ id: "hex", type: "on_teams_finalized", manual: true, requireCaptains: true, requireFinalTeams: true, minPlayers: 6, captureRoster: true }, { id: "deadline", type: "before_game_start", offsetMinutes: 3, manual: true, requireFinalTeams: true, requireCaptains: true }] },
];

export class ScenarioRegistry {
  private readonly definitions: Map<string, ScenarioDefinition>;

  constructor(definitions: ScenarioDefinition[] = plannedScenarios) {
    this.definitions = new Map();
    for (const definition of definitions) {
      if (!/^[a-z][a-z0-9-]{1,48}$/.test(definition.id) ||
          !Number.isSafeInteger(definition.version) || definition.version < 1 ||
          this.definitions.has(definition.id)) {
        throw new Error(`Invalid or duplicate scenario definition: ${definition.id}`);
      }
      const ids = new Set<string>();
      for (const policy of definition.triggers ?? []) {
        if (!["on_registration", "before_game_start", "on_captains_ready", "on_teams_finalized", "on_draft_start", "manual"].includes(policy.type) ||
            (policy.requiredPhase !== undefined && !["collecting", "ready"].includes(policy.requiredPhase)) ||
            !/^[a-z][a-z0-9-]{0,23}$/.test(policy.id) || ids.has(policy.id) ||
            (policy.type === "before_game_start" && policy.offsetMinutes === undefined) ||
            (policy.offsetMinutes !== undefined && (!Number.isFinite(policy.offsetMinutes) || policy.offsetMinutes < 0)) ||
            (policy.minPlayers !== undefined && (!Number.isSafeInteger(policy.minPlayers) || policy.minPlayers < 0)))
          throw new Error(`Invalid scenario trigger: ${definition.id}/${policy.id}`);
        ids.add(policy.id);
      }
      this.definitions.set(definition.id, definition);
    }
  }

  get(id: string): ScenarioDefinition | undefined { return this.definitions.get(id); }
  all(): ScenarioDefinition[] { return [...this.definitions.values()]; }
  available(): ScenarioDefinition[] {
    return this.all().filter((scenario) => scenario.enabled === true && !!scenario.implementation);
  }
  requireAvailable(id: string): ScenarioDefinition {
    const scenario = this.get(id);
    if (!scenario) throw new Error(`Unknown scenario: ${id}`);
    if (!scenario.enabled || !scenario.implementation)
      throw new Error(`${scenario.name} is planned but not available yet.`);
    return scenario;
  }
}

export const scenarioRegistry = new ScenarioRegistry();
