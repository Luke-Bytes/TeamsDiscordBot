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
import { GameInstance } from "../database/GameInstance";
import { prettifyName } from "../util/Utils";

type TeamKey = "RED" | "BLUE";

export type PlanMember = { id: string; ign: string };

type PlanSession = {
  captainId: string;
  team: TeamKey;
  members: PlanMember[];
  stage:
    | "awaitMessage"
    | "awaitConfirm"
    | "awaitLateMessage"
    | "awaitLateConfirm"
    | "sending"
    | "idle";
  lastContent?: string;
  hasSentPlan: boolean;
  pendingLateMembers: Set<string>;
  latePromptMessage?: Message;
  debugDeliveryHook?: (memberId: string, content: string) => void;
};

type StartSessionParams = {
  client: Client;
  captainId: string;
  team: TeamKey;
  teamList: string;
  members: PlanMember[];
};

export default class CaptainPlanDMManager {
  private sessions = new Map<string, PlanSession>();

  private buttonIdSet = new Set<string>();
  private debugHooks = new Map<
    string,
    (memberId: string, content: string) => void
  >();
  private deliveryLog = new Map<string, number>();
  private transport?: (
    memberId: string,
    content: string
  ) => Promise<boolean> | boolean;

  public get buttonIds(): string[] {
    return [...this.buttonIdSet];
  }

  public getDeliveryCount(memberId: string): number {
    return this.deliveryLog.get(memberId) ?? 0;
  }

  // Test helper: sends to all current members using the configured transport.
  public async __testSendAll(
    captainId: string
  ): Promise<{ failed: string[]; sentCount: number }> {
    const session = this.sessions.get(captainId);
    if (!session) throw new Error("No session");
    session.lastContent = session.lastContent ?? "";
    const result = await this.sendPlanToMembers({
      captainId,
      members: session.members.map((m) => m.id),
      content: session.lastContent,
      client: {} as Client,
    });
    session.hasSentPlan = true;
    return result;
  }

  // Test helper: sends to pending late members only.
  public async __testSendLate(
    captainId: string
  ): Promise<{ failed: string[]; sentCount: number }> {
    const session = this.sessions.get(captainId);
    if (!session) throw new Error("No session");
    session.lastContent = session.lastContent ?? "";
    const targetIds = session.members
      .filter((m) => session.pendingLateMembers.has(m.id))
      .map((m) => m.id);
    return this.sendPlanToMembers({
      captainId,
      members: targetIds,
      content: session.lastContent,
      client: {} as Client,
    });
  }

  public setDebugDeliveryHook(
    captainId: string,
    hook: (memberId: string, content: string) => void
  ): void {
    this.debugHooks.set(captainId, hook);
    const session = this.sessions.get(captainId);
    if (session) {
      session.debugDeliveryHook = hook;
    }
  }

  public setTransport(
    transport: (memberId: string, content: string) => Promise<boolean> | boolean
  ): void {
    this.transport = transport;
  }

  private addButtonsFor(captainId: string, mode: "initial" | "late") {
    if (mode === "initial") {
      this.buttonIdSet.add(`plan-confirm:${captainId}`);
    } else {
      this.buttonIdSet.add(`plan-confirm-all:${captainId}`);
      this.buttonIdSet.add(`plan-confirm-new:${captainId}`);
    }
    this.buttonIdSet.add(`plan-resend:${captainId}`);
  }

  private removeButtonsFor(captainId: string) {
    this.buttonIdSet.delete(`plan-confirm:${captainId}`);
    this.buttonIdSet.delete(`plan-confirm-all:${captainId}`);
    this.buttonIdSet.delete(`plan-confirm-new:${captainId}`);
    this.buttonIdSet.delete(`plan-resend:${captainId}`);
  }

  public async startForCaptain({
    client,
    captainId,
    team,
    teamList,
    members,
  }: StartSessionParams): Promise<void> {
    const dedupedMembers = this.mergeMembers([], members);
    this.sessions.set(captainId, {
      captainId,
      team,
      members: dedupedMembers,
      stage: "awaitMessage",
      hasSentPlan: false,
      pendingLateMembers: new Set(),
      debugDeliveryHook: this.debugHooks.get(captainId),
    });

    const template = this.buildTemplate(teamList);
    const context = this.getGameContextText();
    const intro = `Hi ${team} Captain! Reply to this DM with your team's plan filled in with the below format. I will then forward it to your team members.

`;
    const instructions =
      "When you reply, I'll show a preview and ask you to confirm before sending to your team.";

    const user = await client.users
      .fetch(captainId)
      .catch(() => null as User | null);

    if (user) {
      await this.safeSend(user, {
        content: `${intro}${context}\n\n${template}\n\n${instructions}`,
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
    return Boolean(
      session &&
        (session.stage === "awaitMessage" ||
          session.stage === "awaitLateMessage")
    );
  }

  public async handleDM(message: Message): Promise<boolean> {
    if (message.author.bot || message.guild) return false;

    const captainId = message.author.id;
    const session = this.sessions.get(captainId);
    if (
      !session ||
      (session.stage !== "awaitMessage" && session.stage !== "awaitLateMessage")
    )
      return false;

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
    const isLate = session.stage === "awaitLateMessage";
    session.stage = isLate ? "awaitLateConfirm" : "awaitConfirm";
    this.addButtonsFor(captainId, isLate ? "late" : "initial");

    const previewContent = this.buildPlanDeliveryContent(
      session.lastContent ?? ""
    );
    const row = isLate
      ? new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`plan-confirm-new:${captainId}`)
            .setLabel("Send to new joiners only")
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(`plan-confirm-all:${captainId}`)
            .setLabel("Send to all team members")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`plan-resend:${captainId}`)
            .setLabel("Let me send again")
            .setStyle(ButtonStyle.Secondary)
        )
      : new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`plan-confirm:${captainId}`)
            .setLabel("Confirm")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`plan-resend:${captainId}`)
            .setLabel("Let me send again")
            .setStyle(ButtonStyle.Secondary)
        );

    await this.safeSend(message.author, {
      content: `Preview:\n\n${previewContent}\n\nSend to ${session.team} team members?`,
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

      session.stage = "sending";
      await interaction.deferUpdate().catch(() => {});

      const { failed, sentCount } = await this.sendPlanToMembers({
        captainId,
        content: session.lastContent ?? "",
        members: session.members.map((m) => m.id),
        client: interaction.client,
      });

      await interaction
        .editReply({
          content: `Your plan has been sent to ${sentCount} team members${
            failed.length
              ? ` Failed to DM ${failed.length} of your team members.`
              : ""
          }`,
          components: [],
        })
        .catch(() => {});

      session.hasSentPlan = true;

      if (failed.length) {
        const channelKey =
          session.team === "RED" ? "redTeamChat" : "blueTeamChat";
        const mentions = failed.map((memberId) => `<@${memberId}>`).join(" ");
        await DiscordUtil.sendMessage(
          channelKey,
          `I couldn't DM the plan to: ${mentions} - Please enable DMs from server members.`
        );
      }

      session.stage = "idle";
      session.pendingLateMembers.clear();
      this.removeButtonsFor(captainId);
      return;
    }

    if (
      id.startsWith("plan-confirm-all:") ||
      id.startsWith("plan-confirm-new:")
    ) {
      const captainId = id.split(":")[1];
      const session = this.sessions.get(captainId);
      if (!session || session.stage !== "awaitLateConfirm") {
        await interaction.deferUpdate().catch(() => {});
        return;
      }

      session.stage = "sending";
      await interaction.deferUpdate().catch(() => {});

      const targetIds = id.startsWith("plan-confirm-new:")
        ? session.members
            .filter((m) => session.pendingLateMembers.has(m.id))
            .map((m) => m.id)
        : session.members.map((m) => m.id);

      const { failed, sentCount } = await this.sendPlanToMembers({
        captainId,
        content: session.lastContent ?? "",
        members: targetIds,
        client: interaction.client,
      });

      await interaction
        .editReply({
          content: `Your updated plan has been sent to ${sentCount} team members${
            failed.length
              ? ` Failed to DM ${failed.length} of your team members.`
              : ""
          }`,
          components: [],
        })
        .catch(() => {});

      if (failed.length) {
        const channelKey =
          session.team === "RED" ? "redTeamChat" : "blueTeamChat";
        const mentions = failed.map((memberId) => `<@${memberId}>`).join(" ");
        await DiscordUtil.sendMessage(
          channelKey,
          `I couldn't DM the plan to: ${mentions} - Please enable DMs from server members.`
        );
      }

      session.stage = "idle";
      session.pendingLateMembers.clear();
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

      session.stage =
        session.pendingLateMembers.size > 0 && session.hasSentPlan
          ? "awaitLateMessage"
          : "awaitMessage";
      session.lastContent = undefined;
      this.removeButtonsFor(captainId);

      await interaction.update({
        content: "Okay! Send me your updated plan here again when ready.",
        components: [],
      });
      return;
    }
  }

  public async handleRosterUpdate(params: {
    captainId: string;
    team: TeamKey;
    members: PlanMember[];
    newJoiners: PlanMember[];
    client: Client;
  }): Promise<void> {
    const { captainId, team, members, newJoiners, client } = params;
    const session = this.sessions.get(captainId);
    if (!session) return;

    const previousMembers = new Map(session.members.map((m) => [m.id, m.ign]));
    session.members = this.mergeMembers([], members);
    for (const pendingId of Array.from(session.pendingLateMembers)) {
      if (!session.members.find((m) => m.id === pendingId)) {
        session.pendingLateMembers.delete(pendingId);
      }
    }

    const trulyNew = newJoiners.filter(
      (m) => !previousMembers.has(m.id) && m.id !== captainId
    );
    if (!trulyNew.length) {
      return;
    }

    if (!session.hasSentPlan) {
      return;
    }

    trulyNew.forEach((m) => session.pendingLateMembers.add(m.id));

    const user = await client.users
      .fetch(captainId)
      .catch(() => null as User | null);
    if (!user) return;

    const teamList = this.buildTemplate(this.formatTeamList(session.members));
    const newIgns = trulyNew.map((m) => m.ign).join(", ");
    const context = this.getGameContextText();

    const promptContent = `New teammate(s) joined your ${team} team: ${newIgns}\n\n${context}\n\nReply with your updated plan below.\n${teamList}\n\nWhen you reply, you can send it to everyone or only the new joiners.`;

    if (
      session.stage === "awaitLateMessage" ||
      session.stage === "awaitLateConfirm"
    ) {
      if (session.latePromptMessage) {
        const edited = await session.latePromptMessage
          .edit({ content: promptContent })
          .catch(() => null);
        if (!edited) {
          const msg = await this.safeSend(user, {
            content: promptContent,
          });
          if (msg) {
            session.latePromptMessage = msg;
          }
        }
      } else {
        const msg = await this.safeSend(user, {
          content: promptContent,
        });
        if (msg) {
          session.latePromptMessage = msg;
        }
      }
      return;
    }

    session.stage = "awaitLateMessage";
    const prompt = await this.safeSend(user, {
      content: promptContent,
    });
    if (prompt) {
      session.latePromptMessage = prompt;
    }
  }

  private mergeMembers(
    current: PlanMember[],
    incoming: PlanMember[]
  ): PlanMember[] {
    const merged = new Map<string, PlanMember>();
    for (const member of [...current, ...incoming]) {
      merged.set(member.id, { id: member.id, ign: member.ign });
    }
    return Array.from(merged.values());
  }

  private formatTeamList(members: PlanMember[]): string {
    return members.map((member) => member.ign).join("\n");
  }

  private buildTemplate(teamList: string): string {
    return `**Mid Blocks Plan**\n\`\`\`\n${teamList}\n\`\`\`\n**Game Plan**\n\`\`\`\n${teamList}\n\`\`\``;
  }

  private getGameContextText(): string {
    return `${this.getMapContextText()}\n${this.getClassBansContextText()}`;
  }

  private getMapContextText(): string {
    const game = GameInstance.getInstance();

    const decidedMap = game.settings.map;
    if (decidedMap) {
      return `**Map:** ${prettifyName(decidedMap)}`;
    }

    const polledMaps = game.mapVoteManager?.maps ?? [];
    if (polledMaps.length) {
      return `**Map Poll Options:** ${polledMaps.map(prettifyName).join(", ")}`;
    }

    return "**Map:** Not decided yet";
  }

  private getClassBansContextText(): string {
    const game = GameInstance.getInstance();

    const limit = game.getClassBanLimit();
    const used = game.getTotalCaptainBans();
    const mode = game.classBanMode;
    const modifierLabel =
      game.settings.modifiers?.find((m) => m.category === "Class Bans")?.name ??
      null;

    const organiserBans = game.settings.organiserBannedClasses ?? [];
    const sharedCaptainBans = game.settings.sharedCaptainBannedClasses ?? [];
    game.settings.nonSharedCaptainBannedClasses ??= {
      RED: [],
      BLUE: [],
    } as any;
    const byTeam = game.settings.nonSharedCaptainBannedClasses as any as {
      RED: unknown[];
      BLUE: unknown[];
    };

    const sharedBaseSet = new Set([...organiserBans, ...sharedCaptainBans]);

    let banType: string;
    if (modifierLabel) {
      banType = modifierLabel;
    } else if (limit <= 0) {
      banType = "No Bans";
    } else if (mode === "shared") {
      banType = "Captain Bans (Shared)";
    } else if (mode === "opponentOnly") {
      banType = "Captain Bans (Opponent Only)";
    } else {
      banType = "Captain Bans";
    }

    let sharedBans: unknown[] = [];
    let redCantUse: unknown[] = [];
    let blueCantUse: unknown[] = [];

    if (mode === "shared") {
      sharedBans = Array.from(
        new Set([
          ...sharedBaseSet,
          ...(byTeam.RED ?? []),
          ...(byTeam.BLUE ?? []),
        ])
      );
    } else {
      sharedBans = Array.from(sharedBaseSet);
      redCantUse = (byTeam.RED ?? []).filter(
        (c: unknown) => !sharedBaseSet.has(c as any)
      );
      blueCantUse = (byTeam.BLUE ?? []).filter(
        (c: unknown) => !sharedBaseSet.has(c as any)
      );
    }

    const header =
      limit > 0
        ? `**Class Bans:** ${banType} (${used}/${limit})`
        : `**Class Bans:** ${banType}`;

    const sharedLine = `Shared: ${
      sharedBans.length
        ? sharedBans.map((c) => prettifyName(String(c))).join(", ")
        : "None"
    }`;
    const redLine = `Red can't use: ${
      redCantUse.length
        ? redCantUse.map((c) => prettifyName(String(c))).join(", ")
        : "None"
    }`;
    const blueLine = `Blue can't use: ${
      blueCantUse.length
        ? blueCantUse.map((c) => prettifyName(String(c))).join(", ")
        : "None"
    }`;

    return `${header}\n${sharedLine}\n${redLine}\n${blueLine}`;
  }

  private buildPlanDeliveryContent(planText: string): string {
    const header = this.getGameContextText();
    return `${header}\n\n${planText}`;
  }

  private async safeSend(
    user: User,
    payload: string | MessageCreateOptions
  ): Promise<Message | null> {
    try {
      if (typeof payload === "string") {
        return await user.send(payload);
      }
      return await user.send(payload);
    } catch {
      // No-op: DM failures shouldn't crash the flow.
      return null;
    }
  }

  private async sendPlanToMembers(params: {
    captainId: string;
    members: string[];
    content: string;
    client: Client;
  }): Promise<{ failed: string[]; sentCount: number }> {
    const { captainId, members, content, client } = params;
    const failed: string[] = [];
    const hook = this.debugHooks.get(captainId);
    const uniqueTargets = Array.from(new Set(members));
    const deliveryContent = this.buildPlanDeliveryContent(content);

    for (const memberId of uniqueTargets) {
      if (memberId === captainId) continue;
      if (this.transport) {
        const result = await this.transport(memberId, deliveryContent);
        if (result) {
          this.deliveryLog.set(
            memberId,
            (this.deliveryLog.get(memberId) ?? 0) + 1
          );
        } else {
          failed.push(memberId);
        }
        continue;
      }

      if (hook) {
        hook(memberId, deliveryContent);
        this.deliveryLog.set(
          memberId,
          (this.deliveryLog.get(memberId) ?? 0) + 1
        );
        continue; // In test mode, trust hook and skip real DM.
      }
      try {
        const user = await client.users
          .fetch(memberId)
          .catch(() => null as User | null);
        if (!user) {
          failed.push(memberId);
          continue;
        }
        const sent = await this.safeSend(user, deliveryContent);
        if (!sent) {
          failed.push(memberId);
          continue;
        }
        this.deliveryLog.set(
          memberId,
          (this.deliveryLog.get(memberId) ?? 0) + 1
        );
      } catch {
        failed.push(memberId);
      }
    }

    const sentCount =
      uniqueTargets.filter((id) => id !== captainId).length - failed.length;
    return { failed, sentCount };
  }
}
