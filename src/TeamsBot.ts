import "dotenv/config";
import { startEventDiscordSync, syncReturningEventMember } from "./logic/EventDiscordSync";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import { CommandHandler } from "./commands/CommandHandler";
import { MessageHandler } from "./interactions/MessageHandler";
import { AiMentionHandler } from "./interactions/AiMentionHandler";
import { ReactionHandler } from "./interactions/ReactionHandler";
import { VoiceChannelHandler } from "./interactions/VoiceChannelHandler";
import { Channels } from "./Channels";
import logger from "./util/Logger";
import { PermissionsUtil } from "./util/PermissionsUtil";
import { MaintenanceLoggingUtil } from "./util/MaintenanceLoggingUtil";
import { PrismaUtils } from "./util/PrismaUtils";
import { ConfigManager } from "./ConfigManager";
import { SeasonService } from "./database/SeasonService";
import { prismaClient } from "./database/prismaClient";
import { MatchCleanupState } from "@prisma/client";
import { MatchRecoveryGate } from "./logic/MatchRecoveryGate";
import { GameInstance } from "./database/GameInstance";
import { GameRecoveryCoordinator, GameSnapshotStore, recoverPendingGame, GameSnapshot } from "./logic/ActiveGameRecovery";
import { DiscordUtil } from "./util/DiscordUtil";
import { Message, TextChannel } from "discord.js";
import { discordErrorCode } from "./util/DiscordFailures";

type RecoveryMessageResult =
  | { status: "found"; message: Message<boolean> }
  | { status: "not-recorded" | "missing" | "unverified" };

export class TeamsBot {
  client: Client;

  commandHandler: CommandHandler;
  messageHandler: MessageHandler;
  mentionHandler: AiMentionHandler;
  reactionHandler: ReactionHandler;
  voiceChannelHandler: VoiceChannelHandler;
  private static processHandlersAttached = false;

  constructor() {
    MatchRecoveryGate.markUnchecked();
    GameRecoveryCoordinator.beginStartup();
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessagePolls,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    this.client.on("rateLimit", (warn) => {
      console.warn("Rate limit hit:", warn);
    });

    this.commandHandler = new CommandHandler();
    this.messageHandler = new MessageHandler(this.client);
    this.mentionHandler = new AiMentionHandler(
      this.commandHandler.askCommand.assistant
    );
    this.reactionHandler = new ReactionHandler();
    this.voiceChannelHandler = new VoiceChannelHandler();

    this.attachGlobalGuards();
  }

  private attachGlobalGuards() {
    if (TeamsBot.processHandlersAttached) return;
    TeamsBot.processHandlersAttached = true;
    const config = ConfigManager.getConfig();
    const isDev = config.dev.enabled || process.env.NODE_ENV === "development";

    process.on("unhandledRejection", (reason, promise) => {
      console.error("Unhandled promise rejection:", reason, promise);
    });

    process.on("uncaughtException", (error) => {
      console.error("Uncaught exception:", error);
      if (isDev) {
        process.exit(1);
      }
    });

    process.on("warning", (warning) => {
      console.warn("Process warning:", warning);
    });

    this.client.on("error", (error) => {
      console.error("Discord client error:", error);
      if (isDev) {
        throw error;
      }
    });

    this.client.on("shardError", (error) => {
      console.error("Discord shard error:", error);
      if (isDev) {
        throw error;
      }
    });

    this.client.on("warn", (warning) => {
      console.warn("Discord client warning:", warning);
    });
  }

  private async fetchRecoveryMessage(
    ref: { id: string; channelId: string } | null,
    timeoutMs = 3000
  ): Promise<RecoveryMessageResult> {
    if (!ref) return { status: "not-recorded" };
    let timeout: NodeJS.Timeout | undefined;
    try {
      const operation = async () => {
        const channel = await this.client.channels.fetch(ref.channelId, { force: true });
        if (!channel || !("messages" in channel)) throw new Error("Original message channel unavailable");
        return (channel as TextChannel).messages.fetch({ message: ref.id, force: true }) as Promise<Message<boolean>>;
      };
      const message = await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Discord message fetch timed out")), timeoutMs);
        }),
      ]);
      if (!message) throw new Error("Original message lookup returned no result");
      return { status: "found", message };
    } catch (error) {
      const code = discordErrorCode(error);
      if (code === 10008 || code === 10003) {
        console.info(`[game-recovery] Original Discord resource missing channel=${ref.channelId} id=${ref.id} code=${code}`);
        return { status: "missing" };
      }
      console.warn(`[game-recovery] Original Discord message not verified channel=${ref.channelId} id=${ref.id}`, error);
      return { status: "unverified" };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async restorePendingActiveGame(): Promise<void> {
    try {
      const snapshot: GameSnapshot | null = await recoverPendingGame(
        new GameSnapshotStore(),
        GameInstance.getInstance(),
        MatchRecoveryGate.getBlockReason()
      );
      if (!snapshot) {
        GameRecoveryCoordinator.finishStartup(null);
        return;
      }
      // Re-fetch only; these requests must not recreate announcements, pings or roles.
      const refs = snapshot.workflows;
      const game = GameInstance.getInstance();
      const restoreReference = async (label: string, ref: { id: string; channelId: string } | null) => {
        const result = await this.fetchRecoveryMessage(ref);
        if (result.status === "found") return result.message;
        if (result.status === "unverified" && ref) {
          game.recoveryPausedWorkflows.push(`${label} could not be verified; organiser review required (message ${ref.id} in channel ${ref.channelId})`);
        }
        return undefined;
      };
      const announcement = await restoreReference("Announcement", refs.announcementMessage);
      if (announcement) this.commandHandler.announcementCommand.attachRecoveredAnnouncementMessage(announcement);
      game.announcementPingMessage = await restoreReference("Announcement ping", refs.announcementPingMessage);
      game.announcementPreviewMessage = await restoreReference("Announcement preview", refs.announcementPreviewMessage);
      const total = game.getRegisteredPlayerCount();
      console.info(`[game-recovery] Restored game=${snapshot.gameId} players=${total}; paused=${game.recoveryPausedWorkflows.join("; ")}`);
      GameRecoveryCoordinator.finishStartup(null);
      await DiscordUtil.sendMessage("gameFeed",
        `Active game recovered after restart: ${total} registered players, original time and teams retained. Automatic timers, votes and unfinished sessions are paused for organiser review. Use /team list to inspect.`
      ).catch((error) => console.warn("[game-recovery] Could not send recovery notice", error));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      GameRecoveryCoordinator.finishStartup(`Active-game recovery requires operator intervention: ${reason}`);
      console.error("[game-recovery] Startup blocked; pending snapshot retained", reason);
    }
  }

  public async start() {
    this.client.once("ready", async () => {
      console.log = (...args: unknown[]) => logger.info(args.join(" "));
      console.table = (...args: unknown[]) => logger.info(args.join(" "));
      console.info = (...args: unknown[]) => logger.info(args.join(" "));
      console.warn = (...args: unknown[]) => logger.warn(args.join(" "));
      console.error = (...args: unknown[]) => logger.error(args.join(" "));
      console.debug = (...args: unknown[]) => logger.debug(args.join(" "));
      console.log(`Logged in as ${this.client.user?.tag}!`);

      // Detect previously committed matches whose Discord cleanup was interrupted.
      // Never infer a winner or automatically reverse moderator edits on restart.
      await MatchRecoveryGate.inspectPending(async () => {
        const pending = await prismaClient.game.findMany({
          where: { cleanupState: MatchCleanupState.PENDING },
          select: { id: true },
          take: 100,
        });
        return pending.map((record) => record.id);
      });
      try {
        await Channels.initChannels(this.client);
        await this.restorePendingActiveGame();
      } catch (error) {
        console.error("[game-recovery] Cannot initialise configured Discord channels", error);
        GameRecoveryCoordinator.finishStartup("Discord channel initialisation failed; active game recovery is blocked");
      }
      this.commandHandler.loadCommands();
      await this.commandHandler.registerCommands();
      await this.commandHandler.vcCommand.manager.recoverActiveChannels(
        this.client
      );
      MaintenanceLoggingUtil.startLogging();
      startEventDiscordSync(this.client);

      const updatedCount = await PrismaUtils.updatePunishmentsForExpiry();
      if (updatedCount > 0) {
        console.log(`${updatedCount} punishment(s) expired today.`);
      } else {
        console.log("No punishments expired today.");
      }
      try {
        await SeasonService.initialize(this.client);
      } catch (error) {
        console.error("Failed to initialise season lifecycle:", error);
      }
    });

    this.client.on("messageDelete", (message) => {
      this.commandHandler.leaderboardsCommand.removeMessageSession(message.id);
    });
    this.client.on("messageDeleteBulk", (messages) => {
      for (const id of messages.keys()) {
        this.commandHandler.leaderboardsCommand.removeMessageSession(id);
      }
    });

    this.client.on("guildMemberAdd", async (member) => {
      if (!ConfigManager.getConfig().roles.eventParticipantRole) return;
      try {
        await syncReturningEventMember(this.client, member.guild.id, member.id);
      } catch {
        console.warn(`[events] Returning-member role sync pending guild=${member.guild.id}`);
      }
    });

    this.client.on("guildMemberRemove", async (member) => {
      try {
        await this.commandHandler.teamCommand.handleGuildDeparture(member.id, member.guild.id);
      } catch (error) {
        console.error(`Guild departure handling failed guild=${member.guild.id} member=${member.id}`, error);
      }
    });

    // Command + Context Menu Listener
    this.client.on("interactionCreate", async (interaction) => {
      await this.commandHandler.handleInteraction(interaction);
    });

    this.client.on("messageCreate", async (msg) => {
      const done = GameRecoveryCoordinator.enterOperation();
      if (!done) return;
      try {
      if (!msg.guild) {
        const awaitingCaptainPlan =
          this.commandHandler.gameCommand.isAwaitingCaptainPlan(msg.author.id);
        if (awaitingCaptainPlan) {
          try {
            const handled = await this.commandHandler.gameCommand.handleDM(msg);
            if (handled) {
              return;
            }
          } catch (e) {
            console.log(`Failed to create message: ${e}`);
          }
        }
        return;
      }

      if (
        PermissionsUtil.isDebugEnabled() &&
        msg.guild?.id !== PermissionsUtil.config.dev.guildId
      ) {
        return;
      }
      // Consume explicit Navi mentions before community votes or draft picks.
      // The outer recovery operation remains held until the AI reply settles.
      try {
        if (await this.mentionHandler.handle(msg)) return;
      } catch {
        // No question text or provider error details in logs, and never feed a
        // failed Navi invocation into a game-input workflow.
        console.warn("ai.mention outcome=handler_failed");
        return;
      }
      if (msg.content.length > 1900) return;
      const handledTierListMessage =
        this.commandHandler.tierListCommand.handleMessage(msg);
      if (handledTierListMessage) {
        return;
      }
      if (this.commandHandler.teamCommand.teamPickingSession) {
        try {
          await this.commandHandler.teamCommand.handleTeamPickingMessage(
            msg
          );
        } catch (error) {
          console.error("Team picking message handling failed: ", error);
        }
      }
      } finally {
        done();
      }
    });

    try {
      await this.client.login(process.env.BOT_TOKEN);
      console.log("Successfully logged in!");
    } catch (error) {
      console.log(error);
    }
  }
}
