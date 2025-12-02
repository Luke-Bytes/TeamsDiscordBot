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
  Guild,
} from "discord.js";
import { Command } from "../commands/CommandInterface.js";
import { AnniClass, AnniMap, Team } from "@prisma/client";
import { prettifyName, randomEnum, formatTimestamp } from "../util/Utils.js";
import { parseDate } from "chrono-node";
import { Channels } from "../Channels";
import { CurrentGameManager } from "../logic/CurrentGameManager";
import { ConfigManager } from "../ConfigManager";
import { activateFeed } from "../logic/gameFeed/ActivateFeed";
import { addRegisteredPlayersFeed } from "../logic/gameFeed/RegisteredGameFeed";
import { addTeamsGameFeed } from "../logic/gameFeed/TeamsGameFeed";
import { GameInstance } from "../database/GameInstance";
import { DiscordUtil } from "../util/DiscordUtil";
import { PermissionsUtil } from "../util/PermissionsUtil";
import { ModifierSelector } from "../logic/ModifierSelector";

export default class AnnouncementCommand implements Command {
  public data: SlashCommandSubcommandsOnlyBuilder;
  public name: string = "announce";
  public description: string = "Create a game announcement";
  public buttonIds: string[] = [
    "announcement-confirm",
    "announcement-cancel",
    "announcement-edit-time",
    "announcement-edit-map",
    "announcement-edit-banned-classes",
    "announcement-edit-modifiers",
  ];

  private announcementPreviewMessage?: Message;
  private announcementMessage?: Message;
  private initialBannedClasses: AnniClass[] = [];

  constructor() {
    this.data = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description)
      .addSubcommand((subcommand) => {
        return (
          subcommand
            .setName("start")
            .setDescription("Start an announcement")
            .addStringOption((option) =>
              option.setName("when").setDescription("Date").setRequired(true)
            )
            .addStringOption((o) =>
              o
                .setName("modifiers")
                .setDescription("Include game modifiers? (yes/no)")
                .setRequired(true)
                .addChoices(
                  { name: "Yes", value: "yes" },
                  { name: "No", value: "no" }
                )
            )
            // .addStringOption((option) =>
            //   option
            //     .setName("minerushing")
            //     .setDescription("Minerushing? (poll/yes/no)")
            //     .setRequired(true)
            //     .addChoices(
            //       { name: "Yes", value: "yes" },
            //       { name: "No", value: "no" },
            //       { name: "Poll", value: "poll" }
            //     )
            // )
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
                .setRequired(true)
            )
            .addStringOption((option) =>
              option
                .setName("host")
                .setDescription("Host Name")
                .setRequired(true)
            )
            .addStringOption((option) =>
              option
                .setName("doubleelo")
                .setDescription("Enable double elo for this game? (yes/no)")
                .setRequired(false)
                .addChoices(
                  { name: "Yes", value: "yes" },
                  { name: "No", value: "no" }
                )
            )
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
          error: `Map "${mapOption}" not recognized`,
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
      CurrentGameManager.getCurrentGame().settings.organiserBannedClasses =
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
    CurrentGameManager.schedulePollCloseTime(date);

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
    } else if (minerushingOption.toLowerCase() === "yes") {
      game.setMinerushing(true);
    } else if (minerushingOption.toLowerCase() === "no") {
      game.setMinerushing(false);
    } else {
      game.setMinerushing(false);
      if (!interaction.deferred && !interaction.replied) {
        await interaction.reply(
          `Minerushing option '${minerushingOption}' unrecognized.`
        );
      } else {
        console.warn(
          `Attempted to reply with an unrecognised minerushing option '${minerushingOption}' but the interaction was already replied to or deferred.`
        );
      }
      return false;
    }
    return true;
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

    this.initialBannedClasses = [
      ...CurrentGameManager.getCurrentGame().settings.organiserBannedClasses,
    ];

    // if (!this.setMinerushing(interaction)) {
    //   return;
    // }

    const modifiersOption = interaction.options
      .getString("modifiers", true)
      .toLowerCase();
    if (modifiersOption === "yes") {
      ModifierSelector.runSelection();
    } else {
      // Default: no modifiers -> enable shared captain bans
      const gi = GameInstance.getInstance();
      gi.settings.modifiers = [];
      gi.classBanMode = "shared";
      gi.setClassBanLimit(2);
    }

    const doubleEloOption = interaction.options
      .getString("doubleelo")
      ?.toLowerCase();
    const doubleElo = doubleEloOption === "yes";
    CurrentGameManager.getCurrentGame().isDoubleElo = doubleElo;

    const embed = this.createGameAnnouncementEmbed(true, organiser, host);

    GameInstance.getInstance().organiser = organiser;
    GameInstance.getInstance().host = host;

    this.announcementPreviewMessage = await interaction.editReply(embed);
  }

  private async handleAnnouncementCancel(guild: Guild) {
    await CurrentGameManager.cancelCurrentGame(guild);
    if (this.announcementMessage) {
      await this.announcementMessage.delete();
      delete this.announcementMessage;
    }

    if (this.announcementPreviewMessage) {
      console.log("Attempting to delete announcement preview message");
      await this.announcementPreviewMessage.delete();
      delete this.announcementPreviewMessage;
    }
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const member = interaction.guild?.members.cache.get(interaction.user.id);
    const hasPermission = PermissionsUtil.hasRole(member, "organiserRole");

    if (!hasPermission) {
      await interaction.reply({
        content:
          "You do not have permission to use this command. Only organisers can execute it.",
        ephemeral: true,
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand(true);

    switch (subcommand) {
      case "start":
        await this.handleAnnouncementStart(interaction);
        break;
      case "cancel":
        await this.handleAnnouncementCancel(interaction.guild!);
    }
  }

  private async handleAnnouncementConfirm(guild: Guild) {
    const embed = this.createGameAnnouncementEmbed(false).embeds?.[0];
    if (!Channels.announcements.isSendable()) return;

    this.announcementMessage = await Channels.announcements.send({
      embeds: [embed],
    });

    if (Channels.registration.isTextBased()) {
      await Channels.registration.send(
        "**A friendly wars game has been announced!** 🎉\n" +
          "Sign up by typing the `/register [MCID]` command in this chat. If you sign up but can't play then run `/unregister`."
      );
    }

    const config = ConfigManager.getConfig();
    const chatChannelIds = [config.channels.gameFeed];

    try {
      await DiscordUtil.cleanUpAllChannelMessages(guild, chatChannelIds);
    } catch (error) {
      console.error("Failed to clean up game-feed while announcing:", error);
    }
    await activateFeed(Channels.gameFeed, addRegisteredPlayersFeed);
    await activateFeed(Channels.gameFeed, addTeamsGameFeed);

    await CurrentGameManager.getCurrentGame().announce();

    CurrentGameManager.scheduleClassBanTimers();
    CurrentGameManager.scheduleCaptainTimers(guild);

    if (this.announcementPreviewMessage) {
      await this.announcementPreviewMessage.edit({
        embeds: [embed],
        components: this.getEditComponents(true),
      });
    }
  }

  private getEditComponents(isConfirmed: boolean) {
    const confirmButton = new ButtonBuilder()
      .setCustomId("announcement-confirm")
      .setLabel("✅ Confirm and Send")
      .setStyle(ButtonStyle.Success)
      .setDisabled(isConfirmed);

    const cancelButton = new ButtonBuilder()
      .setCustomId("announcement-cancel")
      .setLabel("❌ Cancel")
      .setStyle(ButtonStyle.Danger);

    const editTimeButton = new ButtonBuilder()
      .setCustomId("announcement-edit-time")
      .setLabel("🕒 Edit Time")
      .setStyle(ButtonStyle.Secondary);

    const editMapButton = new ButtonBuilder()
      .setCustomId("announcement-edit-map")
      .setLabel("🗺️ Edit Map")
      .setStyle(ButtonStyle.Secondary);

    const editBannedClassesButton = new ButtonBuilder()
      .setCustomId("announcement-edit-banned-classes")
      .setLabel("🚫 Edit Banned Classes")
      .setStyle(ButtonStyle.Secondary);

    const editModifiersButton = new ButtonBuilder()
      .setCustomId("announcement-edit-modifiers")
      .setLabel("⚙️ Re-Roll Modifiers")
      .setStyle(ButtonStyle.Secondary);

    const firstRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      confirmButton,
      cancelButton
    );

    const secondRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      editTimeButton,
      editMapButton,
      editBannedClassesButton,
      editModifiersButton
    );

    return [firstRow, secondRow];
  }

  public async handleButtonPress(
    interaction: ButtonInteraction
  ): Promise<void> {
    await interaction.deferReply({
      ephemeral: false,
    });

    const isConfirmed = !!this.announcementMessage;

    switch (interaction.customId) {
      case "announcement-cancel":
        await this.handleAnnouncementCancel(interaction.guild!);
        await interaction.editReply("Cancelled announcement.");
        break;

      case "announcement-confirm":
        if (!isConfirmed) {
          await this.handleAnnouncementConfirm(interaction.guild!);
          await interaction.editReply("Announcement sent!");
        } else {
          await interaction.editReply("The announcement is already confirmed.");
        }
        break;

      case "announcement-edit-time":
        await this.handleEditTime(interaction);
        break;

      case "announcement-edit-map":
        await this.handleEditMap(interaction);
        break;

      case "announcement-edit-banned-classes":
        await this.handleEditBannedClasses(interaction);
        break;

      case "announcement-edit-modifiers":
        CurrentGameManager.getCurrentGame().settings.organiserBannedClasses =
          [...this.initialBannedClasses];
        CurrentGameManager.getCurrentGame().settings.sharedCaptainBannedClasses =
          [];
        CurrentGameManager.getCurrentGame().settings.nonSharedCaptainBannedClasses =
          { RED: [], BLUE: [] };
        ModifierSelector.runSelection();
        await this.updateAnnouncementMessages();
        await interaction.editReply("🔄 Modifiers have been rerolled.");
        break;

      default:
        await interaction.editReply("This doesn't do anything yet, sorry!");
        break;
    }

    if (isConfirmed) {
      const embed = this.createGameAnnouncementEmbed(false).embeds?.[0];
      if (this.announcementMessage && embed) {
        await this.announcementMessage.edit({ embeds: [embed] });
      }
    }
  }

  private createGameAnnouncementEmbed(
    preview: boolean,
    organiser?: string | null,
    host?: string | null
  ) {
    const game = CurrentGameManager.getCurrentGame();
    const registrationChannelId =
      ConfigManager.getConfig().channels.registration;

    const doubleEloMessage = game.isDoubleElo
      ? "\n\n**🌟 A special DOUBLE ELO game! 🌟**\n\n"
      : "";

    const nonSharedBans =
      game.settings.nonSharedCaptainBannedClasses ??
      ({} as Record<Team, AnniClass[]>);
    const sharedBans = Array.from(
      new Set([
        ...(game.settings.organiserBannedClasses ?? []),
        ...(game.settings.sharedCaptainBannedClasses ?? []),
      ])
    );
    const redOnly = (nonSharedBans[Team.RED] ?? []).filter(
      (c) => !sharedBans.includes(c)
    );
    const blueOnly = (nonSharedBans[Team.BLUE] ?? []).filter(
      (c) => !sharedBans.includes(c)
    );
    const bannedClassesValue = [
      `Shared: ${
        sharedBans.length
          ? sharedBans.map((v) => prettifyName(v)).join(", ")
          : "None"
      }`,
      `Red-only: ${
        redOnly.length ? redOnly.map((v) => prettifyName(v)).join(", ") : "None"
      }`,
      `Blue-only: ${
        blueOnly.length
          ? blueOnly.map((v) => prettifyName(v)).join(", ")
          : "None"
      }`,
    ].join("\n");

    const embed = new EmbedBuilder()
      .setColor("#00FF7F")
      .setTitle(`🎉 FRIENDLY WAR ANNOUNCEMENT ${preview ? "[PREVIEW]" : ""}`)
      .setDescription(
        `${
          preview ? "This is a preview of the announcement." : ""
        }${doubleEloMessage}Get ready to fight! Go to <#${registrationChannelId}> to join!`
      )
      .addFields(
        {
          name: "🕒 **TIME**",
          value: game.startTime
            ? `**${formatTimestamp(game.startTime)}**`
            : "TBD",
          inline: true,
        },
        {
          name: "🗺️ **MAP**",
          value: game.settings.map
            ? `**${prettifyName(game.settings.map)}**`
            : game.mapVoteManager
              ? `Voting... ${
                  preview
                    ? `**[${game.mapVoteManager.maps.map(prettifyName).join(", ")}]**`
                    : ""
                }`
              : "TBD",
          inline: true,
        },

        // {
        //   name: "⛏️ **MINERUSHING**",
        //   value:
        //     game.settings.minerushing === true
        //       ? "**Yes**"
        //       : game.settings.minerushing === false
        //         ? "**No**"
        //         : game.minerushVoteManager
        //           ? "Voting..."
        //           : "TBD",
        //   inline: true,
        // },
        {
          name: "🚫 **BANNED CLASSES**",
          value: bannedClassesValue,
          inline: false,
        },
        {
          name: "⚙️ **MODIFIERS**",
          value:
            game.settings.modifiers.length > 0
              ? `**${game.settings.modifiers
                  .map((m) => `${m.category}: ${m.name}`)
                  .join("\n")}**`
              : "**None**",
          inline: false,
        }
      );

    let footerText = "";
    if (organiser && host) {
      footerText = `Organised by ${organiser} - Hosted by ${host}`;
    } else if (organiser) {
      footerText = `Organised by ${organiser}`;
    } else if (host) {
      footerText = `Hosted by ${host}`;
    }
    if (footerText) {
      embed.setFooter({
        text: footerText,
        iconURL: "https://shotbow.net/presskit/images/icon.png",
      });
    }
    embed.setTimestamp();

    const confirmButton = new ButtonBuilder()
      .setCustomId("announcement-confirm")
      .setLabel("✅ Confirm and Send")
      .setStyle(ButtonStyle.Success);

    const cancelButton = new ButtonBuilder()
      .setCustomId("announcement-cancel")
      .setLabel("❌ Cancel")
      .setStyle(ButtonStyle.Danger);

    const editTimeButton = new ButtonBuilder()
      .setCustomId("announcement-edit-time")
      .setLabel("🕒 Edit Time")
      .setStyle(ButtonStyle.Secondary);

    const editMapButton = new ButtonBuilder()
      .setCustomId("announcement-edit-map")
      .setLabel("🗺️ Edit Map")
      .setStyle(ButtonStyle.Secondary);

    const editBannedClassesButton = new ButtonBuilder()
      .setCustomId("announcement-edit-banned-classes")
      .setLabel("🚫 Edit Banned Classes")
      .setStyle(ButtonStyle.Secondary);

    const editModifiersButton = new ButtonBuilder()
      .setCustomId("announcement-edit-modifiers")
      .setLabel("⚙️ Re-roll Modifiers")
      .setStyle(ButtonStyle.Secondary);

    const firstRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      confirmButton,
      cancelButton
    );

    const secondRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      editTimeButton,
      editMapButton,
      editBannedClassesButton,
      editModifiersButton
    );

    return preview
      ? { embeds: [embed], components: [firstRow, secondRow] }
      : { embeds: [embed] };
  }

  private async updateAnnouncementMessages() {
    const embed = this.createGameAnnouncementEmbed(false).embeds?.[0];
    const isConfirmed = !!this.announcementMessage;

    if (this.announcementPreviewMessage) {
      await this.announcementPreviewMessage.edit({
        embeds: [embed],
        components: this.getEditComponents(isConfirmed),
      });
    }

    if (this.announcementMessage) {
      await this.announcementMessage.edit({
        embeds: [embed],
      });
    }
  }

  private async handleEditTime(interaction: ButtonInteraction) {
    await interaction.editReply(
      "Please enter the new time in your next message."
    );

    const channel = interaction.channel;
    if (!channel || !("createMessageCollector" in channel)) {
      await interaction.followUp(
        "This interaction must be used in a text-based channel."
      );
      return;
    }

    const filter = (msg: Message) => msg.author.id === interaction.user.id;
    const collector = channel.createMessageCollector({
      filter,
      max: 1,
      time: 30000,
    });

    collector.on("collect", async (msg) => {
      const date = parseDate(msg.content, undefined, { forwardDate: true });

      if (!date) {
        await interaction.followUp("Invalid date format. Please try again.");
        return;
      }

      date.setSeconds(0);
      CurrentGameManager.getCurrentGame().startTime = date;

      if (CurrentGameManager.pollCloseTimeout) {
        clearTimeout(CurrentGameManager.pollCloseTimeout);
      }

      await this.updateAnnouncementMessages();

      CurrentGameManager.scheduleClassBanTimers();
      CurrentGameManager.scheduleCaptainTimers(interaction.guild!);
      await interaction.followUp(
        `The announcement time has been updated to ${formatTimestamp(date)}.`
      );
      collector.stop();
    });

    collector.on("end", async (_, reason) => {
      if (reason === "time") {
        await interaction.followUp("Time input timed out. Please try again.");
      }
    });
  }

  private async handleEditMap(interaction: ButtonInteraction) {
    await interaction.editReply(
      "Please enter the new map in your next message."
    );

    const channel = interaction.channel;
    if (!channel || !("createMessageCollector" in channel)) {
      await interaction.followUp(
        "This interaction must be used in a text-based channel."
      );
      return;
    }

    const filter = (msg: Message) => msg.author.id === interaction.user.id;
    const collector = channel.createMessageCollector({
      filter,
      max: 1,
      time: 30000,
    });

    collector.on("collect", async (msg) => {
      const chosenMap = this.getMap(msg.content);

      if (chosenMap.error) {
        await interaction.followUp(chosenMap.error);
        return;
      }

      switch (chosenMap.chooseMapType) {
        case "vote":
          CurrentGameManager.getCurrentGame().startMapVote(chosenMap.maps);
          break;
        case "random":
        case "specific":
          CurrentGameManager.getCurrentGame().setMap(chosenMap.map);
          break;
      }

      await this.updateAnnouncementMessages(); // Update both messages
      await interaction.followUp(
        `The map has been updated to ${chosenMap.map ?? "a voting map list."}`
      );
      collector.stop();
    });

    collector.on("end", async (_, reason) => {
      if (reason === "time") {
        await interaction.followUp("Map input timed out. Please try again.");
      }
    });
  }

  private async handleEditBannedClasses(interaction: ButtonInteraction) {
    await interaction.editReply(
      "Please enter the new banned classes separated by commas, or type `none` for no banned classes."
    );

    const channel = interaction.channel;
    if (!channel || !("createMessageCollector" in channel)) {
      await interaction.followUp(
        "This interaction must be used in a text-based channel."
      );
      return;
    }

    const filter = (msg: Message) => msg.author.id === interaction.user.id;
    const collector = channel.createMessageCollector({
      filter,
      max: 1,
      time: 30000,
    });

    collector.on("collect", async (msg) => {
      const bannedClasses = this.getBannedClasses(msg.content);

      if (bannedClasses.error) {
        await interaction.followUp(bannedClasses.error);
        return;
      }

      CurrentGameManager.getCurrentGame().settings.organiserBannedClasses =
        bannedClasses.bannedClasses;
      this.initialBannedClasses = [...bannedClasses.bannedClasses];

      await this.updateAnnouncementMessages(); // Update both messages
      await interaction.followUp(
        `The banned classes have been updated to ${
          bannedClasses.bannedClasses.length > 0
            ? bannedClasses.bannedClasses.join(", ")
            : "None"
        }.`
      );
      collector.stop();
    });

    collector.on("end", async (_, reason) => {
      if (reason === "time") {
        await interaction.followUp(
          "Banned classes input timed out. Please try again."
        );
      }
    });
  }
}
