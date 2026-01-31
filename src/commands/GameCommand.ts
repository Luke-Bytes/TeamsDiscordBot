import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  Guild,
  GuildMember,
  Message,
  ButtonInteraction,
  TextChannel,
} from "discord.js";
import { Command } from "./CommandInterface.js";
import { ConfigManager } from "../ConfigManager";
import { PermissionsUtil } from "../util/PermissionsUtil";
import { GameInstance } from "../database/GameInstance";
import { cleanUpAfterGame } from "../logic/GameEndCleanUp";
import { DiscordUtil } from "../util/DiscordUtil";
import { checkMissingPlayersInVC, formatTeamIGNs } from "../util/Utils";
import { parsePlanText, TeamPlanRecord } from "../util/PlanUtil";
import CaptainPlanDMManager from "../logic/CaptainPlanDMManager";

export default class GameCommand implements Command {
  data = new SlashCommandBuilder()
    .setName("game")
    .setDescription("Manage game sessions")
    .addSubcommand((sub) =>
      sub.setName("start").setDescription("Move players to team vcs")
    )
    .addSubcommand((sub) =>
      sub
        .setName("end")
        .setDescription("Move players to 1 vc and start MVP vote")
    )
    .addSubcommand((sub) =>
      sub
        .setName("shutdown")
        .setDescription("Complete the game and calculate elo")
    );

  name = "game";
  description = "Manage game session";
  private captainPlanDMManager: CaptainPlanDMManager;

  constructor(captainPlanDMManager = new CaptainPlanDMManager()) {
    this.captainPlanDMManager = captainPlanDMManager;
  }

  get buttonIds(): string[] {
    return this.captainPlanDMManager.buttonIds;
  }

  public isAwaitingCaptainPlan(userId: string): boolean {
    return this.captainPlanDMManager.hasPendingSession(userId);
  }

  async execute(interaction: ChatInputCommandInteraction) {
    const subCommand = interaction.options.getSubcommand();
    const isAuthorized = await PermissionsUtil.isUserAuthorised(interaction);
    if (!isAuthorized) return;
    const guild = interaction.guild!;
    const gameInstance = GameInstance.getInstance();
    switch (subCommand) {
      case "start":
        await interaction.deferReply();
        try {
          const memberCache = await buildMemberCache(
            guild,
            [
              ...gameInstance.getPlayersOfTeam("RED"),
              ...gameInstance.getPlayersOfTeam("BLUE"),
            ].map((player) => player.discordSnowflake)
          );

          await assignTeamVCAfterPicking(guild, memberCache);
          await assignTeamRolesAfterPicking(guild, memberCache);

          await interaction.editReply(
            "Game will begin soon! Roles assigned and players moved to VCs."
          );

          await DiscordUtil.sendMessage(
            "redTeamChat",
            `Welcome to the red team! This is the planning phase. Please be ready to join the event server ⚔️`
          );

          await DiscordUtil.sendMessage(
            "blueTeamChat",
            `Welcome to the blue team! This is the planning phase. Please be ready to join the event server ⚔️`
          );

          await checkMissingPlayersInVC(
            interaction.guild!,
            "RED",
            async (msg) => {
              await DiscordUtil.sendMessage("redTeamChat", `${msg}`);
            }
          );
          await checkMissingPlayersInVC(
            interaction.guild!,
            "BLUE",
            async (msg) => {
              await DiscordUtil.sendMessage("blueTeamChat", `${msg}`);
            }
          );

          const redNamesFormatted = await formatTeamIGNs(
            gameInstance,
            "RED",
            false
          );
          const blueNamesFormatted = await formatTeamIGNs(
            gameInstance,
            "BLUE",
            false
          );
          await DiscordUtil.sendMessage(
            "redTeamChat",
            `**Mid Blocks Plan**\n\`\`\`\n${redNamesFormatted}\n\`\`\`\n**Game Plan**\n\`\`\`\n${redNamesFormatted}\n\`\`\``
          );
          await DiscordUtil.sendMessage(
            "blueTeamChat",
            `**Mid Blocks Plan**\n\`\`\`\n${blueNamesFormatted}\n\`\`\`\n**Game Plan**\n\`\`\`\n${blueNamesFormatted}\n\`\`\``
          );

          if (gameInstance.getClassBanLimit() !== 0) {
            await DiscordUtil.sendMessage(
              "redTeamChat",
              `⚠️ **Team captain** submit your class ban when ready with \`/class ban [class]\``
            );

            await DiscordUtil.sendMessage(
              "blueTeamChat",
              `⚠️ **Team captain** submit your class ban when ready with \`/class ban [class]\``
            );
          }

          if (gameInstance.pickOtherTeamsSupportRoles) {
            await DiscordUtil.sendMessage(
              "redTeamChat",
              "Team captain — please list out the support roles for the other team:\n```\nBunker:\nFarmer:\nGold Miner:\n```"
            );

            await DiscordUtil.sendMessage(
              "blueTeamChat",
              "Team captain — please list out the support roles for the other team:\n```\nBunker:\nFarmer:\nGold Miner:\n```"
            );
          }

          // After team picking is finished and just before start, DM captains plan template
          const redCaptain = gameInstance.getCaptainOfTeam("RED");
          const blueCaptain = gameInstance.getCaptainOfTeam("BLUE");
          const client = interaction.client;
          if (!client || !client.users) {
            console.warn(
              "[CaptainPlanDM] Interaction client missing; skipping captain plan DMs."
            );
            break;
          }
          if (redCaptain) {
            await this.captainPlanDMManager.startForCaptain({
              client,
              captainId: redCaptain.discordSnowflake,
              team: "RED",
              teamList: await formatTeamIGNs(gameInstance, "RED", false),
              members: gameInstance.getPlayersOfTeam("RED").map((p) => ({
                id: p.discordSnowflake,
                ign: p.ignUsed ?? p.latestIGN ?? "Unknown",
              })),
            });
          }
          if (blueCaptain) {
            await this.captainPlanDMManager.startForCaptain({
              client,
              captainId: blueCaptain.discordSnowflake,
              team: "BLUE",
              teamList: await formatTeamIGNs(gameInstance, "BLUE", false),
              members: gameInstance.getPlayersOfTeam("BLUE").map((p) => ({
                id: p.discordSnowflake,
                ign: p.ignUsed ?? p.latestIGN ?? "Unknown",
              })),
            });
          }
        } catch (error) {
          console.error("Error starting the game: ", error);
          await interaction.editReply({
            content: "Failed to start the game.",
          });
        }
        break;

      case "end": {
        gameInstance.isFinished = true;
        await interaction.reply(
          "Moving players back to team picking and starting MVP votes.."
        );
        await movePlayersToTeamPickingAfterGameEnd(guild);

        await captureTeamPlansFromChannels(guild, gameInstance);

        const config = ConfigManager.getConfig();
        const blueTeamRoleId = config.roles.blueTeamRole;
        const redTeamRoleId = config.roles.redTeamRole;

        if (Object.keys(gameInstance.mvpVotes.RED).length === 0) {
          await DiscordUtil.sendMessage(
            "redTeamChat",
            `The game has now ended, voting for the team MVP is now open! Type \`/MVP Vote [MCID]\` to pick for <@&${redTeamRoleId}>!`
          );
        }

        if (Object.keys(gameInstance.mvpVotes.BLUE).length === 0) {
          await DiscordUtil.sendMessage(
            "blueTeamChat",
            `The game has now ended, voting for the team MVP is now open! Type \`/MVP Vote [MCID]\` to pick for <@&${blueTeamRoleId}>!`
          );
        }

        gameInstance.calculateMeanEloAndExpectedScore();

        break;
      }

      case "shutdown":
        if (!gameInstance.gameWinner) {
          await interaction.reply({
            content: "Please set a winner via /winner before ending the game.",
          });
          return;
        }
        if (!gameInstance.isFinished) {
          await interaction.reply({
            content:
              "The game should be finished first in order to wait for mvp votes, /game end",
          });
          return;
        }
        if (gameInstance.isRestarting) {
          await interaction.reply({
            content: "A game shutdown is already in progress!",
          });
          return;
        }
        GameInstance.getInstance().isRestarting = true;
        await interaction.reply(
          "Beginning post game clean up of channels and calculating elo.."
        );
        await cleanUpAfterGame(guild);
        break;

      default:
        await interaction.reply("Invalid subcommand.");
    }
  }

  async handleDM(message: Message): Promise<boolean> {
    return this.captainPlanDMManager.handleDM(message);
  }

  async handleButtonPress(interaction: ButtonInteraction) {
    await this.captainPlanDMManager.handleButtonPress(interaction);
  }
}

async function captureTeamPlansFromChannels(
  guild: Guild,
  gameInstance: GameInstance
): Promise<void> {
  const config = ConfigManager.getConfig();
  const redChannel = guild.channels.cache.get(
    config.channels.redTeamChat
  ) as TextChannel | undefined;
  const blueChannel = guild.channels.cache.get(
    config.channels.blueTeamChat
  ) as TextChannel | undefined;

  const [redPlan, bluePlan] = await Promise.all([
    extractLatestPlanFromChannel(redChannel),
    extractLatestPlanFromChannel(blueChannel),
  ]);

  const mergedRed = mergePlans(gameInstance.redTeamPlan, redPlan);
  if (mergedRed) gameInstance.redTeamPlan = mergedRed;
  const mergedBlue = mergePlans(gameInstance.blueTeamPlan, bluePlan);
  if (mergedBlue) gameInstance.blueTeamPlan = mergedBlue;
}

async function extractLatestPlanFromChannel(
  channel?: TextChannel
): Promise<TeamPlanRecord | null> {
  if (!channel?.messages?.fetch) return null;
  const fetched = await channel.messages
    .fetch({ limit: 100 })
    .catch(() => null);
  if (!fetched) return null;

  const messages = Array.from(fetched.values()).sort(
    (a, b) => (b.createdTimestamp ?? 0) - (a.createdTimestamp ?? 0)
  );

  let midBlocks: string | null = null;
  let gamePlan: string | null = null;
  let raw: string | null = null;

  for (const message of messages) {
    const parsed = parsePlanText(message.content ?? "");
    if (parsed.confidence === "none") continue;

    if (!midBlocks && parsed.midBlocks) midBlocks = parsed.midBlocks;
    if (!gamePlan && parsed.gamePlan) gamePlan = parsed.gamePlan;
    if (!raw) raw = parsed.raw ?? message.content ?? null;

    if (midBlocks && gamePlan) break;
  }

  if (!midBlocks && !gamePlan && !raw) return null;
  return {
    midBlocks,
    gamePlan,
    raw: midBlocks && gamePlan ? null : raw,
    source: "CHANNEL",
    capturedAt: new Date(),
  };
}

function mergePlans(
  dmPlan: TeamPlanRecord | undefined,
  channelPlan: TeamPlanRecord | null
): TeamPlanRecord | null {
  if (!dmPlan && !channelPlan) return null;
  if (channelPlan && channelPlan.midBlocks && channelPlan.gamePlan) {
    return channelPlan;
  }
  if (channelPlan && (channelPlan.midBlocks || channelPlan.gamePlan)) {
    const merged = {
      midBlocks: channelPlan.midBlocks ?? dmPlan?.midBlocks ?? null,
      gamePlan: channelPlan.gamePlan ?? dmPlan?.gamePlan ?? null,
      raw: channelPlan.raw ?? dmPlan?.raw ?? null,
      source: dmPlan ? "MIXED" : "CHANNEL",
      capturedAt: new Date(),
    };
    return merged;
  }
  if (dmPlan) {
    return {
      ...dmPlan,
      source: dmPlan.source === "MIXED" ? "MIXED" : "DM",
      capturedAt: new Date(),
    };
  }
  return channelPlan;
}

export async function assignTeamVCAfterPicking(
  guild: Guild,
  memberCache?: Map<string, GuildMember>
) {
  const config = ConfigManager.getConfig();
  const blueTeamRoleId = config.roles.blueTeamRole;
  const redTeamRoleId = config.roles.redTeamRole;

  const gameInstance = GameInstance.getInstance();
  const cache = memberCache ?? new Map<string, GuildMember>();

  const moveTeam = async (
    team: "RED" | "BLUE",
    vcId: string,
    roleId: string
  ) => {
    const players = gameInstance.getPlayersOfTeam(team);
    for (const player of players) {
      const member = await getCachedMember(
        guild,
        cache,
        player.discordSnowflake
      );
      if (!member) continue;
      await DiscordUtil.moveToVC(
        guild,
        vcId,
        roleId,
        player.discordSnowflake,
        member
      );
    }
  };

  try {
    await Promise.all([
      moveTeam("RED", config.channels.redTeamVC, redTeamRoleId),
      moveTeam("BLUE", config.channels.blueTeamVC, blueTeamRoleId),
    ]);
    console.log("Finished assigning players to team voice channels.");
  } catch (error) {
    console.error("Unexpected error during team VC assignment:", error);
  }
}

export async function assignTeamRolesAfterPicking(
  guild: Guild,
  memberCache?: Map<string, GuildMember>
) {
  const config = ConfigManager.getConfig();
  const blueTeamRoleId = config.roles.blueTeamRole;
  const redTeamRoleId = config.roles.redTeamRole;
  const gameInstance = GameInstance.getInstance();

  const BATCH_SIZE = 5;
  const cache = memberCache ?? new Map<string, GuildMember>();

  async function assignRolesForTeam(team: "RED" | "BLUE", roleId: string) {
    const players = gameInstance.getPlayersOfTeam(team);

    for (let i = 0; i < players.length; i += BATCH_SIZE) {
      const batch = players.slice(i, i + BATCH_SIZE);

      await Promise.allSettled(
        batch.map(async (player) => {
          const member = await getCachedMember(
            guild,
            cache,
            player.discordSnowflake
          );
          if (!member) return;
          await DiscordUtil.assignRole(member, roleId);
        })
      );
    }
  }

  try {
    await Promise.all([
      assignRolesForTeam("RED", redTeamRoleId),
      assignRolesForTeam("BLUE", blueTeamRoleId),
    ]);
    console.log("Roles assigned successfully for both teams.");
  } catch (error) {
    console.error("Error assigning roles after team picking:", error);
  }
}

export async function movePlayersToTeamPickingAfterGameEnd(guild: Guild) {
  try {
    const config = ConfigManager.getConfig();
    const teamPickingVCId = config.channels.teamPickingVC;

    const moveMembers = async (vcId: string) => {
      const voiceChannel = guild.channels.cache.get(vcId);
      if (voiceChannel && voiceChannel.isVoiceBased()) {
        for (const [, member] of voiceChannel.members) {
          try {
            await member.voice.setChannel(teamPickingVCId);
            console.log(
              `Moved ${member.user.tag} from ${voiceChannel.name} to Team Picking VC`
            );
          } catch (error) {
            console.error(
              `Failed to move ${member.user.tag} from ${voiceChannel.name}: `,
              error
            );
          }
        }
      }
    };

    await moveMembers(config.channels.blueTeamVC);
    await moveMembers(config.channels.redTeamVC);

    console.log("Completed cleaning up members.");
  } catch (error) {
    console.error("Failed to move members to vc:", error);
  }
}

async function buildMemberCache(
  guild: Guild,
  memberIds: string[]
): Promise<Map<string, GuildMember>> {
  const cache = new Map<string, GuildMember>();
  const uniqueIds = Array.from(new Set(memberIds));
  if (uniqueIds.length === 0) {
    return cache;
  }

  const missing: string[] = [];
  for (const id of uniqueIds) {
    const cached = guild.members.cache.get(id);
    if (cached) {
      cache.set(id, cached);
    } else {
      missing.push(id);
    }
  }

  const BATCH_SIZE = 10;
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const chunk = missing.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(
      chunk.map(async (id) => {
        const member = await fetchMemberWithTimeout(guild, id);
        if (member) {
          cache.set(id, member);
        }
      })
    );
  }

  return cache;
}

async function getCachedMember(
  guild: Guild,
  cache: Map<string, GuildMember>,
  id: string
): Promise<GuildMember | null> {
  const cached = cache.get(id) ?? guild.members.cache.get(id);
  if (cached) {
    cache.set(id, cached);
    return cached;
  }

  const member = await fetchMemberWithTimeout(guild, id);
  if (member) {
    cache.set(id, member);
    return member;
  } else {
    return null;
  }
}

async function fetchMemberWithTimeout(
  guild: Guild,
  id: string,
  timeoutMs = 3000
): Promise<GuildMember | null> {
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`fetch timeout for ${id}`));
    }, timeoutMs);
  });

  try {
    const member = (await Promise.race([
      guild.members.fetch(id),
      timeoutPromise,
    ])) as GuildMember;
    return member;
  } catch (error) {
    console.warn(`Failed to fetch member ${id} within ${timeoutMs}ms`, error);
    return null;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
