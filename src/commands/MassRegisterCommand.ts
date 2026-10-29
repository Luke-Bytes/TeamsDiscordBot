import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  GuildMember,
  MessageFlags,
} from "discord.js";
import { Command } from "./CommandInterface.js";
import { PermissionsUtil } from "../util/PermissionsUtil.js";
import { GameInstance } from "../database/GameInstance";
import { prismaClient } from "../database/prismaClient";
import { escapeText } from "../util/Utils";
import { MojangAPI } from "../api/MojangAPI";
import { fetchGuildMember, isUnknownInteraction } from "../util/DiscordFailures";
import TeamCommand from "./TeamCommand";
import { DraftTeamPickingSession } from "../logic/teams/DraftTeamPickingSession";

export function parseMassRegisterList(value: string): {
  names: string[];
  invalid: string[];
  duplicates: string[];
} {
  const names: string[] = [];
  const invalid: string[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();
  const cleaned = value.replace(/^\s*\/?massregister\s+(?:playerlist\s*:\s*)?/i, "");
  for (const token of cleaned.split(/\s+/).filter(Boolean)) {
    if (!MojangAPI.validateUsername(token)) {
      invalid.push(token);
    } else if (seen.has(token.toLowerCase())) {
      duplicates.push(token);
    } else {
      seen.add(token.toLowerCase());
      names.push(token);
    }
  }
  return { names, invalid, duplicates };
}

export default class MassRegisterCommand implements Command {
  public data: SlashCommandBuilder;
  public name = "massregister";
  public description = "Register a list of players (organisers only).";
  public buttonIds: string[] = [];

  constructor() {
    this.data = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description)
      .addStringOption((option) =>
        option
          .setName("playerlist")
          .setDescription("Minecraft names separated by spaces, tabs or newlines.")
          .setRequired(true)
      ) as SlashCommandBuilder;
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const member = interaction.member as GuildMember;
    if (!member || !PermissionsUtil.hasRole(member, "organiserRole")) {
      await interaction.reply({
        content: "You do not have permission to use this command.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply();

    const game = GameInstance.getInstance();
    if (!game.announced || game.getGameStartStatus() !== "idle" || game.isFinished) {
      await interaction.editReply("There is no open game registration.");
      return;
    }
    if (!interaction.guild) {
      await interaction.editReply("This command must be used in a server.");
      return;
    }

    const { names, invalid, duplicates } = parseMassRegisterList(
      interaction.options.getString("playerlist", true)
    );
    const registered: string[] = [];
    const warnings: string[] = [];
    const skipped: string[] = [
      ...invalid.map((name) => `${name} (invalid username)`),
      ...duplicates.map((name) => `${name} (duplicate input)`),
    ];
    for (const ign of names) {
      try {
        const player = await prismaClient.player.findFirst({
          where: { latestIGN: ign },
        });
        if (!player) {
          skipped.push(`${ign} (no known player profile)`);
          continue;
        }
        if (game.getPlayers().some((p) => p.discordSnowflake === player.discordSnowflake)) {
          skipped.push(`${ign} (already registered)`);
          continue;
        }
        const guildMember = await fetchGuildMember(interaction.guild, player.discordSnowflake);
        if (!guildMember) {
          skipped.push(`${ign} (left server)`);
          continue;
        }
        if (game.getGameStartStatus() !== "idle" || !game.announced) {
          skipped.push(`${ign} (registration closed)`);
          continue;
        }
        let registeredWithDraftWarning = false;
        const add = async () => {
          const added = await game.addPlayerByDiscordId(player.discordSnowflake, ign);
          const session = TeamCommand.instance?.teamPickingSession;
          if (!added.error && session instanceof DraftTeamPickingSession &&
              !session.latePickingStarted) {
            try {
              await session.registerLateSignup(added.playerInstance);
            } catch (error) {
              console.error(`Massregister draft sync failed member=${player.discordSnowflake}`, error);
              registeredWithDraftWarning = true;
            }
          }
          return added;
        };
        const result = TeamCommand.instance
          ? await TeamCommand.instance.runRosterOperation(add)
          : await add();
        if (result.error) skipped.push(`${ign} (${result.error})`);
        else {
          registered.push(ign);
          if (registeredWithDraftWarning) warnings.push(`${ign} (draft display needs organiser review)`);
        }
      } catch (error) {
        console.error(`Massregister failed for ${ign}: `, error);
        skipped.push(`${ign} (lookup/registration temporarily failed)`);
      }
    }

    const lines = [
      registered.length ? `Registered (${registered.length}): ${registered.map(escapeText).join(", ")}` : "Registered: none",
      skipped.length ? `Skipped (${skipped.length}): ${skipped.map(escapeText).join(", ")}` : "Skipped: none",
      ...(warnings.length ? [`Warnings: ${warnings.map(escapeText).join(", ")}`] : []),
    ];
    const content = lines.join("\n");
    try {
      await interaction.editReply(
        content.length <= 1900 ? content : `${content.slice(0, 1820)}…\nResults truncated; registered ${registered.length}, skipped ${skipped.length}.`
      );
    } catch (error) {
      if (isUnknownInteraction(error)) {
        // Never retry any mutation because a 15-minute interaction token expired.
        console.warn(`Massregister completed but response expired guild=${interaction.guild.id} registered=${registered.length} skipped=${skipped.length} code=10062`);
        return;
      }
      throw error;
    }
  }
}
