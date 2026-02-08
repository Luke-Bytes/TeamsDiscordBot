import {
  ChatInputCommandInteraction,
  ButtonInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Message,
  MessageFlags,
} from "discord.js";
import {
  TeamPickingSession,
  TeamPickingSessionState,
} from "./TeamPickingSession";
import { GameInstance } from "../../database/GameInstance";
import { PlayerInstance } from "../../database/PlayerInstance";
import { CurrentGameManager } from "../../logic/CurrentGameManager";
import { Team } from "@prisma/client";
import { EloUtil } from "../../util/EloUtil";
import { escapeText } from "../../util/Utils";

export class RandomTeamPickingSession extends TeamPickingSession {
  state: TeamPickingSessionState = "inProgress";
  embedMessage?: Message<boolean>;
  proposedTeams: Record<Team | "UNDECIDED", PlayerInstance[]> = {
    RED: [],
    BLUE: [],
    UNDECIDED: [],
  };
  redCaptain?: PlayerInstance;
  blueCaptain?: PlayerInstance;
  private mode: "random" | "elo" | "balance";

  constructor(mode: "random" | "elo" | "balance" = "random") {
    super();
    this.mode = mode;
  }

  public async initialize(interaction: ChatInputCommandInteraction) {
    const game = CurrentGameManager.getCurrentGame();

    //     this.proposedTeams = { ...game.teams };
    //     this.redCaptain = game.getCaptainOfTeam("RED");
    //     this.blueCaptain = game.getCaptainOfTeam("BLUE");

    //     if (!this.redCaptain && !this.blueCaptain) {
    //       await interaction.editReply({
    //         content:
    //           "The teams do not have captains. Please use `/captain set` to set the captains of the teams.",
    //       });
    //       this.state = "cancelled";
    //       return;
    //     } else if (!this.redCaptain) {
    //       await interaction.editReply({
    //         content:
    //           "Red team does not have a captain. Please use `/captain set` to set the captains of Red team.",
    //       });
    //       this.state = "cancelled";
    //       return;
    //     } else if (!this.blueCaptain) {
    //       await interaction.editReply({
    //         content:
    //           "Blue team does not have a captain. Please use `/captain set` to set the captains of Blue team.",
    //       });
    //       this.state = "cancelled";
    //       return;
    //   }
    game.createTeams(this.mode);
    this.proposedTeams = {
      RED: [...game.teams.RED],
      BLUE: [...game.teams.BLUE],
      UNDECIDED: [...game.teams.UNDECIDED],
    };
    const embed = this.createTeamGenerateEmbed(game);

    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    this.embedMessage = await interaction.editReply(embed);
  }

  private shuffle() {
    const shuffled = Object.values(this.proposedTeams)
      .flat(1)
      .filter((p) => !p.captain)
      .sort(() => Math.random() - 0.5);
    const half = Math.ceil(shuffled.length / 2);

    const blue = shuffled.slice(0, half);
    const red = shuffled.slice(half);

    this.proposedTeams.BLUE = [this.blueCaptain!];
    this.proposedTeams.RED = [this.redCaptain!];

    this.proposedTeams.BLUE.push(...blue);
    this.proposedTeams.RED.push(...red);

    this.proposedTeams.UNDECIDED = [];
  }

  public async handleInteraction(interaction: ButtonInteraction) {
    const game = CurrentGameManager.getCurrentGame();

    switch (interaction.customId) {
      //       case "random-team-accept":
      //         {
      //           const { embeds } = this.createTeamGenerateEmbed(game);
      //           await this.embedMessage?.edit({ embeds, components: [] });
      //           await interaction.update({});
      //           game.teams = this.proposedTeams;
      //           this.state = "finalized";
      //         }
      //         break;
      //       case "random-team-generate-reroll":
      //         {
      //           this.shuffle();
      //           const embed = this.createTeamGenerateEmbed(game);

      //           await this.embedMessage!.edit(embed);

      //           await interaction.update({});
      //         }
      case "random-team-accept": {
        const currentPlayers = game.getPlayers();
        const currentIds = new Set(
          currentPlayers.map((p) => p.discordSnowflake)
        );
        const filterCurrent = (players: PlayerInstance[]) =>
          players.filter((p) => currentIds.has(p.discordSnowflake));

        game.teams.BLUE = filterCurrent(this.proposedTeams.BLUE);
        game.teams.RED = filterCurrent(this.proposedTeams.RED);
        game.teams.UNDECIDED = filterCurrent(this.proposedTeams.UNDECIDED);

        const assigned = new Set([
          ...game.teams.RED.map((p) => p.discordSnowflake),
          ...game.teams.BLUE.map((p) => p.discordSnowflake),
          ...game.teams.UNDECIDED.map((p) => p.discordSnowflake),
        ]);
        const unassigned = currentPlayers.filter(
          (p) => !assigned.has(p.discordSnowflake)
        );
        if (unassigned.length) {
          game.teams.UNDECIDED.push(...unassigned);
        }

        const { embeds, components } = this.createTeamGenerateEmbed(game, {
          RED: game.teams.RED,
          BLUE: game.teams.BLUE,
        });
        await this.embedMessage?.edit({
          embeds,
          components,
        });

        await interaction.update({});
        if (this.mode === "random") {
          game.changeHowTeamsDecided("RANDOMISED");
        } else if (this.mode === "elo") {
          game.changeHowTeamsDecided("ELO");
        } else {
          game.changeHowTeamsDecided("BALANCE");
        }
        this.state = "finalized";
        break;
      }

      case "random-team-generate-reroll": {
        if (this.mode !== "random") {
          await interaction.update({});
          return;
        }
        const simulatedTeams = game.simulateShuffledTeams();
        this.proposedTeams = {
          RED: [...simulatedTeams.RED],
          BLUE: [...simulatedTeams.BLUE],
          UNDECIDED: [],
        };
        const { embeds, components } = this.createTeamGenerateEmbed(
          game,
          simulatedTeams
        );
        await this.embedMessage?.edit({
          embeds,
          components,
        });

        await interaction.update({});
        break;
      }

      case "random-team-generate-cancel":
        await this.embedMessage?.delete();
        this.state = "cancelled";
        break;
    }
  }

  //   createTeamGenerateEmbed(game: GameInstance) {
  //     const redPlayers: PlayerInstance[] = this.proposedTeams.RED;
  //     const bluePlayers: PlayerInstance[] = this.proposedTeams.BLUE;

  //     const getString = (players: PlayerInstance[]) => {
  //       const captain = players.filter((p) => p.captain)[0];
  //       return players.length > 0
  //         ? `**${captain.ignUsed ?? "Unknown Player"}**\n` +
  //             players
  //               .filter((p) => !p.captain)
  //               .map((player) => player.ignUsed ?? "Unknown Player")
  //               .join("\n")
  //         : "No players";
  //     };

  createTeamGenerateEmbed(
    game: GameInstance,
    simulatedTeams?: Record<Team, PlayerInstance[]>
  ) {
    const teams = simulatedTeams || game.teams;

    const formatTeamString = (players: PlayerInstance[]) =>
      players.length
        ? players
            .map((player, index) => {
              const playerString = `${EloUtil.getEloEmoji(player.elo)} ${escapeText(
                player.ignUsed ?? "Unknown Player"
              )}`;
              return index === 0 ? `**${playerString}**` : playerString;
            })
            .join("\n")
        : "No players";

    const bluePlayersString = formatTeamString(teams.BLUE);
    const redPlayersString = formatTeamString(teams.RED);

    const embed = new EmbedBuilder()
      .setColor("#0099ff")
      .setTitle(
        this.mode === "elo"
          ? "Elo Teams"
          : this.mode === "balance"
            ? "Balanced Teams"
            : "Randomised Teams"
      )
      .addFields(
        //         {
        //           name: "🔵 Blue Team 🔵  ",
        //           value: getString(bluePlayers),
        //           inline: true,
        //         },
        //         {
        //           name: "🔴 Red Team 🔴   ",
        //           value: getString(redPlayers),
        //           inline: true,
        //         }
        { name: "🔵 Blue Team 🔵", value: bluePlayersString, inline: true },
        { name: "🔴 Red Team 🔴", value: redPlayersString, inline: true }
      )
      .setFooter({ text: "This is a preview. Confirm to lock teams." });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("random-team-accept")
        .setLabel("Confirm Teams")
        .setStyle(ButtonStyle.Success)
    );

    if (this.mode === "random") {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId("random-team-generate-reroll")
          .setLabel("Reroll")
          .setStyle(ButtonStyle.Primary)
      );
    }

    row.addComponents(
      new ButtonBuilder()
        .setCustomId("random-team-generate-cancel")
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Danger)
    );

    return { embeds: [embed], components: [row] };
  }

  public async handleMessage(_message: Message<boolean>) {}

  public getState() {
    return this.state;
  }

  public async cancelSession(): Promise<void> {
    this.state = "cancelled";
    await this.embedMessage?.delete().catch(() => {});
  }
}
