import { randomUUID } from "crypto";
import { ConfigManager } from "../ConfigManager";
import { syncEventDiscord } from "../logic/EventDiscordSync";
import { regularEventSignupOpen } from "../logic/EventPolicy";
import {
  AttachmentBuilder,
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { Command } from "./CommandInterface";
import { PermissionsUtil } from "../util/PermissionsUtil";
import {
  eventService,
  eventQuestions,
  EventQuestion,
} from "../logic/EventService";
import { eventCsvCell, eventDisplay, eventPages } from "./EventPresentation";
import {
  eventDeletePrompt,
  handleEventDeleteButton,
} from "./EventDeleteConfirmation";

function date(value: string | null): Date | null | undefined {
  if (value === null) return undefined;
  if (value === "none") return null;
  if (
    !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(
      "Use an ISO date with a timezone, e.g. 2027-01-30T19:00:00Z, or none."
    );
  }
  return new Date(value);
}

export default class EventCommand implements Command {
  name = "event";
  description = "Configure standalone events and inspect sign-ups.";
  buttonIds = ["event_delete_confirm:", "event_delete_cancel:"];
  data = new SlashCommandBuilder()
    .setName(this.name)
    .setDescription(this.description);

  constructor() {
    for (const name of ["create", "edit"]) {
      this.data.addSubcommand((sub) => {
        sub.setName(name).setDescription(`${name} an event`);
        if (name === "edit")
          sub.addStringOption((o) =>
            o
              .setName("event")
              .setDescription("Event ID (defaults to current)")
              .setAutocomplete(true)
          );
        sub
          .addStringOption((o) =>
            o
              .setName("title")
              .setDescription("Event title")
              .setMaxLength(100)
              .setRequired(name === "create")
          )
          .addStringOption((o) =>
            o
              .setName("description")
              .setDescription("Event description")
              .setMaxLength(3000)
              .setRequired(name === "create")
          )
          .addStringOption((o) =>
            o
              .setName("terms")
              .setDescription("Terms players must accept (frozen on opening)")
              .setMaxLength(4000)
              .setRequired(name === "create")
          )
          .addStringOption((o) =>
            o
              .setName("starts-at")
              .setDescription("ISO date with timezone, or none")
          )
          .addStringOption((o) =>
            o
              .setName("deadline")
              .setDescription(
                "Regular sign-up ISO deadline with timezone, or none"
              )
          )
          .addIntegerOption((o) =>
            o
              .setName("capacity")
              .setDescription("Confirmed capacity; 0 means unlimited")
              .setMinValue(0)
          );
        return sub;
      });
    }
    for (const name of [
      "view",
      "preview",
      "open",
      "close",
      "reopen",
      "finish",
      "roster",
      "export",
      "response",
    ]) {
      this.data.addSubcommand((sub) => {
        sub.setName(name).setDescription(`${name} an event`);
        if (name === "response")
          sub.addUserOption((o) =>
            o
              .setName("player")
              .setDescription("Player whose answers to inspect")
              .setRequired(true)
          );
        sub.addStringOption((o) =>
          o
            .setName("event")
            .setDescription("Event ID (defaults to current)")
            .setAutocomplete(true)
        );
        return sub;
      });
    }
    this.data.addSubcommand((sub) =>
      sub
        .setName("delete")
        .setDescription("Permanently delete an unopened draft event")
        .addStringOption((o) =>
          o
            .setName("event")
            .setDescription("Draft event ID to delete")
            .setAutocomplete(true)
            .setRequired(true)
        )
    );
    this.data.addSubcommand((sub) =>
      sub.setName("list").setDescription("List current and historical events")
    );
    this.data.addSubcommandGroup((group) => {
      group
        .setName("question")
        .setDescription("Configure draft or closed event questions");
      for (const action of ["add", "edit", "remove", "move"]) {
        group.addSubcommand((sub) => {
          sub.setName(action).setDescription(`${action} an event question`);
          if (action !== "add")
            sub.addIntegerOption((o) =>
              o
                .setName("number")
                .setDescription("Question number, starting at 1")
                .setMinValue(1)
                .setRequired(true)
            );
          if (action === "move")
            sub.addIntegerOption((o) =>
              o
                .setName("position")
                .setDescription("New position starting at 1")
                .setMinValue(1)
                .setRequired(true)
            );
          if (action === "add" || action === "edit") {
            sub
              .addStringOption((o) =>
                o
                  .setName("label")
                  .setDescription("Question text")
                  .setMaxLength(200)
                  .setRequired(action === "add")
              )
              .addStringOption((o) =>
                o
                  .setName("type")
                  .setDescription("Answer type")
                  .setRequired(action === "add")
                  .addChoices(
                    { name: "Short text", value: "SHORT_TEXT" },
                    { name: "Long text", value: "LONG_TEXT" },
                    { name: "Single choice", value: "SINGLE_CHOICE" },
                    { name: "Multiple choice", value: "MULTI_CHOICE" }
                  )
              )
              .addBooleanOption((o) =>
                o
                  .setName("required")
                  .setDescription("Require an answer (default true)")
              )
              .addStringOption((o) =>
                o
                  .setName("options")
                  .setDescription(
                    "Choice options separated by |; at most 25, each at most 100 characters"
                  )
                  .setMaxLength(2600)
              );
          }
          return sub.addStringOption((o) =>
            o
              .setName("event")
              .setDescription("Event ID (defaults to current)")
              .setAutocomplete(true)
          );
        });
      }
      return group;
    });
  }

  async handleAutocomplete(i: AutocompleteInteraction): Promise<void> {
    if (
      !i.guildId ||
      !PermissionsUtil.hasRole(
        i.guild?.members.cache.get(i.user.id),
        "organiserRole"
      )
    ) {
      await i.respond([]);
      return;
    }
    const query = i.options.getFocused().toLowerCase();
    const events = await eventService.list(i.guildId);
    await i.respond(
      events
        .filter((e) => `${e.title} ${e.id}`.toLowerCase().includes(query))
        .slice(0, 25)
        .map((e) => ({
          name: `${e.title} (${e.state})`.slice(0, 100),
          value: e.id,
        }))
    );
  }

  async execute(i: ChatInputCommandInteraction): Promise<void> {
    if (!(await PermissionsUtil.isUserAuthorised(i)) || !i.guildId) return;
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const guildId = i.guildId;
      const action = i.options.getSubcommand();
      const id = i.options.getString("event") ?? undefined;
      if (action === "list") {
        const events = await eventService.list(guildId);
        await this.respond(
          i,
          events
            .map((e) => `${eventDisplay(e.title)} — ${e.state}\nID: ${e.id}`)
            .join("\n\n") || "No events yet."
        );
        return;
      }
      if (
        action === "create" ||
        (action === "edit" && !i.options.getSubcommandGroup())
      ) {
        const patch = {
          ...(i.options.getString("title") !== null
            ? { title: i.options.getString("title", true) }
            : {}),
          ...(i.options.getString("description") !== null
            ? { description: i.options.getString("description", true) }
            : {}),
          ...(i.options.getString("terms") !== null
            ? { terms: i.options.getString("terms", true) }
            : {}),
          ...(i.options.getString("starts-at") !== null
            ? { startsAt: date(i.options.getString("starts-at")) }
            : {}),
          ...(i.options.getString("deadline") !== null
            ? { signupDeadline: date(i.options.getString("deadline")) }
            : {}),
          ...(i.options.getInteger("capacity") !== null
            ? { capacity: i.options.getInteger("capacity") || null }
            : {}),
        };
        const event =
          action === "create"
            ? await eventService.create(guildId, i.user.id, {
                title: i.options.getString("title", true),
                description: i.options.getString("description", true),
                terms: i.options.getString("terms", true),
                ...patch,
              })
            : await eventService.update(
                guildId,
                (await eventService.get(guildId, id)).id,
                patch
              );
        await syncEventDiscord(i.client, guildId);
        await this.respond(
          i,
          `Saved ${eventDisplay(event.title)}. Event ID: ${event.id}`
        );
        return;
      }
      const event = await eventService.get(guildId, id);
      if (action === "delete") {
        if (event.state !== "DRAFT" || event.openedAt)
          throw new Error("Only unopened draft events can be deleted.");
        await i.editReply(eventDeletePrompt(guildId, i.user.id, event));
        return;
      }
      if (i.options.getSubcommandGroup() === "question") {
        const questions = eventQuestions(event);
        const index = (i.options.getInteger("number") ?? 1) - 1;
        if (action !== "add" && !questions[index])
          throw new Error("Question number does not exist.");
        if (action === "remove") questions.splice(index, 1);
        else if (action === "move") {
          const position = i.options.getInteger("position", true) - 1;
          if (position >= questions.length)
            throw new Error("Position is outside this form.");
          questions.splice(position, 0, questions.splice(index, 1)[0]);
        } else {
          const previous = action === "edit" ? questions[index] : undefined;
          const q: EventQuestion = {
            id: previous?.id ?? randomUUID(),
            label: i.options.getString("label") ?? previous?.label ?? "",
            type: (i.options.getString("type") ??
              previous?.type ??
              "SHORT_TEXT") as EventQuestion["type"],
            required:
              i.options.getBoolean("required") ?? previous?.required ?? true,
            options:
              i.options
                .getString("options")
                ?.split("|")
                .map((x) => x.trim()) ?? previous?.options,
          };
          if (q.type.endsWith("TEXT")) delete q.options;
          if (action === "add") questions.push(q);
          else questions[index] = q;
        }
        await eventService.setQuestions(guildId, event.id, questions);
        await this.respond(
          i,
          event.state === "CLOSED"
            ? "Questions saved. Use /event preview, then /event reopen when ready."
            : "Questions saved. Use /event preview before opening."
        );
        return;
      }
      if (["open", "close", "reopen", "finish"].includes(action)) {
        if (action === "open") {
          const config = ConfigManager.getConfig();
          const channel = config.channels.eventSignUps
            ? await i.guild!.channels.fetch(config.channels.eventSignUps)
            : null;
          const role = config.roles.eventParticipantRole
            ? await i.guild!.roles.fetch(config.roles.eventParticipantRole)
            : null;
          if (
            !channel ||
            !channel.isTextBased() ||
            !role ||
            role.id === i.guildId ||
            role.managed ||
            !role.editable
          )
            throw new Error(
              "Configure an event text channel and a participant role the bot can manage before opening."
            );
          await eventService.open(guildId, event.id);
        }
        if (action === "close") await eventService.close(guildId, event.id);
        if (action === "reopen") await eventService.reopen(guildId, event.id);
        if (action === "finish") await eventService.finish(guildId, event.id);
        await syncEventDiscord(i.client, guildId);
        await this.respond(i, `Event ${action} completed.`);
        return;
      }
      const rows = await eventService.roster(guildId, event.id);
      if (action === "export") {
        const questions = eventQuestions(event);
        const csv = [
          [
            "Discord ID",
            "Minecraft username",
            "Minecraft UUID",
            "Status",
            "Terms accepted",
            "Queued at",
            ...questions.map((q) => q.label),
          ],
          ...rows.map((r) => [
            r.discordUserId,
            r.minecraftUsername,
            r.minecraftUUID,
            r.status,
            r.acceptedTermsAt.toISOString(),
            r.queuedAt.toISOString(),
            ...questions.map(
              (q) => (r.answers as Record<string, unknown>)[q.id] ?? ""
            ),
          ]),
        ]
          .map((row) => row.map(eventCsvCell).join(","))
          .join("\r\n");
        await i.editReply({
          content: "Private event export.",
          files: [
            new AttachmentBuilder(Buffer.from(csv), {
              name: `event-${event.id}.csv`,
            }),
          ],
        });
        return;
      }
      if (action === "roster") {
        await this.respond(
          i,
          rows
            .map(
              (r) =>
                `${eventDisplay(r.minecraftUsername)} — ${r.status} (${r.discordUserId})`
            )
            .join("\n") || "No sign-ups."
        );
        return;
      }
      if (action === "response") {
        const row = rows.find(
          (r) => r.discordUserId === i.options.getUser("player", true).id
        );
        if (!row)
          throw new Error("That player has no submission for this event.");
        await this.respond(
          i,
          `${eventDisplay(row.minecraftUsername)} — ${row.status}\nTerms accepted: ${row.acceptedTermsAt.toISOString()}\n${eventQuestions(
            event
          )
            .map(
              (q) =>
                `${eventDisplay(q.label)}: ${eventDisplay(String((row.answers as Record<string, unknown>)[q.id] ?? "(blank)"))}`
            )
            .join("\n")}`
        );
        return;
      }
      await this.respond(
        i,
        `${eventDisplay(event.title)} — ${event.state}\nRegular sign-ups: ${regularEventSignupOpen({ ...event, state: event.state as "DRAFT" | "OPEN" | "CLOSED" | "FINISHED" }, rows.filter((r) => r.status === "CONFIRMED").length, new Date()) ? "Open" : "Closed"}\n${eventDisplay(event.description)}\nEvent ID: ${event.id}\nStarts: ${event.startsAt ? `<t:${Math.floor(event.startsAt.getTime() / 1000)}:F>` : "Not set"}\nCapacity: ${event.capacity ?? "Unlimited"}\nRegular deadline: ${event.signupDeadline ? `<t:${Math.floor(event.signupDeadline.getTime() / 1000)}:F>` : "None"}\n\nQuestions:\n${eventQuestions(
          event
        )
          .map(
            (q, n) =>
              `${n + 1}. ${eventDisplay(q.label)} (${q.type}, ${q.required ? "required" : "optional"})${q.options ? `\n${q.options.map(eventDisplay).join(" | ")}` : ""}`
          )
          .join("\n")}\n\nTerms:\n${eventDisplay(event.terms)}`
      );
    } catch (error) {
      await i.editReply({
        content:
          error instanceof Error ? error.message : "Event operation failed.",
        allowedMentions: { parse: [] },
      });
    }
  }
  async handleButtonPress(i: ButtonInteraction): Promise<void> {
    await handleEventDeleteButton(i);
  }

  private async respond(i: ChatInputCommandInteraction, text: string) {
    const pages = eventPages(text);
    await i.editReply({ content: pages[0], allowedMentions: { parse: [] } });
    for (const content of pages.slice(1))
      await i.followUp({
        content,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
  }
}
