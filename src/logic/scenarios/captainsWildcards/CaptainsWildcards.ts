import type { GameInstance } from "../../../database/GameInstance";
import type { ScenarioAction, ScenarioImplementation, ScenarioValue } from "../ScenarioTypes";
import { DraftTeamPickingSession } from "../../teams/DraftTeamPickingSession";
import TeamCommand from "../../../commands/TeamCommand";
import { choice, data, deliverPrivate, openScenarioAction, participantLabel, selectPrompt } from "../ScenarioGameplay";

type Side = "RED" | "BLUE";
interface Pending {
  id: string;
  turn: number;
  step: "power" | "veto" | "from" | "to" | "review";
  power?: "veto" | "swap";
  target?: string;
  from?: string;
  page: number;
}
interface WildcardsState {
  credits: Record<Side, number>;
  pending: Record<string, Pending>;
  history: string[];
}
const initial = (): WildcardsState => ({ credits: { RED: 1, BLUE: 1 }, pending: {}, history: [] });
const current = (game: GameInstance): WildcardsState => data<WildcardsState>(game, "wildcards", initial());
const active = (): DraftTeamPickingSession | null => {
  const session = TeamCommand.instance?.teamPickingSession;
  return session instanceof DraftTeamPickingSession && session.getState() === "inProgress" ? session : null;
};
const id = (action: ScenarioAction) => action.ownerId;
function render(game: GameInstance, action: ScenarioAction, customId: string) {
  const session = active();
  const state = current(game);
  const turn = session?.wildcardTurn();
  const pending = state.pending[id(action)];
  if (!session || !turn || !turn.team || turn.owner !== id(action) ||
      pending?.id !== action.id || pending.turn !== turn.index || !state.credits[turn.team])
    return { content: "That wildcard turn is over or the credit has been spent. You can continue the normal draft." };
  const items = (ids: string[], prefix: string) => {
    const slice = [...ids].sort().slice(pending.page * 20, pending.page * 20 + 20);
    return [
      ...slice.map((p) => ({ label: participantLabel(game, p).slice(0, 100), value: `${prefix}:${p}` })),
      ...(pending.page * 20 + 20 < ids.length ? [{ label: "Next page", value: `page:${pending.page + 1}` }] : []),
      ...(pending.page > 0 ? [{ label: "Previous page", value: `page:${pending.page - 1}` }] : []),
      { label: "Cancel power (keep credit)", value: "cancel" },
    ];
  };
  if (pending.step === "power") {
    const options = [
      ...(turn.next !== turn.team && turn.pool.length >= 4
        ? [{ label: "🚫 Veto — block one player for opponent's next pick", value: "power:veto" }] : []),
      ...(turn.own.length && turn.pool.length
        ? [{ label: "🔄 Switcheroo — swap your drafted player for a free player", value: "power:swap" }] : []),
    ];
    if (!options.length) return { content: "You have one wildcard, but no powers are currently legal. Keep drafting normally." };
    return selectPrompt(`🃏 **Captain's Wildcards — ${turn.team}**\nOne credit available. Choose a power, review your targets, then confirm. The normal pick timer continues.`, customId, options);
  }
  if (pending.step === "review") {
    const review = pending.power === "veto"
      ? `Block **${participantLabel(game, pending.target!)}** from the opponent's next pick.`
      : `Return **${participantLabel(game, pending.from!)}** and take **${participantLabel(game, pending.target!)}**.`;
    return selectPrompt(`🃏 **Review your ${pending.power}**\n${review}\nConfirm to spend your only credit; or cancel and keep it.`,
      customId, [{ label: "Confirm and spend credit", value: "confirm" }, { label: "Cancel", value: "cancel" }]);
  }
  const pool = pending.step === "from" ? turn.own : turn.pool;
  const prefix = pending.step === "veto" ? "veto" : pending.step === "from" ? "from" : "to";
  return selectPrompt(
    `🃏 **${pending.power === "veto" ? "Veto" : "Switcheroo"}**\n${pending.step === "from" ? "Choose one of your drafted non-captain teammates to return." :
      pending.step === "to" ? "Choose an undrafted replacement." : "Choose one undrafted player to block on your opponent's next pick."}`,
    customId, items(pool, prefix),
  );
}
export const captainsWildcards: ScenarioImplementation = {
  activateTrigger(game, policy) {
    if (policy.id !== "wildcards") return;
    if (!active()) {
      // Automatic draft startup activates before the session is constructed.
      if (!data<WildcardsState | null>(game, "wildcards", null))
        game.scenarios.setData("wildcards", initial() as unknown as ScenarioValue);
      return;
    }
    if (!data<WildcardsState | null>(game, "wildcards", null))
      game.scenarios.setData("wildcards", initial() as unknown as ScenarioValue);
  },
  async onDraftTurn(game, team) {
    const session = active();
    if (!session) return;
    const turn = session.wildcardTurn();
    if (turn.team !== team || !turn.owner) return;
    const state = current(game);
    if (!state.credits[team]) return;
    if (state.pending[turn.owner]?.turn === turn.index) return;
    const customId = openScenarioAction(game, turn.owner, "wildcard", "captain",
      new Date(Date.now() + 120_000));
    state.pending[turn.owner] = {
      id: customId.split(":")[2], turn: turn.index, step: "power", page: 0,
    };
    game.scenarios.setData("wildcards", state as unknown as ScenarioValue);
    void deliverPrivate(game, turn.owner, render(game,
      { id: state.pending[turn.owner].id, kind: "wildcard", ownerId: turn.owner,
        role: "captain", phase: "collecting", deadline: new Date(Date.now() + 120_000).toISOString(), allowUpdates: true },
      customId));
  },
  renderAction: (game, action, customId) => render(game, action, customId),
  validateAction(game, action, value) {
    const session = active();
    const turn = session?.wildcardTurn();
    const state = current(game);
    if (action.kind !== "wildcard" || !session || !turn?.team || turn.owner !== action.ownerId ||
        !state.credits[turn.team] || state.pending[action.ownerId]?.id !== action.id ||
        state.pending[action.ownerId].turn !== turn.index)
      throw new Error("That wildcard is no longer available on this draft turn.");
    const pending = state.pending[action.ownerId];
    const input = Array.isArray(value) && typeof value[0] === "string" ? value[0] : "";
    if (input === "cancel") return;
    if (input === "power:veto" && pending.step === "power" &&
        turn.next !== turn.team && turn.pool.length >= 4) return;
    if (input === "power:swap" && pending.step === "power" &&
        turn.own.length > 0 && turn.pool.length > 0) return;
    if (input.startsWith("page:") && ["veto", "from", "to"].includes(pending.step) &&
        /^page:\d+$/.test(input) && Number(input.slice(5)) <= Math.ceil(Math.max(turn.pool.length, turn.own.length) / 20)) return;
    if (input.startsWith("veto:") && pending.step === "veto" && turn.next !== turn.team &&
        turn.pool.length >= 4 && turn.pool.includes(input.slice(5))) return;
    if (input.startsWith("from:") && pending.step === "from" && turn.own.includes(input.slice(5))) return;
    if (input.startsWith("to:") && pending.step === "to" && turn.pool.includes(input.slice(3))) return;
    if (input === "confirm" && pending.step === "review" &&
        pending.target && turn.pool.includes(pending.target) &&
        (pending.power === "veto" ? turn.next !== turn.team && turn.pool.length >= 4
          : pending.power === "swap" && !!pending.from && turn.own.includes(pending.from)))
      return;
    throw new Error("Invalid or no longer eligible wildcard selection.");
  },
  async onActionSubmitted(game, action) {
    const input = choice(action);
    const state = current(game);
    const pending = state.pending[action.ownerId];
    if (!pending) throw new Error("Wildcard editor is no longer active.");
    if (input === "cancel") {
      pending.step = "power"; pending.power = undefined;
      pending.from = undefined; pending.target = undefined; pending.page = 0;
    } else if (input.startsWith("power:")) {
      pending.power = input === "power:veto" ? "veto" : "swap";
      pending.step = pending.power === "veto" ? "veto" : "from"; pending.page = 0;
    } else if (input.startsWith("page:")) {
      pending.page = Number(input.slice(5));
    } else if (input.startsWith("veto:")) {
      pending.target = input.slice(5); pending.step = "review";
    } else if (input.startsWith("from:")) {
      pending.from = input.slice(5); pending.step = "to"; pending.page = 0;
    } else if (input.startsWith("to:")) {
      pending.target = input.slice(3); pending.step = "review";
    } else if (input === "confirm") {
      const session = active()!;
      if (pending.power === "veto") await session.useWildcardVeto(action.ownerId, pending.target!);
      else await session.useWildcardSwap(action.ownerId, pending.from!, pending.target!);
      const team = session.wildcardTurn().team!;
      state.credits[team] = 0;
      state.history.push(`${team} ${pending.power} ${pending.from ?? ""} ${pending.target ?? ""}`.trim());
      delete state.pending[action.ownerId];
    }
    game.scenarios.setData("wildcards", state as unknown as ScenarioValue);
  },
  async onTeamsFinalized(game) {
    if (game.scenarios.selectedId === "captains-wildcards" && game.hasFinalizedPlayableTeams() &&
        game.scenarios.phase === "collecting") game.scenarios.complete();
  },
  organiserSummary(game) {
    const state = current(game);
    return `Wildcard credits: RED ${state.credits.RED}, BLUE ${state.credits.BLUE}.\n${state.history.join("\n") || "No powers used yet."}`;
  },
  publicResult(game) {
    const state = current(game);
    return { used: 2 - state.credits.RED - state.credits.BLUE,
      actions: state.history.map((h) => h.replace(/\b\d{8,22}\b/g, "[player]")) };
  },
  checkReadyToStart(game) {
    return game.hasFinalizedPlayableTeams() ? null : "Ordinary draft not confirmed yet.";
  },
};
