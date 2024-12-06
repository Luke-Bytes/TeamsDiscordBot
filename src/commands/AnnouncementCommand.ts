import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  Message,
  EmbedBuilder,
  ButtonInteraction,
  ButtonBuilder,
  ActionRowBuilder,
  ButtonStyle,
  SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import { Command } from "../commands/CommandInterface.js";
import { AnniClass, AnniMap } from "@prisma/client";
import { prettifyName, randomEnum, formatTimestamp } from "../util/Utils.js";
import { parseDate } from "chrono-node";
import { Channels } from "../Channels";
import { CurrentGameManager } from "../logic/CurrentGameManager";

export default class AnnouncementCommand implements Command {
  public data: SlashCommandSubcommandsOnlyBuilder;
  public name: string = "announce";
  public description: string = "Create a game announcement";
  public buttonIds: string[] = [
    "announcement-confirm",
    "announcement-cancel",
    "announcement-edit-time",
    "announcement-edit-maps",
    "announcement-edit-banned-classes",
  ];

  private announcementPreviewMessage?: Message;
  private announcementMessage?: Message;

  constructor() {
    this.data = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description)
      .addSubcommand((subcommand) => {
        return subcommand
          .setName("start")
          .setDescription("Start an announcement")
          .addStringOption((option) =>
            option.setName("when").setDescription("Date").setRequired(true)
          )
          .addStringOption((option) =>
            option
              .setName("minerushing")
              .setDescription("Minerushing? (poll/yes/no)")
              .setRequired(true)
          )
          .addStringOption((option) =>
            option
              .setName("banned_classes")
              .setDescription(
                "Banned classes separated by a comma, or 'none' for none."
              )
              .setRequired(true)
          )
          .addStringOption((option) =>
            option
              .setName("map")
              .setDescription("Map? (poll <maps>/random/<map>)")
              .setRequired(true)
          )
          .addStringOption((option) =>
            option
              .setName("organiser")
              .setDescription("Organiser Name")
              .setRequired(false)
          )
          .addStringOption((option) =>
            option
              .setName("host")
              .setDescription("Host Name")
              .setRequired(false)
          );
      })
      .addSubcommand((subcommand) => {
        return subcommand
          .setName("cancel")
          .setDescription("Cancels the current announcement.");
      });
  }

  private getMap(mapOption: string) {
    if (mapOption.startsWith("poll ")) {
      const rest = mapOption
        .substring(5)
        .toUpperCase()
        .split(",")
        .map((v) => v.trim())
        .map((v) => v.split(" ").join(""));

      for (const element of rest) {
        if (!Object.values(AnniMap).includes(element as AnniMap)) {
          return {
            error: `Map '${element}' not recognized.`,
          };
        }
      }

      return {
        error: false,
        chooseMapType: "vote",
        maps: rest as AnniMap[],
      } as const;
    } else if (mapOption === "random") {
      return {
        error: false,
        chooseMapType: "random",
        map: randomEnum(AnniMap),
      } as const;
    } else {
      const enumMapName = mapOption.toUpperCase().trim().split(" ").join("");

      if ((Object.values(AnniMap) as string[]).includes(enumMapName)) {
        return {
          error: false,
          chooseMapType: "specific",
          map: enumMapName as AnniMap,
        } as const;
      } else {
        return {
          error: `Map '${mapOption} not recognized'`,
        } as const;
      }
    }
  }

  private getBannedClasses(bannedClassesOption: string) {
    if (bannedClassesOption === "none")
      return {
        error: false,
        bannedClasses: [] as AnniClass[],
      } as const;

    const kits = bannedClassesOption
      .toUpperCase()
      .split(",")
      .map((v) => v.trim());

    for (const element of kits) {
      if (!Object.values(AnniClass).includes(element as AnniClass)) {
        return {
          error: `Class '${element}' not recognized.`,
        } as const;
      }
    }

    return {
      error: false,
      bannedClasses: kits as AnniClass[],
    } as const;
  }

  //todo: really bad function naming and separation of tasks.
  private async setBannedClasses(interaction: ChatInputCommandInteraction) {
    const bannedClassesOption = interaction.options.getString(
      "banned_classes",
      true
    );
    const bannedClasses = this.getBannedClasses(bannedClassesOption);

    if (!bannedClasses.error) {
      CurrentGameManager.getCurrentGame().settings.bannedClasses =
        bannedClasses.bannedClasses;
    } else {
      await interaction.editReply(bannedClasses.error);
      return false;
    }
    return true;
  }

  private async setMap(interaction: ChatInputCommandInteraction) {
    const mapOption = interaction.options.getString("map", true);
    const chosenMap = this.getMap(mapOption);

    if (chosenMap.error) {
      await interaction.editReply(chosenMap.error);
      return false;
    } else {
      switch (chosenMap.chooseMapType) {
        case "vote":
          CurrentGameManager.getCurrentGame().startMapVote(chosenMap.maps);
          break;
        case "random":
        case "specific":
          CurrentGameManager.getCurrentGame().setMap(chosenMap.map);
      }
      return true;
    }
  }

  private async setDate(interaction: ChatInputCommandInteraction) {
    const whenOption = interaction.options.getString("when", true);

    const date = parseDate(whenOption, undefined, {
      forwardDate: true,
    });

    if (!date) {
      await interaction.editReply(
        "Date could not be deduced. Please try again"
      );
      return false;
    }

    date.setSeconds(0);

    CurrentGameManager.getCurrentGame().startTime = date;

    return true;
  }

  private async setMinerushing(interaction: ChatInputCommandInteraction) {
    const minerushingOption = interaction.options.getString(
      "minerushing",
      true
    );
    const game = CurrentGameManager.getCurrentGame();

    if (minerushingOption === "poll") {
      game.startMinerushVote();
    } else if (minerushingOption === "yes") {
      game.settings.minerushing = true;
    } else if (minerushingOption === "no") {
      game.settings.minerushing = false;
    } else {
      await interaction.reply(
        `Minerushing option '${minerushingOption}' unrecognized.`
      );
    }
  }

  private async handleAnnouncementStart(
    interaction: ChatInputCommandInteraction
  ) {
    const organiser = interaction.options.getString("organiser");
    const host = interaction.options.getString("host");

    await interaction.deferReply();

    if (this.announcementPreviewMessage) {
      await interaction.editReply(
        "A proposed announcement has already started. Please cancel that one or edit it."
      );
      return;
    }

    if (!(await this.setMap(interaction))) {
      return;
    }

    if (!(await this.setDate(interaction))) {
      return;
    }

    if (!(await this.setBannedClasses(interaction))) {
      return;
    }

    if (!this.setMinerushing(interaction)) {
      return;
    }

    const embed = this.createGameAnnouncementEmbed(true);

    this.announcementPreviewMessage = await interaction.editReply(embed);
  }

  private async handleAnnouncementCancel() {
    CurrentGameManager.cancelCurrentGame();
    if (this.announcementMessage) {
      await this.announcementMessage.delete();
      delete this.announcementMessage;
    }

    if (this.announcementPreviewMessage) {
      console.log("attempt to delete announcement preview message");
      await this.announcementPreviewMessage.delete();
      delete this.announcementPreviewMessage;
    }
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand(true);

    switch (subcommand) {
      case "start":
        await this.handleAnnouncementStart(interaction);
        break;
      case "cancel":
        await this.handleAnnouncementCancel();
    }
  }

  private async handleAnnouncementConfirm() {
    const embed = this.createGameAnnouncementEmbed(false);
    if (!Channels.announcements.isSendable()) return;

    this.announcementMessage = await Channels.announcements.send(embed);

    await CurrentGameManager.getCurrentGame().announce();
  }

  public async handleButtonPress(
    interaction: ButtonInteraction
  ): Promise<void> {
    await interaction.deferReply({
      ephemeral: false,
    });
    switch (interaction.customId) {
      case "announcement-cancel":
        if (CurrentGameManager.getCurrentGame().announced) {
          await interaction.editReply(
            "Game has already been announced. Cancel the announcement with /announce cancel."
          );
        } else {
          await this.handleAnnouncementCancel();
          await interaction.editReply("Cancelled announcement.");
        }
        break;
      case "announcement-confirm":
        await this.handleAnnouncementConfirm();
        await interaction.editReply("Sent announcement!");
        break;
    }
  }

  private createGameAnnouncementEmbed(preview: boolean) {
    const game = CurrentGameManager.getCurrentGame();
    const embed = new EmbedBuilder()
      .setColor("#0099ff")
      .setTitle(`FRIENDLY WAR ANNOUNCEMENT${preview ? " [preview]" : ""}`)
      .addFields(
        {
          name: `TIME: ${game.startTime ? formatTimestamp(game.startTime) : "N/A"}`,
          value: " ",
          inline: false,
        },
        {
          name: `MAP: ${game.settings.map ? prettifyName(game.settings.map) : game.mapVoteManager ? "Voting..." + (preview ? " [" + game.mapVoteManager.maps.map(prettifyName).join(", ") + "]" : "") : "N/A"}`,
          value: " ",
          inline: false,
        },
        {
          name: `BANNED CLASSES: ${game.settings.bannedClasses?.length === 0 ? "None" : game.settings.bannedClasses?.map((v) => prettifyName(v)).join(", ")}`,
          value: " ",
          inline: false,
        },
        {
          name: `MINERUSHING? ${game.settings.minerushing === true ? "Yes" : game.settings.minerushing === false ? "No" : game.minerushVoteManager ? "Voting..." : "N/A"}`,
          value: " ",
          inline: false,
        }
      );

    const confirmButton = new ButtonBuilder()
      .setCustomId("announcement-confirm")
      .setLabel("Confirm and Send")
      .setStyle(ButtonStyle.Primary);

    const cancelButton = new ButtonBuilder()
      .setCustomId("announcement-cancel")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger);

    const firstRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      confirmButton,
      cancelButton
    );

    const editTimeButton = new ButtonBuilder()
      .setCustomId("announcement-edit-time")
      .setLabel("Edit Time")
      .setStyle(ButtonStyle.Secondary);

    const editMapButton = new ButtonBuilder()
      .setCustomId("announcement-edit-button")
      .setLabel("Edit Map")
      .setStyle(ButtonStyle.Secondary);

    const editBannedClassesButton = new ButtonBuilder()
      .setCustomId("announcement-edit-banned-classes")
      .setLabel("Edit Banned Classes")
      .setStyle(ButtonStyle.Secondary);

    const secondRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      editTimeButton,
      editMapButton,
      editBannedClassesButton
    );

    if (preview) {
      return { embeds: [embed], components: [firstRow, secondRow] } as const;
    } else {
      return { embeds: [embed] } as const;
    }
  }
}
