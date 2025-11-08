import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  Client,
  Message,
  MessageCreateOptions,
  User,
} from "discord.js";
import { DiscordUtil } from "../util/DiscordUtil";
import { MessageSafetyUtil } from "../util/MessageSafetyUtil";

type TeamKey = "RED" | "BLUE";

type PlanSession = {
  captainId: string;
  team: TeamKey;
  members: string[];
  stage: "awaitMessage" | "awaitConfirm";
  lastContent?: string;
};

type StartSessionParams = {
  client: Client;
  captainId: string;
  team: TeamKey;
  teamList: string;
  members: string[];
};

export default class CaptainPlanDMManager {
  private sessions = new Map<string, PlanSession>();

  private buttonIdSet = new Set<string>();

  public get buttonIds(): string[] {
    return [...this.buttonIdSet];
  }

  private addButtonsFor(captainId: string) {
    this.buttonIdSet.add(`plan-confirm:${captainId}`);
    this.buttonIdSet.add(`plan-resend:${captainId}`);
  }

  private removeButtonsFor(captainId: string) {
    this.buttonIdSet.delete(`plan-confirm:${captainId}`);
    this.buttonIdSet.delete(`plan-resend:${captainId}`);
  }

  public async startForCaptain({
    client,
    captainId,
    team,
    teamList,
    members,
  }: StartSessionParams): Promise<void> {
    this.sessions.set(captainId, {
      captainId,
      team,
      members,
      stage: "awaitMessage",
    });

    const template = `**Mid Blocks Plan**\n\`\`\`\n${teamList}\n\`\`\`\n**Game Plan**\n\`\`\`\n${teamList}\n\`\`\``;
    const intro = `Hi ${team} Captain! Reply to this DM with your team's plan filled in with the below format. I will then forward it to your team members.

`;
    const instructions =
      "When you reply, I'll show a preview and ask you to confirm before sending to your team.";

    const user = await client.users
      .fetch(captainId)
      .catch(() => null as User | null);

    if (user) {
      await this.safeSend(user, {
        content: `${intro}${template}\n\n${instructions}`,
      });
      return;
    }

    const channelKey = team === "RED" ? "redTeamChat" : "blueTeamChat";
    await DiscordUtil.sendMessage(
      channelKey,
      `**FAILED** to DM <@${captainId}> to collect the game plan. Please enable DMs from server members.`
    );
  }

  public hasPendingSession(userId: string): boolean {
    const session = this.sessions.get(userId);
    return Boolean(session && session.stage === "awaitMessage");
  }

  public async handleDM(message: Message): Promise<boolean> {
    if (message.author.bot || message.guild) return false;

    const captainId = message.author.id;
    const session = this.sessions.get(captainId);
    if (!session || session.stage !== "awaitMessage") return false;

    const trimmed = (message.content ?? "").trim();
    const hasAttachment = message.attachments.size > 0;

    const validation = MessageSafetyUtil.validateCaptainPlanMessage(
      trimmed,
      hasAttachment
    );

    if (!validation.valid) {
      await this.safeSend(message.author, {
        content: validation.feedback as string,
      });
      return true;
    }

    session.lastContent = message.content;
    session.stage = "awaitConfirm";
    this.addButtonsFor(captainId);

    const confirmBtn = new ButtonBuilder()
      .setCustomId(`plan-confirm:${captainId}`)
      .setLabel("Confirm")
      .setStyle(ButtonStyle.Success);
    const resendBtn = new ButtonBuilder()
      .setCustomId(`plan-resend:${captainId}`)
      .setLabel("Let me send again")
      .setStyle(ButtonStyle.Secondary);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      confirmBtn,
      resendBtn
    );

    await this.safeSend(message.author, {
      content: `Preview:\n\n${session.lastContent}\n\nSend to ${session.team} team members?`,
      components: [row],
    });
    return true;
  }

  public async handleButtonPress(
    interaction: ButtonInteraction
  ): Promise<void> {
    const id = interaction.customId;

    if (id.startsWith("plan-confirm:")) {
      const captainId = id.split(":")[1];
      const session = this.sessions.get(captainId);
      if (!session || session.stage !== "awaitConfirm") {
        await interaction.deferUpdate().catch(() => {});
        return;
      }

      const failed: string[] = [];
      const content = session.lastContent ?? "";

      for (const memberId of session.members) {
        if (memberId === captainId) continue;
        try {
          const user: User = await interaction.client.users.fetch(memberId);
          await user.send(content);
        } catch {
          failed.push(memberId);
        }
      }

      await interaction.update({
        content: `Your plan has been sent to ${session.members.length - 1} team members${
          failed.length
            ? ` Failed to DM ${failed.length} of your team members.`
            : ""
        }`,
        components: [],
      });

      if (failed.length) {
        const channelKey =
          session.team === "RED" ? "redTeamChat" : "blueTeamChat";
        const mentions = failed.map((memberId) => `<@${memberId}>`).join(" ");
        await DiscordUtil.sendMessage(
          channelKey,
          `I couldn't DM the plan to: ${mentions} - Please enable DMs from server members.`
        );
      }

      this.sessions.delete(captainId);
      this.removeButtonsFor(captainId);
      return;
    }

    if (id.startsWith("plan-resend:")) {
      const captainId = id.split(":")[1];
      const session = this.sessions.get(captainId);
      if (!session) {
        await interaction.deferUpdate().catch(() => {});
        return;
      }

      session.stage = "awaitMessage";
      session.lastContent = undefined;
      this.removeButtonsFor(captainId);

      await interaction.update({
        content: "Okay! Send me your updated plan here again when ready.",
        components: [],
      });
      return;
    }
  }

  private async safeSend(
    user: User,
    payload: string | MessageCreateOptions
  ): Promise<void> {
    try {
      if (typeof payload === "string") {
        await user.send(payload);
      } else {
        await user.send(payload);
      }
    } catch {
      // No-op: DM failures shouldn't crash the flow.
    }
  }
}
