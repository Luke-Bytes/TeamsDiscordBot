import { randomUUID } from "crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  MessageFlags,
} from "discord.js";
import { StandaloneEvent } from "@prisma/client";
import { eventService } from "../logic/EventService";
import { fetchGuildMember } from "../util/DiscordFailures";
import { PermissionsUtil } from "../util/PermissionsUtil";
import { eventDisplay } from "./EventPresentation";

const CONFIRMATION_TTL_MS = 5 * 60_000;
interface PendingDeletion {
  guildId: string;
  userId: string;
  eventId: string;
  expiresAt: number;
}
const pending = new Map<string, PendingDeletion>();

export function eventDeletePrompt(
  guildId: string,
  userId: string,
  event: Pick<StandaloneEvent, "id" | "title">
) {
  for (const [key, value] of pending)
    if (value.expiresAt <= Date.now()) pending.delete(key);
  const token = randomUUID();
  pending.set(token, {
    guildId,
    userId,
    eventId: event.id,
    expiresAt: Date.now() + CONFIRMATION_TTL_MS,
  });
  return {
    content: `Delete draft **${eventDisplay(event.title)}** (ID: \`${event.id}\`)? This is permanent and cannot be undone.`,
    allowedMentions: { parse: [] as [] },
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`event_delete_confirm:${token}`)
          .setLabel("Delete draft")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`event_delete_cancel:${token}`)
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Secondary)
      ),
    ],
  };
}

export async function handleEventDeleteButton(
  i: ButtonInteraction
): Promise<void> {
  const match = /^event_delete_(confirm|cancel):([a-f0-9-]{36})$/.exec(
    i.customId
  );
  const request = match && pending.get(match[2]);
  if (
    !request ||
    request.expiresAt <= Date.now() ||
    request.guildId !== i.guildId ||
    request.userId !== i.user.id
  ) {
    await i.reply({
      content: "This confirmation has expired or belongs to another organiser.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (match![1] === "cancel") {
    pending.delete(match![2]);
    await i.update({ content: "Draft deletion cancelled.", components: [] });
    return;
  }

  // Consume before awaiting: two clicks must not start two deletions.
  pending.delete(match![2]);
  await i.deferUpdate();
  try {
    if (!i.guild) throw new Error("This action requires a server.");
    const member = await fetchGuildMember(i.guild, i.user.id);
    if (!member || !PermissionsUtil.hasRole(member, "organiserRole"))
      throw new Error("You no longer have permission to delete events.");

    await eventService.deleteDraft(request.guildId, request.eventId);
    await i.editReply({
      content: "Draft event deleted permanently.",
      components: [],
    });
  } catch (error) {
    pending.delete(match![2]);
    await i.editReply({
      content:
        error instanceof Error ? error.message : "Could not delete the draft.",
      components: [],
      allowedMentions: { parse: [] },
    });
  }
}
