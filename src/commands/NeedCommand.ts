import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  GuildMember,
  Message,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { randomUUID } from "node:crypto";
import { Team } from "@prisma/client";
import { Command } from "./CommandInterface";
import TeamCommand from "./TeamCommand";
import { CurrentGameManager } from "../logic/CurrentGameManager";
import { PermissionsUtil } from "../util/PermissionsUtil";
import { Channels } from "../Channels";
import { ConfigManager } from "../ConfigManager";
import { escapeText } from "../util/Utils";
import CaptainPlanDMManager from "../logic/CaptainPlanDMManager";

type Request = {
  id: string;
  token: string;
  team: Team;
  guild: string;
  messages: Message[];
  open: boolean;
};
export default class NeedCommand implements Command {
  static instance?: NeedCommand;
  async expireAll() {
    await Promise.all(
      this.requests
        .filter((r) => r.open)
        .map((r) => this.close(r, "Request expired."))
    );
    this.requests = [];
  }
  name = "need";
  description = "Recruit one replacement player";
  buttonIds = ["need:"];
  private requests: Request[] = [];
  data = new SlashCommandBuilder()
    .setName(this.name)
    .setDescription(this.description)
    .addStringOption((o) =>
      o
        .setName("team")
        .setDescription("Team needing a player")
        .addChoices(
          { name: "Blue", value: "BLUE" },
          { name: "Red", value: "RED" }
        )
    )
    .addBooleanOption((o) =>
      o.setName("ping").setDescription("Notify the game notification role")
    );
  constructor(
    private teams: TeamCommand,
    private plans: CaptainPlanDMManager
  ) {
    NeedCommand.instance = this;
  }
  private valid() {
    const g = CurrentGameManager.getCurrentGame();
    return (
      g.announced &&
      !g.isFinished &&
      !g.isRestarting &&
      g.getGameStartStatus() !== "starting" &&
      !!g.teamsDecidedBy &&
      !this.teams.isTeamPickingSessionActive()
    );
  }
  private authorised(member: GuildMember, team: Team) {
    return (
      PermissionsUtil.hasRole(member, "organiserRole") ||
      CurrentGameManager.getCurrentGame().getCaptainOfTeam(team)
        ?.discordSnowflake === member.id
    );
  }
  private async close(r: Request, text: string) {
    r.open = false;
    await Promise.all(
      r.messages.map((m) =>
        m
          .edit({
            content: text,
            components: [],
            allowedMentions: { parse: [] },
          })
          .catch((e) => console.warn("Need message update failed", e))
      )
    );
  }
  async execute(i: ChatInputCommandInteraction) {
    if (!i.inGuild()) return;
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    await this.teams.runRosterOperation(async () => {
      const g = CurrentGameManager.getCurrentGame();
      const player = g
        .getPlayers()
        .find((p) => p.discordSnowflake === i.user.id);
      const team = (i.options.getString("team") ??
        (player ? g.getPlayersTeam(player) : null)) as Team | null;
      if (!team || team === ("UNDECIDED" as string)) {
        await i.editReply("Choose blue or red.");
        return;
      }
      if (!this.authorised(i.member as GuildMember, team)) {
        await i.editReply(
          "Only organisers and this team's captain can request a player."
        );
        return;
      }
      if (!this.valid()) {
        await i.editReply(
          "Requests require completed teams and an active game that is not starting or restarting."
        );
        return;
      }
      const existing = this.requests.find(
        (r) => r.open && r.token === g.getLifecycleToken() && r.team === team
      );
      if (existing) {
        await i.editReply(
          `A request is already open: ${existing.messages[0]?.url}`
        );
        return;
      }
      const r: Request = {
        id: randomUUID(),
        token: g.getLifecycleToken(),
        team,
        guild: i.guildId!,
        messages: [],
        open: true,
      };
      this.requests.push(r);
      const components = [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`need:${r.id}:join`)
            .setLabel(`Join ${team}`)
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`need:${r.id}:cancel`)
            .setLabel("Cancel request")
            .setStyle(ButtonStyle.Secondary)
        ),
      ];
      try {
        for (const channel of [Channels.registration, Channels.gameFeed]) {
          const role =
            channel === Channels.registration && i.options.getBoolean("ping")
              ? ConfigManager.getConfig().roles.gameNotify
              : undefined;
          r.messages.push(
            await channel.send({
              content: `${role ? `<@&${role}> ` : ""}${team} needs 1 player! Use /register for this game first, then click Join.`,
              components,
              allowedMentions: { roles: role ? [role] : [], parse: [] },
            })
          );
        }
        await i.editReply(`Request posted: ${r.messages[0].url}`);
      } catch (e) {
        await this.close(r, "Request unavailable.");
        console.warn("Need publication failed", e);
        await i.editReply("Could not publish the request. Please retry.");
      }
    });
  }
  async handleButtonPress(i: ButtonInteraction) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    await this.teams.runRosterOperation(async () => {
      const [, id, action] = i.customId.split(":");
      const r = this.requests.find((r) => r.id === id);
      const g = CurrentGameManager.getCurrentGame();
      if (
        !r ||
        !r.open ||
        r.guild !== i.guildId ||
        r.token !== g.getLifecycleToken() ||
        !this.valid() ||
        !r.messages.some((m) => m.id === i.message.id)
      ) {
        await i.editReply("This request has expired.");
        return;
      }
      if (action === "cancel") {
        if (!this.authorised(i.member as GuildMember, r.team)) {
          await i.editReply(
            "Only organisers and this team's captain can cancel."
          );
          return;
        }
        await this.close(r, `${r.team} request cancelled.`);
        await i.editReply("Request cancelled.");
        return;
      }
      if (action !== "join") return;
      const p = g.teams.UNDECIDED.find((p) => p.discordSnowflake === i.user.id);
      if (!p) {
        await i.editReply(
          "You must /register for this game first and must not already be on a team."
        );
        return;
      }
      if (
        !(await g.movePlayerBetweenTeams(
          p.discordSnowflake,
          "UNDECIDED",
          r.team,
          i.guild
        ))
      ) {
        await i.editReply("Unable to add you. Please retry.");
        return;
      }
      await this.close(
        r,
        `${r.team} request filled by ${escapeText(p.ignUsed ?? i.user.username)}.`
      );
      await i.editReply(`You joined ${r.team}.`);
      try {
        const captain = g.getCaptainOfTeam(r.team);
        await (
          r.team === "RED" ? Channels.redTeamChat : Channels.blueTeamChat
        ).send({
          content: `${captain ? `<@${captain.discordSnowflake}>, ` : ""}<@${p.discordSnowflake}> (${escapeText(p.ignUsed ?? i.user.username)}) has joined your team.`,
          allowedMentions: {
            parse: [],
            users: [
              p.discordSnowflake,
              ...(captain ? [captain.discordSnowflake] : []),
            ],
          },
        });
        if (captain)
          await this.plans.handleRosterUpdate({
            captainId: captain.discordSnowflake,
            team: r.team,
            members: g.teams[r.team].map((p) => ({
              id: p.discordSnowflake,
              ign: p.ignUsed ?? "Unknown",
            })),
            newJoiners: [
              { id: p.discordSnowflake, ign: p.ignUsed ?? "Unknown" },
            ],
            client: i.client,
          });
      } catch (e) {
        console.warn("Need follow-up failed after assignment", e);
      }
    });
  }
}
