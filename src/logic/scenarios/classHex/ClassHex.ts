import { AnniClass } from "@prisma/client";
import { ActionRowBuilder, StringSelectMenuBuilder, UserSelectMenuBuilder } from "discord.js";
import type { GameInstance } from "../../../database/GameInstance";
import type { ScenarioAction, ScenarioImplementation, ScenarioPrivatePrompt, ScenarioValue } from "../ScenarioTypes";
import { DiscordUtil } from "../../../util/DiscordUtil";
import { choice, data, deliverAction, deliverPrivate, openScenarioAction, participantLabel } from "../ScenarioGameplay";
import { shuffle } from "../drafts/ScenarioDraftRules";
import { openScenarioButton } from "../ScenarioPromptDelivery";

type Side = "RED" | "BLUE";
interface Editor {
  team: Side;
  cursor: number;
  targets: string[];
  submitted: boolean;
}
type Editors = Record<string, Editor>;
const approved = (game: GameInstance) => data<string[]>(game, "hexPool", []);
const draw = (game: GameInstance) => data<string[]>(game, "hexDraw", []);
const editors = (game: GameInstance) => data<Editors>(game, "hexEditors", {});
const banned = (game: GameInstance): Set<string> => new Set([
  ...game.settings.organiserBannedClasses,
  ...game.settings.sharedCaptainBannedClasses,
  ...game.settings.nonSharedCaptainBannedClasses.RED,
  ...game.settings.nonSharedCaptainBannedClasses.BLUE,
]);
export function eligibleClasses(game: GameInstance): string[] {
  // Class-wide ban modifiers don't expose a reliable per-class derived ban list.
  // Refuse to guess compatibility for mandatory restrictions.
  if (game.settings.modifiers.some((m) =>
    ["All Movement Classes Banned", "All Combat Classes Banned"].includes(m.name)))
    return [];
  const blocked = banned(game);
  return [...new Set(approved(game))].filter((id) =>
    Object.values(AnniClass).includes(id as AnniClass) && !blocked.has(id));
}
/** Organiser explicitly approves a pool for this match. No default "weak" list is invented. */
export function configureHexPool(game: GameInstance, raw: string, reviewer: string): string[] {
  if (game.scenarios.selectedId !== "class-hex" || game.scenarios.phase !== "collecting" ||
      game.getGameStartStatus() !== "idle" || game.isFinished || draw(game).length)
    throw new Error("Cursed Classes pool can only be edited before classes are drawn.");
  const requested = raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (requested.length < 3 || requested.length > 20 ||
      new Set(requested).size !== requested.length ||
      requested.some((name) => !Object.values(AnniClass).includes(name as AnniClass)))
    throw new Error("Supply 3–20 different valid Annihilation class IDs, comma-separated.");
  game.scenarios.setData("hexPool", requested);
  game.scenarios.setData("hexPoolReviewer", reviewer);
  if (eligibleClasses(game).length < 3)
    throw new Error("Approved pool saved, but fewer than three classes are currently compatible with team bans/modifiers. Edit the pool or bans before activation.");
  return eligibleClasses(game);
}
function targetSide(team: Side): Side { return team === "RED" ? "BLUE" : "RED"; }
function enemyIds(game: GameInstance, editor: Editor): string[] {
  return game.getPlayersOfTeam(targetSide(editor.team)).map((p) => p.discordSnowflake);
}
function validEditor(game: GameInstance, editor: Editor): boolean {
  const ids = enemyIds(game, editor);
  return editor.targets.length === 3 && new Set(editor.targets).size === 3 &&
    editor.targets.every((id) => ids.includes(id));
}
function render(game: GameInstance, action: ScenarioAction, customId: string): ScenarioPrivatePrompt {
  const editor = editors(game)[action.ownerId];
  const classes = draw(game);
  if (!editor || classes.length !== 3) return { content: "Cursed Classes is not accepting assignments." };
  if (editor.submitted) return {
    content: "🔒 Your three class assignments have been submitted. Other captain's choices stay private until both have submitted.",
  };
  const rows = classes.map((c, i) =>
    `${i + 1}. **${c}** → ${editor.targets[i] ? participantLabel(game, editor.targets[i]) : "Unassigned"}`).join("\n");
  const summary = `🪄 **Cursed Classes - ${editor.team} captain**\nAssign each cursed class to a different **${targetSide(editor.team)}** player, captains included. Only mutual submission triggers the reveal.\n${rows}\n\nHonour rule; organiser-enforced for the whole game, not Minecraft-side class enforcement.`;
  if (editor.cursor >= 3) {
    return {
      content: `${summary}\n**Review your three choices, then submit.**`,
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder("Review, edit, submit")
          .addOptions(
            ...classes.map((c, i) => ({ label: `Edit ${c}`, value: `edit:${i}` })),
            { label: "Submit all three assignments", value: "submit" },
          ),
      )],
    };
  }
  return {
    content: `${summary}\n**Select one eligible enemy player for ${classes[editor.cursor]}** (step ${editor.cursor + 1}/3).`,
    components: [
      new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
        new UserSelectMenuBuilder().setCustomId(customId)
          .setPlaceholder(`Target for ${classes[editor.cursor]}`).setMinValues(1).setMaxValues(1),
      ),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder("Navigation")
          .addOptions(
            { label: "Review choices", value: "review" },
            ...classes.map((c, i) => ({ label: `Edit ${c}`, value: `edit:${i}` })),
          ),
      ),
    ],
  };
}
export const classHex: ScenarioImplementation = {
  validateTrigger(game, policy) {
    if (policy.id !== "hex") return null;
    if (!game.hasFinalizedPlayableTeams()) return "Cursed Classes requires finalised teams.";
    if (!approved(game).length)
      return "Organiser must approve a class pool using /game scenario pool before Cursed Classes can begin.";
    if (eligibleClasses(game).length < 3)
      return "Cursed Classes requires at least three distinct permitted, organiser-reviewed classes.";
    if (game.getPlayersOfTeam("RED").length < 3 || game.getPlayersOfTeam("BLUE").length < 3)
      return "Cursed Classes requires three targets on each team.";
    if (!game.getCaptainOfTeam("RED") || !game.getCaptainOfTeam("BLUE"))
      return "Both captains must be selected.";
    if (!game.startTime || game.startTime.getTime() - 180_000 <= Date.now())
      return "Not enough time remains for private class assignments. Reschedule or cancel the scenario.";
    return null;
  },
  async activateTrigger(game, policy, roster) {
    if (policy.id === "deadline") {
      if (game.scenarios.phase !== "completed")
        throw new Error("Cursed Classes captain deadline passed without both valid submissions. An organiser must review or cancel the scenario.");
      return;
    }
    if (policy.id !== "hex") return;
    game.scenarios.assertCapturedRoster("hex");
    const chosen = shuffle(eligibleClasses(game)).slice(0, 3);
    if (chosen.length !== 3 || new Set(chosen).size !== 3)
      throw new Error("Cannot draw three compatible unique classes.");
    game.scenarios.setData("hexDraw", chosen);
    const current: Editors = {};
    const deadline = new Date(game.startTime!.getTime() - 180_000);
    let delivered = 0;
    for (const team of ["RED", "BLUE"] as const) {
      const captain = game.getCaptainOfTeam(team)!;
      current[captain.discordSnowflake] = { team, cursor: 0, targets: [], submitted: false };
    }
    game.scenarios.setData("hexEditors", current as unknown as ScenarioValue);
    for (const captain of Object.keys(current)) {
      const customId = openScenarioAction(game, captain, "hex", "captain", deadline);
      if (await deliverAction(game, captain, customId)) delivered++;
    }
    await DiscordUtil.sendMessage("gameFeed", {
      content: `🪄 **Cursed Classes begins!** The shared class draw is **${chosen.join(" · ")}**. Each captain privately assigns all three to different opponents before <t:${Math.floor(deadline.getTime() / 1000)}:t>. ${delivered}/2 captains received DMs; open your own assignment below if yours failed.\n**Honour rule: organiser-enforced**, not automatically enforced in Shotbow. ${game.noElo || game.organiserNoElo ? "Unrated match selected." : "⚠️ Rated match selected; an unrated exhibition is recommended, but existing Elo policy is unchanged."}`,
      components: [openScenarioButton(game)],
    });
  },
  renderAction: (game, action, customId) => render(game, action, customId),
  isActionAvailable(game, action) {
    const editor = editors(game)[action.ownerId];
    return !!editor && !editor.submitted &&
      game.getCaptainOfTeam(editor.team)?.discordSnowflake === action.ownerId;
  },
  validateAction(game, action, value) {
    if (action.kind !== "hex" || draw(game).length !== 3) throw new Error("Class assignment expired.");
    const editor = editors(game)[action.ownerId];
    if (!editor || editor.submitted || game.getCaptainOfTeam(editor.team)?.discordSnowflake !== action.ownerId)
      throw new Error("Only the current team captain can submit these assignments.");
    const input = Array.isArray(value) && typeof value[0] === "string" ? value[0] : "";
    if (input === "review" || /^edit:[0-2]$/.test(input)) return;
    if (input === "submit" && validEditor(game, editor)) return;
    if (editor.cursor < 3 && enemyIds(game, editor).includes(input) &&
        editor.targets.every((id, i) => i === editor.cursor || id !== input)) return;
    throw new Error("Select three different registered opponents before submitting.");
  },
  isActionComplete: (game, action) => editors(game)[action.ownerId]?.submitted === true,
  async onActionSubmitted(game, action) {
    const input = choice(action);
    const state = editors(game);
    const editor = state[action.ownerId];
    if (input === "review") editor.cursor = 3;
    else if (input.startsWith("edit:")) editor.cursor = Number(input.slice(5));
    else if (input === "submit") editor.submitted = true;
    else {
      editor.targets[editor.cursor] = input;
      editor.cursor = Math.min(editor.cursor + 1, 3);
    }
    game.scenarios.setData("hexEditors", state as unknown as ScenarioValue);
    if (!Object.values(state).every((e) => e.submitted)) return;
    if (eligibleClasses(game).length < 3 || draw(game).some((c) => !eligibleClasses(game).includes(c)) ||
        !Object.values(state).every((e) => validEditor(game, e)))
      throw new Error("Roster or class bans changed; assignments must be reviewed.");
    const classes = draw(game);
    const reveal = Object.values(state).map((e) =>
      `**${e.team} curses ${targetSide(e.team)}:**\n${classes.map((c, i) =>
        `${participantLabel(game, e.targets[i])} → **${c}**`).join("\n")}`).join("\n");
    game.scenarios.complete();
    await DiscordUtil.sendMessage("gameFeed",
      `🪄 **Cursed Classes - all six curses revealed!**\n${reveal}\nThese are **organiser-enforced honour rules** for the entire match (including respawns when class selection is available). The bot cannot verify or enforce Minecraft classes. Report unavailable classes using /game scenario report-class before match start. Both captains are finished; organisers should verify class access, then use /game start.`);
    for (const e of Object.values(state)) for (const [i, target] of e.targets.entries()) {
      await deliverPrivate(game, target, {
        content: `🪄 You were assigned **${classes[i]}** for this Friendly War. Please use it whenever class selection is available, including after respawn. This is an organiser-enforced honour rule. If you lack access, run /game scenario report-class before the match.`,
      });
    }
  },
  organiserSummary(game) {
    const state = editors(game);
    const submitted = Object.values(state).filter((e) => e.submitted).length;
    return `Approved classes: ${approved(game).length}; compatible: ${eligibleClasses(game).length}. Draw: ${draw(game).join(", ") || "Not drawn"}. Captains submitted: ${submitted}/2. Honour rule; check every target's class access.`;
  },
  checkReadyToStart(game) {
    const classes = draw(game);
    const state = editors(game);
    if (classes.length !== 3 || !classes.every((c) => eligibleClasses(game).includes(c)))
      return "Cursed Classes draw is no longer valid under current class bans or modifiers.";
    if (Object.keys(state).length !== 2 || !Object.entries(state).every(([owner, e]) => e.submitted && validEditor(game, e) &&
        game.getCaptainOfTeam(e.team)?.discordSnowflake === owner))
      return "Class assignments are not complete and valid.";
    if (Object.values(data<Record<string, string>>(game, "access", {})).includes("unavailable"))
      return "An affected player cannot access their class; organiser review required.";
    return null;
  },
  publicSummary(game) {
    return `Cursed Classes is organiser-enforced for the whole match. An unrated exhibition is recommended; current selection: ${game.organiserNoElo ? "No Elo" : "normal rating policy"}. Organiser must approve a class pool before activation.`;
  },
  publicResult(game) {
    const state = editors(game);
    return { classes: draw(game), assignments: Object.values(state).flatMap((e) =>
      e.targets.map((id, i) => ({ player: id, team: targetSide(e.team), class: draw(game)[i] }))) };
  },
};
export function reportUnavailableClass(game: GameInstance, user: string): string {
  if (game.scenarios.selectedId !== "class-hex" || game.scenarios.phase !== "completed" ||
      game.getGameStartStatus() !== "idle") throw new Error("Cursed Classes is not accepting pre-match class reports.");
  const assignment = Object.values(editors(game)).flatMap((e) => e.targets).includes(user);
  if (!assignment) throw new Error("You are not one of the six assigned players.");
  const access = data<Record<string, string>>(game, "access", {});
  access[user] = "unavailable";
  game.scenarios.setData("access", access);
  game.scenarios.needsReview("A targeted player reported their assigned class unavailable; review and redo the class draw or cancel the scenario before starting.");
  return "Class access issue recorded. The match is blocked until an organiser reviews and resolves the assignments. No automated punishment is applied.";
}
