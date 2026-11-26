import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { GameInstance } from "../../../database/GameInstance";
import { createHash } from "node:crypto";
import type { ScenarioImplementation } from "../ScenarioTypes";
import { DiscordUtil } from "../../../util/DiscordUtil";
import TeamCommand from "../../../commands/TeamCommand";
import { openScenarioButton } from "../ScenarioPromptDelivery";
import { CurrentGameManager } from "../../CurrentGameManager";
import { choice, data, deliverAction, openScenarioAction, participantLabel, selectPrompt } from "../ScenarioGameplay";

export type Ballots = Record<string, string[]>;
type Votes = Record<string, string>;
const ballots = (game: GameInstance) => data<Ballots>(game, "ballots", {});
const votes = (game: GameInstance) => data<Votes>(game, "votes", {});

function seededOrder(ids: readonly string[], seed: string): string[] {
  const key = (id: string) => createHash("sha256").update(seed + ":" + id).digest("hex");
  return [...new Set(ids)].sort((a, b) => key(a).localeCompare(key(b)) || a.localeCompare(b));
}

/** A shuffled circular roster with three distinct nonzero offsets gives everyone exactly three appearances. */
export function createBalancedBallots(voters: readonly string[], candidateIds: readonly string[] = voters, seed = ""): Ballots {
  const roster = seededOrder(voters, seed + ":roster");
  const slate = [...new Set(candidateIds)].sort();
  if (roster.length < 4 || JSON.stringify([...roster].sort()) !== JSON.stringify(slate))
    throw new Error("At least four registered players are required; every voter must be a candidate.");
  const offsets = seededOrder(Array.from({ length: roster.length - 1 }, (_, i) => String(i + 1)), seed + ":offsets")
    .slice(0, 3).map(Number);
  return Object.fromEntries(roster.map((id, i) => [
    id, seededOrder(offsets.map((offset) => roster[(i + offset) % roster.length]), seed + ":" + id),
  ]));
}

export function tallyElection(frozen: Ballots, ballotsCast: Votes, candidateIds: readonly string[], seed = "") {
  const slate = [...new Set(candidateIds)];
  const exposure = Object.fromEntries(slate.map((id) => [id, 0]));
  const counted = Object.fromEntries(slate.map((id) => [id, 0]));
  for (const [voter, options] of Object.entries(frozen)) {
    for (const candidate of new Set(options))
      if (candidate !== voter && Object.prototype.hasOwnProperty.call(exposure, candidate)) exposure[candidate]++;
  }
  let turnout = 0;
  for (const [voter, selected] of Object.entries(ballotsCast)) {
    if (selected !== voter && Object.prototype.hasOwnProperty.call(frozen, voter) && frozen[voter].includes(selected) &&
        Object.prototype.hasOwnProperty.call(counted, selected)) {
      counted[selected]++;
      turnout++;
    }
  }
  const tieOrder = seededOrder(slate, seed + ":ties");
  const ranked = slate.sort((a, b) =>
    (counted[b] + 1) / (exposure[b] + 2) - (counted[a] + 1) / (exposure[a] + 2) ||
    counted[b] - counted[a] || tieOrder.indexOf(a) - tieOrder.indexOf(b));
  return { exposure, counted, turnout, ranked };
}
export function minimumElectionTurnout(rosterSize: number): number {
  return Math.max(3, Math.ceil(rosterSize * 0.2));
}
function renderBallot(game: GameInstance, user: string, customId: string) {
  const options = ballots(game)[user] ?? [];
  return selectPrompt(
    `🗳️ **People's Captains - your ballot**\nSelect one candidate. You can update your vote before polls close; only your last choice counts. Your current vote: **${votes(game)[user] ? participantLabel(game, votes(game)[user]) : "Not yet voted"}**.\nCandidates differ between voters to share exposure fairly.`,
    customId, options.map((id) => ({ label: participantLabel(game, id).slice(0, 100), value: `vote:${id}` })),
  );
}
export const peoplesCaptains: ScenarioImplementation = {
  validateTrigger(game, policy) {
    if (policy.id === "election") {
      if (game.getCaptainOfTeam("RED") || game.getCaptainOfTeam("BLUE")) return "Remove existing captains before opening voting.";
      if (game.getPlayers().length < 4) return "At least four registered players are needed to open voting.";
      if (!game.startTime || game.startTime.getTime() - 20 * 60_000 <= Date.now())
        return "Voting window has ended. Reschedule or use organiser fallback.";
    }
    if (policy.id === "close") {
      const slate = data<string[]>(game, "slate", []);
      if (!slate.length) return "Voting must open before it can close.";
      if (game.startTime && game.startTime.getTime() - 20 * 60_000 > Date.now())
        return "Voting is still open. Players can change their vote until the deadline.";
    }
    return null;
  },
  renderAction: (game, action, customId) => renderBallot(game, action.ownerId, customId),
  isActionAvailable(game, action) {
    return action.kind === "ballot" && !!ballots(game)[action.ownerId]?.length;
  },
  validateAction(game, action, value) {
    const input = Array.isArray(value) && value.length === 1 && typeof value[0] === "string" ? value[0] : "";
    const selected = input.slice(5);
    if (action.kind === "ballot" && input.startsWith("vote:") && selected !== action.ownerId &&
        ballots(game)[action.ownerId]?.includes(selected)) return;
    throw new Error("That candidate is unavailable on your ballot.");
  },
  onActionSubmitted(game, action) {
    if (action.kind !== "ballot") throw new Error("Only ballots are accepted.");
    const updated = votes(game);
    updated[action.ownerId] = choice(action).slice(5);
    game.scenarios.setData("votes", updated);
  },
  async activateTrigger(game, policy, roster) {
    game.scenarios.assertCapturedRoster(policy.id);
    if (policy.id === "election") {
      if (game.getCaptainOfTeam("RED") || game.getCaptainOfTeam("BLUE"))
        throw new Error("Remove existing captains before running a community election.");
      const slate = [...roster];
      const frozen = createBalancedBallots(roster, slate, game.getLifecycleToken());
      const close = new Date((game.startTime?.getTime() ?? 0) - 20 * 60_000);
      if (close.getTime() <= Date.now()) throw new Error("Election close time already passed; reschedule the game or use organiser fallback.");
      game.scenarios.setData("slate", slate);
      game.scenarios.setData("ballots", frozen);
      game.scenarios.setData("votes", {});
      const token = game.getLifecycleToken();
      let delivered = 0;
      // DM failures are not a barrier: /game scenario open works for every ballot owner.
      for (const id of roster) {
        const customId = openScenarioAction(game, id, "ballot", "participant", close);
        if (await deliverAction(game, id, customId)) delivered++;
        if (game.getLifecycleToken() !== token) throw new Error("Match changed while distributing ballots.");
      }
      await DiscordUtil.sendMessage("gameFeed", {
        content: `🗳️ **People's Captains election open!** ${slate.length} candidates - everyone registered can be elected! ${delivered}/${roster.length} ballots delivered privately. Vote via your DM or open your own ballot below before <t:${Math.floor(close.getTime() / 1000)}:t>. No self-votes.`,
        components: [openScenarioButton(game)],
      });
    } else if (policy.id === "close") {
      if (!data<string[]>(game, "slate", []).length) throw new Error("Election was not opened.");
      const slate = data<string[]>(game, "slate", []);
      if (slate.length !== roster.length || slate.some((id) => !roster.includes(id))) throw new Error("Candidate roster changed during voting.");
      const result = tallyElection(ballots(game), votes(game), slate, game.getLifecycleToken());
      const minimum = minimumElectionTurnout(roster.length);
      if (result.turnout < minimum) throw new Error(`Only ${result.turnout} ballot(s); at least ${minimum} required. Use organiser fallback.`);
      const ranked = result.ranked.filter((id) => result.counted[id] > 0);
      if (ranked.length < 2) throw new Error("At least two candidates must receive votes. Use organiser fallback.");
      const [red, blue] = seededOrder(ranked.slice(0, 2), game.getLifecycleToken() + ":colours");
      game.scenarios.markReady({
        captainRed: red, captainBlue: blue, turnout: result.turnout,
        exposures: result.exposure, counts: result.counted, ranked, replacements: [],
      });
      await DiscordUtil.sendMessage("gameFeed", {
        content: `🗳️ **Election finished** - ${result.turnout}/${roster.length} votes. Proposed RED captain: **${participantLabel(game, red)}**, BLUE: **${participantLabel(game, blue)}**. Organiser confirmation required.\nEveryone appeared on three ballots. Most votes win; ties and team colours are decided by a fixed draw. Individual votes stay private.`,
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`fwscapprove:${game.getLifecycleToken()}:${game.scenarios.controlRevision}`)
            .setLabel("Confirm Elected Captains").setStyle(ButtonStyle.Success),
        )],
      });
    }
  },
  async approveResult(game, guild) {
    const red = data<string>(game, "captainRed", "");
    const blue = data<string>(game, "captainBlue", "");
    if (!red || !blue) throw new Error("No complete election result.");
    await TeamCommand.instance?.confirmScenarioCaptains(guild, red, blue, game.scenarios.controlRevision);
    if (game.scenarios.phase !== "completed") throw new Error("Captain approval was not confirmed.");
    await DiscordUtil.sendMessage("gameFeed",
      `🗳️ **Elected captains confirmed!** 🔴 ${participantLabel(game, red)} · 🔵 ${participantLabel(game, blue)}. Normal snake drafting is now available.`);
    // Preserve the normal registration window; catch up only once its automatic draft time has passed.
    if (game.startTime && game.startTime.getTime() - 15 * 60_000 <= Date.now())
      await CurrentGameManager.attemptAutoStartDraft(guild);
  },
  organiserSummary(game) {
    const state = game.scenarios.snapshot();
    return `Candidates: ${data<string[]>(game, "slate", []).length || game.getPlayers().length}. Ballots: ${Object.keys(ballots(game)).length}. Votes: ${Object.keys(votes(game)).length}. Phase: ${state?.phase ?? "none"}.`;
  },
  publicResult(game) {
    return { turnout: data<number>(game, "turnout", 0),
      redCaptain: data<string>(game, "captainRed", ""), blueCaptain: data<string>(game, "captainBlue", ""), replacements: data<string[]>(game, "replacements", []) };
  },
  checkReadyToStart(game) {
    return game.getCaptainOfTeam("RED")?.discordSnowflake === data<string>(game, "captainRed", "") &&
      game.getCaptainOfTeam("BLUE")?.discordSnowflake === data<string>(game, "captainBlue", "")
      ? null : "The elected captains have changed. Ask an organiser to review or cancel the election before starting.";
  },
};
