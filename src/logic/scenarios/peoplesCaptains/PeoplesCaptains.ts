import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { GameInstance } from "../../../database/GameInstance";
import type { ScenarioImplementation, ScenarioValue } from "../ScenarioTypes";
import { DiscordUtil } from "../../../util/DiscordUtil";
import TeamCommand from "../../../commands/TeamCommand";
import { choice, data, deliverPrivate, openScenarioAction, participantLabel, selectPrompt } from "../ScenarioGameplay";

export type Ballots = Record<string, string[]>;
type CandidateStatus = Record<string, boolean>;
type Votes = Record<string, string>;
const candidates = (game: GameInstance) => data<CandidateStatus>(game, "candidates", {});
const ballots = (game: GameInstance) => data<Ballots>(game, "ballots", {});
const votes = (game: GameInstance) => data<Votes>(game, "votes", {});

/** Every voter sees three distinct names and no self-vote. Exposure counts differ by at most one when feasible. */
export function createBalancedBallots(voters: readonly string[], candidateIds: readonly string[]): Ballots {
  const slate = [...new Set(candidateIds)].sort();
  const eligible = [...new Set(voters)].sort();
  if (slate.length < 4 || eligible.some((id) => slate.filter((candidate) => candidate !== id).length < 3))
    throw new Error("At least four willing candidates are required for personalised ballots.");
  const exposures: Record<string, number> = Object.fromEntries(slate.map((id) => [id, 0]));
  const result: Ballots = {};
  for (const [i, id] of eligible.entries()) {
    const options = slate.filter((candidate) => candidate !== id);
    const chosen: string[] = [];
    for (let pick = 0; pick < 3; pick++) {
      options.sort((a, b) => exposures[a] - exposures[b] ||
        ((slate.indexOf(a) - i + slate.length) % slate.length) -
        ((slate.indexOf(b) - i + slate.length) % slate.length));
      const selected = options.shift()!;
      chosen.push(selected);
      exposures[selected]++;
    }
    result[id] = chosen;
  }
  return result;
}
export function tallyElection(frozen: Ballots, ballotsCast: Votes, candidateIds: readonly string[]) {
  const slate = [...candidateIds].sort();
  const exposure = Object.fromEntries(slate.map((id) => [id, 0]));
  const counted = Object.fromEntries(slate.map((id) => [id, 0]));
  for (const options of Object.values(frozen)) for (const candidate of options)
    if (candidate in exposure) exposure[candidate]++;
  let turnout = 0;
  for (const [voter, selected] of Object.entries(ballotsCast)) {
    if (frozen[voter]?.includes(selected) && selected in counted) {
      counted[selected]++;
      turnout++;
    }
  }
  const ranked = slate.sort((a, b) =>
    (counted[b] + 1) / (exposure[b] + 2) - (counted[a] + 1) / (exposure[a] + 2) ||
    counted[b] - counted[a] || a.localeCompare(b));
  return { exposure, counted, turnout, ranked };
}
function renderCandidate(game: GameInstance, user: string, customId: string) {
  return selectPrompt(
    `🗳️ **People's Captains — volunteer**\nYour status: **${candidates(game)[user] ? "Willing to captain" : "Not standing"}**. You can change this until the candidate deadline. Ballots are private and no one can vote for themselves.`,
    customId, [{ label: "I volunteer as captain", value: "candidate:yes" }, { label: "Withdraw / do not stand", value: "candidate:no" }],
  );
}
function renderBallot(game: GameInstance, user: string, customId: string) {
  const options = ballots(game)[user] ?? [];
  return selectPrompt(
    `🗳️ **People's Captains — your ballot**\nSelect one candidate. You can update your vote before polls close; only your last choice counts. Your current vote: **${votes(game)[user] ? participantLabel(game, votes(game)[user]) : "Not yet voted"}**.\nCandidates differ between voters to share exposure fairly.`,
    customId, options.map((id) => ({ label: participantLabel(game, id).slice(0, 100), value: `vote:${id}` })),
  );
}
export const peoplesCaptains: ScenarioImplementation = {
  registrationPrompt: (game, id, customId) => renderCandidate(game, id, customId),
  renderAction: (game, action, customId) => action.kind === "ballot"
    ? renderBallot(game, action.ownerId, customId) : renderCandidate(game, action.ownerId, customId),
  validateAction(game, action, value) {
    const input = Array.isArray(value) && typeof value[0] === "string" ? value[0] : "";
    if (action.kind === "candidate" && ["candidate:yes", "candidate:no"].includes(input)) return;
    if (action.kind === "ballot" && input.startsWith("vote:") &&
        ballots(game)[action.ownerId]?.includes(input.slice(5))) return;
    throw new Error("That candidate is unavailable on your ballot.");
  },
  onActionSubmitted(game, action) {
    const input = choice(action);
    if (action.kind === "candidate") {
      const status = candidates(game);
      status[action.ownerId] = input === "candidate:yes";
      game.scenarios.setData("candidates", status);
    } else if (action.kind === "ballot") {
      const updated = votes(game);
      updated[action.ownerId] = input.slice(5);
      game.scenarios.setData("votes", updated);
    }
  },
  onRegistrationChanged(game, id, joined) {
    if (joined) return;
    const status = candidates(game);
    delete status[id];
    game.scenarios.setData("candidates", status);
    const current = votes(game);
    delete current[id];
    game.scenarios.setData("votes", current);
  },
  async activateTrigger(game, policy, roster) {
    game.scenarios.assertCapturedRoster(policy.id);
    if (policy.id === "election") {
      if (game.getCaptainOfTeam("RED") || game.getCaptainOfTeam("BLUE"))
        throw new Error("Remove existing captains before running a community election.");
      const slate = roster.filter((id) => candidates(game)[id]);
      const frozen = createBalancedBallots(roster, slate);
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
        if (await deliverPrivate(game, id, renderBallot(game, id, customId))) delivered++;
        if (game.getLifecycleToken() !== token) throw new Error("Match changed while distributing ballots.");
      }
      await DiscordUtil.sendMessage("gameFeed", `🗳️ **People's Captains election open!** ${slate.length} volunteers, ${roster.length} ballots, ${delivered} private deliveries. Vote via your DM or /game scenario open before <t:${Math.floor(close.getTime() / 1000)}:t>. No self-votes.`);
    } else if (policy.id === "close") {
      if (!data<string[]>(game, "slate", []).length) throw new Error("Election was not opened.");
      const slate = data<string[]>(game, "slate", []);
      if (slate.some((id) => !roster.includes(id))) throw new Error("Candidate roster changed during voting.");
      const result = tallyElection(ballots(game), votes(game), slate);
      const minimum = Math.max(3, Math.ceil(roster.length * 0.2));
      if (result.turnout < minimum) throw new Error(`Only ${result.turnout} ballot(s); at least ${minimum} required. Use organiser fallback.`);
      const [red, blue] = result.ranked;
      game.scenarios.markReady({
        captainRed: red, captainBlue: blue, turnout: result.turnout,
        exposures: result.exposure, counts: result.counted,
      });
      await DiscordUtil.sendMessage("gameFeed", {
        content: `🗳️ **Election finished** — ${result.turnout}/${roster.length} votes. Proposed RED captain: **${participantLabel(game, red)}**, BLUE: **${participantLabel(game, blue)}**. Organiser confirmation required.\nExposure-adjusted score: (votes + 1) / (ballot appearances + 2). Ties: votes then stable player ID.`,
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`fwscapprove:${game.getLifecycleToken()}`)
            .setLabel("Confirm Elected Captains").setStyle(ButtonStyle.Success),
        )],
      });
    }
  },
  async approveResult(game, guild) {
    const red = data<string>(game, "captainRed", "");
    const blue = data<string>(game, "captainBlue", "");
    if (!red || !blue) throw new Error("No complete election result.");
    await TeamCommand.instance?.confirmScenarioCaptains(guild, red, blue);
    if (game.scenarios.phase !== "completed") throw new Error("Captain approval was not confirmed.");
    await DiscordUtil.sendMessage("gameFeed",
      `🗳️ **Elected captains confirmed!** 🔴 ${participantLabel(game, red)} · 🔵 ${participantLabel(game, blue)}. Normal snake drafting is now available.`);
  },
  organiserSummary(game) {
    const state = game.scenarios.snapshot();
    return `Volunteers: ${Object.values(candidates(game)).filter(Boolean).length}. Ballots: ${Object.keys(ballots(game)).length}. Votes: ${Object.keys(votes(game)).length}. Phase: ${state?.phase ?? "none"}.`;
  },
  publicResult(game) {
    return { turnout: data<number>(game, "turnout", 0),
      redCaptain: data<string>(game, "captainRed", ""), blueCaptain: data<string>(game, "captainBlue", "") };
  },
  checkReadyToStart(game) {
    return game.getCaptainOfTeam("RED") && game.getCaptainOfTeam("BLUE") ? null : "Election captains not confirmed.";
  },
};
