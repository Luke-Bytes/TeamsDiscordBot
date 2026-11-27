import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from "discord.js";
import type { ScenarioPrivatePrompt, ScenarioValue } from "../ScenarioTypes";
import { impostorMissions, type MissionId } from "./ImpostorMissions";
import type { ImpostorRuntime } from "./ImpostorRuntime";
import type { ImpostorStage } from "./ImpostorRound";

const stageCodes: Partial<Record<ImpostorStage, string>> = {
  preparation: "p", playing: "l", voting: "v", claims: "c",
};
const voiceNames = {
  "radio-silence": "Radio Silence", blackout: "Blackout", quarantine: "Quarantine",
  "communications-split": "Communications Split", "solitary-confinement": "Solitary Confinement", leaderless: "Leaderless",
};
const mission = (id: MissionId) => impostorMissions.find((m) => m.id === id)!;
const timestamp = (ms: number) => `<t:${Math.floor(ms / 1000)}:t>`;
const unavailable = (): never => { throw new Error("That scenario interaction is no longer available. Open your own current scenario prompt."); };

interface Editor {
  stage: ImpostorStage;
  revision: number;
  page: number;
  draft: string[];
}

/** Private editor state never enters public metadata or the game recovery snapshot. */
export class ImpostorPrivateControls {
  private readonly editors = new Map<string, Editor>();

  constructor(private readonly runtime: ImpostorRuntime, private readonly label: (id: string) => string) {}

  private editor(actor: string): Editor {
    const round = this.runtime.round;
    let editor = this.editors.get(actor);
    if (!editor || editor.stage !== round.stage) {
      let draft: string[] = [];
      if (round.stage === "preparation" || round.stage === "voting")
        draft = round.ballot(round.token, actor).submitted ?? [];
      else if (round.stage === "claims") draft = round.ownClaims(round.token, actor).claims;
      editor = { stage: round.stage, revision: 0, page: 0, draft };
      this.editors.set(actor, editor);
    }
    return editor;
  }

  private id(actor: string, editor: Editor, action: string): string {
    return `fwscr:${this.runtime.round.token}:${actor}:${stageCodes[editor.stage]}:${editor.revision.toString(36)}:${action}`;
  }

  private button(actor: string, editor: Editor, action: string, label: string, style = ButtonStyle.Secondary) {
    return new ButtonBuilder().setCustomId(this.id(actor, editor, action)).setLabel(label).setStyle(style);
  }

  open(actor: string): ScenarioPrivatePrompt | null {
    const round = this.runtime.round;
    try {
      if (round.stage === "preparation" || round.stage === "playing") {
        const card = round.ownCard(round.token, actor);
        const content = card.role === "innocent" ?
          "**Your role: Innocent**\nPlay normally and try to win! Keep an eye on suspicious behaviour. No sharing role cards or screensharing in team voice chat." :
          `**Your role: Impostor**\nHelp your team win, complete any four of these five missions and stay hidden.\n${card.hand.map((id) => `- **${mission(id).label}:** ${mission(id).objective}`).join("\n")}\nYour compulsory sabotage: **${voiceNames[card.slot.effect]}** around expected Phase ${card.slot.windowIndex + 3}. The bot activates it automatically if you don't.\nNo sharing role cards or screensharing in team voice chat.`;
        const editor = this.editor(actor);
        if (round.stage === "playing") {
          if (card.role === "innocent") return { content };
          const timing = this.runtime.ownTiming(round.token, actor);
          const now = timing.now;
          const options = [0, 15, 30, 60, 120]
            .filter((seconds) => timing.status === "pending" && now >= timing.opens && now + Math.max(1, seconds * 1000) <= timing.latestStart)
            .map((seconds) => ({ label: seconds === 0 ? "Activate now" : `In ${seconds}s`, value: String(seconds) }));
          if (options.length && now + 15_000 <= timing.latestStart)
            options.push({ label: "Random delay (15-90s, if it fits)", value: "random" });
          const rows = options.length ? [
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
              new StringSelectMenuBuilder().setCustomId(this.id(actor, editor, "delay")).setPlaceholder("Optional sabotage activation").addOptions(options))
          ] : [];
          return { content: `${content}\nApproximate window: ${timestamp(timing.opens)} to ${timestamp(timing.closes)}. Status: ${timing.status === "pending" ? "automatic unless activated" : "scheduled or closed"}.`,
            components: rows };
        }
        const ballot = this.renderBallot(actor, editor);
        const rows = [...(ballot.components ?? [])];
        if (card.role === "impostor" && !card.rerolled) {
          const reroll = new StringSelectMenuBuilder().setCustomId(this.id(actor, editor, "reroll"))
            .setPlaceholder("Optional: reroll one mission")
            .addOptions(card.hand.map((id) => ({ label: mission(id).label, value: id })));
          rows.unshift(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(reroll));
        }
        return { content: `${content}\n\n**First Impressions (optional)**\n${ballot.content}`, components: rows };
      }
      if (round.stage === "voting") return this.renderBallot(actor, this.editor(actor));
      if (round.stage === "claims") {
        const { hand } = round.ownClaims(round.token, actor);
        const editor = this.editor(actor);
        const select = new StringSelectMenuBuilder().setCustomId(this.id(actor, editor, "claimselect"))
          .setPlaceholder("Missions you completed").setMinValues(0).setMaxValues(hand.length)
          .addOptions(hand.map((id) => ({ label: mission(id).label, value: id, default: editor.draft.includes(id) })));
        return { content: `**Report your completed missions**\nSelect the ones you completed and submit. This is an honour claim, not bot-verified. No evidence upload needed. Deadline: ${timestamp(round.deadline!)}.\nSelected: ${editor.draft.length}`,
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
            new ActionRowBuilder<ButtonBuilder>().addComponents(this.button(actor, editor, "claimsubmit", "Submit claims", ButtonStyle.Success))] };
      }
      return null;
    } catch { return null; }
  }

  private renderBallot(actor: string, editor: Editor): ScenarioPrivatePrompt {
    const round = this.runtime.round;
    const ballot = round.ballot(round.token, actor);
    const pages = Math.max(1, Math.ceil(ballot.choices.length / 25));
    const candidates = ballot.choices.slice(editor.page * 25, editor.page * 25 + 25);
    const pageSet = new Set(candidates);
    const available = ballot.max - editor.draft.filter((id) => !pageSet.has(id)).length;
    const rows: NonNullable<ScenarioPrivatePrompt["components"]>[number][] = [];
    if (candidates.length && available > 0) {
      const menu = new StringSelectMenuBuilder().setCustomId(this.id(actor, editor, "select"))
        .setPlaceholder("Choose teammate suspects").setMinValues(0).setMaxValues(Math.min(available, candidates.length))
        .addOptions(candidates.map((id) => ({
          label: this.label(id).slice(0, 100) || id,
          value: id,
          default: editor.draft.includes(id),
        })));
      rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
    }
    const navigation = new ActionRowBuilder<ButtonBuilder>().addComponents(
      this.button(actor, editor, "prev", "Previous").setDisabled(editor.page === 0),
      this.button(actor, editor, "next", "Next").setDisabled(editor.page + 1 >= pages),
      this.button(actor, editor, "clear", "Clear"),
      this.button(actor, editor, "submit", "Submit / abstain", ButtonStyle.Success)
    );
    rows.push(navigation);
    const selection = (ids: readonly string[] | undefined) => ids === undefined ? "Not submitted" :
      ids.length ? ids.map(this.label).join(", ") : "Abstain";
    return { content: `Choose up to ${ballot.max} different teammates. You can change your vote until it closes. Page ${editor.page + 1}/${pages}.\nSelected: ${selection(editor.draft)}\nSaved: ${selection(ballot.submitted)}${round.deadline === undefined ? "" : `\nDeadline: ${timestamp(round.deadline)}`}`, components: rows };
  }

  apply(customId: string, actor: string, value: ScenarioValue): ScenarioPrivatePrompt {
    const round = this.runtime.round;
    const [prefix, token, owner, stage, revision, action, extra] = customId.split(":");
    if (prefix !== "fwscr" || token !== round.token || owner !== actor || extra !== undefined ||
        stage !== stageCodes[round.stage]) return unavailable();
    const editor = this.editor(actor);
    if (revision !== editor.revision.toString(36)) return unavailable();
    const values = () => {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return unavailable();
      return value as string[];
    };
    const button = () => { if (value !== true) return unavailable(); };
    if (action === "reroll" && round.stage === "preparation") {
      const selected = values();
      if (selected.length !== 1) return unavailable();
      round.reroll(token, actor, selected[0] as MissionId);
    } else if (action === "select" && (round.stage === "preparation" || round.stage === "voting")) {
      const ballot = round.ballot(token, actor);
      const page = ballot.choices.slice(editor.page * 25, editor.page * 25 + 25);
      const selected = values();
      const merged = [...editor.draft.filter((id) => !page.includes(id)), ...selected];
      if (selected.some((id) => !page.includes(id)) || new Set(merged).size !== merged.length || merged.length > ballot.max)
        return unavailable();
      editor.draft = merged;
    } else if (["prev", "next", "clear", "submit"].includes(action) &&
        (round.stage === "preparation" || round.stage === "voting")) {
      button();
      const ballot = round.ballot(token, actor);
      if (action === "prev") editor.page = Math.max(0, editor.page - 1);
      if (action === "next") editor.page = Math.min(Math.ceil(ballot.choices.length / 25) - 1, editor.page + 1);
      if (action === "clear") editor.draft = [];
      if (action === "submit") round.submitBallot(token, actor, editor.draft);
    } else if (action === "claimselect" && round.stage === "claims") {
      const { hand } = round.ownClaims(token, actor);
      const selected = values();
      if (selected.some((id) => !hand.includes(id as MissionId)) || new Set(selected).size !== selected.length) return unavailable();
      editor.draft = [...selected];
    } else if (action === "claimsubmit" && round.stage === "claims") {
      button();
      round.submitClaims(token, actor, editor.draft as MissionId[]);
    } else if (action === "delay" && round.stage === "playing") {
      const selected = values();
      if (selected.length !== 1 || !["0", "15", "30", "60", "120", "random"].includes(selected[0])) return unavailable();
      if (selected[0] === "random") this.runtime.randomDelay(token, actor);
      else this.runtime.delayActivation(token, actor, Number(selected[0]) * 1000);
    } else return unavailable();
    editor.revision++;
    const prompt = this.open(actor);
    if (!prompt) return unavailable();
    return prompt;
  }
}
