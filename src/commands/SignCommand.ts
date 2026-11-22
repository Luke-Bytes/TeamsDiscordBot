import { randomUUID } from "crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { Command } from "./CommandInterface";
import { ConfigManager } from "../ConfigManager";
import {
  eventService,
  eventQuestions,
  EventAnswers,
  EventQuestion,
} from "../logic/EventService";
import { eventDisplay, eventPages } from "./EventPresentation";
import { syncEventDiscord } from "../logic/EventDiscordSync";
import { regularEventSignupOpen, EventLifecycle } from "../logic/EventPolicy";

type EventRecord = Awaited<ReturnType<typeof eventService.get>>;
type Session = {
  id: string;
  userId: string;
  guildId: string;
  channelId: string;
  event: EventRecord;
  questions: EventQuestion[];
  answers: EventAnswers;
  username?: string;
  index: number;
  reviewPage: number;
  expires: number;
  lastInteractionAt?: number;
  editing: boolean;
  reserveApplication: boolean;
  expectedSignupUpdatedAt?: Date;
};
type Component =
  | ButtonInteraction
  | StringSelectMenuInteraction
  | ModalSubmitInteraction;

export default class SignCommand implements Command {
  name = "sign";
  description = "Sign up for the current standalone event.";
  buttonIds = ["sign_"];
  selectMenuIds = ["sign_"];
  modalIds = ["sign_"];
  data = new SlashCommandBuilder()
    .setName(this.name)
    .setDescription(this.description)
    .addSubcommand((s) =>
      s
        .setName("up")
        .setDescription("Apply for the current event")
        .addStringOption((o) =>
          o
            .setName("minecraft-username")
            .setDescription("Required if you have not registered before")
            .setMaxLength(16)
        )
    )
    .addSubcommand((s) =>
      s.setName("edit").setDescription("Edit your current event answers")
    )
    .addSubcommand((s) =>
      s
        .setName("view")
        .setDescription("Privately view your current application")
    )
    .addSubcommand((s) =>
      s.setName("withdraw").setDescription("Withdraw your current application")
    );
  private sessions = new Map<string, Session>();

  async execute(i: ChatInputCommandInteraction): Promise<void> {
    if (
      !i.guildId ||
      i.channelId !== ConfigManager.getConfig().channels.eventSignUps
    ) {
      await i.reply({
        content: "Use this command in the configured event sign-up channel.",
      });
      return;
    }
    // Public command acknowledgement; private answers stay in ephemeral follow-ups.
    await i.deferReply();
    try {
      const event = await eventService.get(i.guildId);
      const roster = await eventService.roster(i.guildId, event.id);
      const row = roster.find((r) => r.discordUserId === i.user.id);
      const action = i.options.getSubcommand();
      if (action === "view") {
        if (!row) throw new Error("You have not applied for this event.");
        const text = `${eventDisplay(event.title)} — ${row.status}\nMinecraft: ${eventDisplay(row.minecraftUsername)}\n${eventQuestions(
          event
        )
          .map(
            (q) =>
              `${eventDisplay(q.label)}: ${eventDisplay(String((row.answers as EventAnswers)[q.id] ?? "(blank)"))}`
          )
          .join("\n")}`;
        const pages = eventPages(text);
        await i.editReply({
          content: "Your event application was sent to you privately.",
          allowedMentions: { parse: [] },
        });
        for (const content of pages)
          await i.followUp({
            content,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
          });
        return;
      }
      if (event.state === "DRAFT" || event.state === "FINISHED")
        throw new Error("This event is not accepting changes.");
      if (action === "withdraw") {
        if (!row || row.status === "WITHDRAWN")
          throw new Error("You do not have an active application.");
        await eventService.withdraw(i.guildId, event.id, i.user.id);
        await syncEventDiscord(i.client, i.guildId);
        await i.editReply({
          content: `<@${i.user.id}> has withdrawn from ${eventDisplay(event.title)}.`,
          allowedMentions: { parse: [] },
        });
        return;
      }
      if (action === "edit" && (!row || row.status === "WITHDRAWN"))
        throw new Error("Use /sign up to apply first.");
      if (action === "up" && row && row.status !== "WITHDRAWN")
        throw new Error(
          "You have already applied. Use /sign edit to correct your answers."
        );
      const identity = await eventService.identity(
        i.user.id,
        i.options.getString("minecraft-username") ?? undefined
      );
      for (const [key, session] of this.sessions)
        if (session.expires < Date.now() || session.userId === i.user.id)
          this.sessions.delete(key);
      const session: Session = {
        id: randomUUID(),
        userId: i.user.id,
        guildId: i.guildId,
        channelId: i.channelId,
        event,
        questions: eventQuestions(event),
        answers:
          row && row.status !== "WITHDRAWN"
            ? { ...(row.answers as EventAnswers) }
            : {},
        username: identity.username,
        index: 0,
        reviewPage: 0,
        expires: Date.now() + 30 * 60_000,
        editing: action === "edit",
        reserveApplication:
          action === "up" &&
          !regularEventSignupOpen(
            { ...event, state: event.state as EventLifecycle },
            roster.filter((r) => r.status === "CONFIRMED").length,
            new Date()
          ),
        expectedSignupUpdatedAt: row?.updatedAt,
      };
      this.sessions.set(session.id, session);
      await i.editReply({
        content:
          action === "edit"
            ? "Application editing opened. Check your private form to continue."
            : "Complete your private form to sign up.",
        allowedMentions: { parse: [] },
      });
      await i.followUp({
        ...this.page(session),
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      await i.editReply({
        content: "Unable to complete the event request. See the private error.",
        allowedMentions: { parse: [] },
      });
      await i.followUp({
        content:
          error instanceof Error ? error.message : "Unable to load event.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    }
  }

  private async session(i: Component): Promise<Session | undefined> {
    const id = i.customId.split(":")[1];
    const s = this.sessions.get(id);
    if (
      !s ||
      s.expires < Date.now() ||
      s.userId !== i.user.id ||
      s.guildId !== i.guildId ||
      s.channelId !== i.channelId ||
      s.channelId !== ConfigManager.getConfig().channels.eventSignUps
    ) {
      await i.reply({
        content:
          "This form expired or belongs to another user. Start again with /sign up or /sign edit.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (s.lastInteractionAt && Date.now() - s.lastInteractionAt < 250) {
      await i.reply({
        content: "Please wait a moment before continuing.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    s.lastInteractionAt = Date.now();
    const current = await eventService.get(s.guildId);
    if (
      current.id !== s.event.id ||
      current.formRevision !== s.event.formRevision ||
      current.state === "FINISHED" ||
      current.state === "DRAFT"
    ) {
      this.sessions.delete(id);
      await i.reply({
        content: "This event form is no longer active. Start again.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    return s;
  }
  private button(
    s: Session,
    action: string,
    label: string,
    style = ButtonStyle.Secondary
  ) {
    return new ButtonBuilder()
      .setCustomId(`sign_${action}:${s.id}`)
      .setLabel(label)
      .setStyle(style);
  }
  private review(s: Session): string[] {
    return eventPages(
      `Review your application for ${eventDisplay(s.event.title)}\nMinecraft: ${eventDisplay(s.username ?? "")}\n\n${s.questions.map((q) => `${eventDisplay(q.label)}: ${eventDisplay(String(s.answers[q.id] ?? "(blank)"))}`).join("\n\n")}\n\nTerms you must agree to:\n${eventDisplay(s.event.terms)}\n\nRegular sign-ups may be closed or full. Submission may place you on the reserve list; reserves are promoted automatically in order until the event finishes.`,
      1600
    );
  }
  private page(s: Session) {
    const q = s.questions[s.index];
    const rows: Array<
      | ActionRowBuilder<ButtonBuilder>
      | ActionRowBuilder<StringSelectMenuBuilder>
    > = [];
    let content: string;
    if (q) {
      content = `${eventDisplay(s.event.title)}\nQuestion ${s.index + 1}/${s.questions.length} (${q.required ? "required" : "optional"})\n${eventDisplay(q.label)}\nCurrent answer: ${eventDisplay(String(s.answers[q.id] ?? "(blank)")).slice(0, 1000)}`;
      if (q.type.endsWith("CHOICE")) {
        const selected = s.answers[q.id];
        const values = Array.isArray(selected)
          ? selected
          : selected
            ? [selected]
            : [];
        rows.push(
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`sign_choice:${s.id}:${s.index}`)
              .setPlaceholder("Choose an answer")
              .setMinValues(q.required ? 1 : 0)
              .setMaxValues(q.type === "SINGLE_CHOICE" ? 1 : q.options!.length)
              .addOptions(
                q.options!.map((label, n) => ({
                  label,
                  value: String(n),
                  default: values.includes(label),
                }))
              )
          )
        );
      }
      const buttons = [
        this.button(s, "back", "Back").setDisabled(s.index === 0),
      ];
      if (q.type.endsWith("TEXT"))
        buttons.push(this.button(s, "answer", "Answer", ButtonStyle.Primary));
      if (!q.required) buttons.push(this.button(s, "clear", "Clear"));
      buttons.push(
        this.button(s, "next", "Next", ButtonStyle.Primary),
        this.button(s, "cancel", "Cancel")
      );
      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons));
    } else {
      const pages = this.review(s);
      s.reviewPage = Math.min(s.reviewPage, pages.length - 1);
      content = `${pages[s.reviewPage]}\n\nReview page ${s.reviewPage + 1}/${pages.length}`;
      rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.button(s, "back", "Edit answers").setDisabled(
            !s.questions.length
          ),
          this.button(s, "prevreview", "Previous").setDisabled(
            s.reviewPage === 0
          ),
          this.button(s, "nextreview", "Next").setDisabled(
            s.reviewPage === pages.length - 1
          ),
          this.button(
            s,
            "submit",
            "Agree & submit",
            ButtonStyle.Success
          ).setDisabled(s.reviewPage !== pages.length - 1),
          this.button(s, "cancel", "Cancel")
        )
      );
    }
    if (s.reserveApplication)
      content = `Regular sign-ups were closed or full when you started. This is a reserve application; final status is checked again on submission.\n\n${content}`;
    return { content, components: rows, allowedMentions: { parse: [] as [] } };
  }
  async handleButtonPress(i: ButtonInteraction): Promise<void> {
    try {
      const s = await this.session(i);
      if (!s) return;
      const action = i.customId.split(":")[0].slice(5);
      const q = s.questions[s.index];
      if (action === "answer" && q) {
        const modal = new ModalBuilder()
          .setCustomId(`sign_text:${s.id}:${s.index}`)
          .setTitle("Event answer");
        const text = new TextInputBuilder()
          .setCustomId("answer")
          .setLabel(q.label.slice(0, 45))
          .setStyle(
            q.type === "LONG_TEXT"
              ? TextInputStyle.Paragraph
              : TextInputStyle.Short
          )
          .setMaxLength(1000)
          .setRequired(q.required);
        const saved = s.answers[q.id];
        if (typeof saved === "string" && saved) text.setValue(saved);
        modal.addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(text)
        );
        await i.showModal(modal);
        return;
      }
      if (action === "cancel") {
        this.sessions.delete(s.id);
        await i.update({
          content: "Application cancelled. Saved submissions were not changed.",
          components: [],
        });
        return;
      }
      if (action === "submit") {
        if (
          s.index < s.questions.length ||
          s.reviewPage !== this.review(s).length - 1
        )
          throw new Error("Review all pages before submitting.");
        await i.deferUpdate();
        const result = await eventService.signup(
          s.guildId,
          s.event.id,
          s.userId,
          {
            answers: s.answers,
            formRevision: s.event.formRevision,
            editing: s.editing,
            expectedSignupUpdatedAt: s.expectedSignupUpdatedAt,
            acceptedTerms: true,
            minecraftUsername: s.username,
          }
        );
        this.sessions.delete(s.id);
        await syncEventDiscord(i.client, s.guildId);
        await i.editReply({
          content: `Application saved: ${result.status}. Use /sign view, /sign edit or /sign withdraw to manage it.`,
          components: [],
          allowedMentions: { parse: [] },
        });
        // Only announce committed applications, never the player's answers.
        try {
          await i.followUp({
            content: `<@${s.userId}> ${s.editing ? "updated their application" : "signed up"} for ${eventDisplay(s.event.title)} — ${result.status}.`,
            allowedMentions: { parse: [] },
          });
        } catch (error) {
          console.warn("[events] Public sign-up notification failed", error);
        }
        return;
      }
      if (action === "next") {
        const answer = q && s.answers[q.id];
        if (
          q?.required &&
          (!answer ||
            (Array.isArray(answer) ? answer.length === 0 : !answer.trim()))
        )
          throw new Error("Answer this required question before continuing.");
        s.index = Math.min(s.index + 1, s.questions.length);
        s.reviewPage = 0;
      }
      if (action === "back") {
        s.index = Math.max(0, s.index - 1);
        s.reviewPage = 0;
      }
      if (action === "clear" && q && !q.required) delete s.answers[q.id];
      if (action === "prevreview") s.reviewPage = Math.max(0, s.reviewPage - 1);
      if (action === "nextreview")
        s.reviewPage = Math.min(this.review(s).length - 1, s.reviewPage + 1);
      await i.update(this.page(s));
    } catch (error) {
      await this.error(i, error);
    }
  }
  async handleSelectMenu(i: StringSelectMenuInteraction): Promise<void> {
    try {
      const s = await this.session(i);
      if (!s) return;
      if (Number(i.customId.split(":")[2]) !== s.index)
        throw new Error("This choice form is stale.");
      const q = s.questions[s.index];
      if (!q || !q.options)
        throw new Error("That question is no longer active.");
      const selected = i.values.map((value) => q.options![Number(value)]);
      if (selected.some((value) => value === undefined))
        throw new Error("Invalid choice.");
      s.answers[q.id] =
        q.type === "SINGLE_CHOICE" ? (selected[0] ?? "") : selected;
      await i.update(this.page(s));
    } catch (error) {
      await this.error(i, error);
    }
  }
  async handleModalSubmit(i: ModalSubmitInteraction): Promise<void> {
    try {
      const s = await this.session(i);
      if (!s) return;
      if (Number(i.customId.split(":")[2]) !== s.index)
        throw new Error("This answer form is stale.");
      const q = s.questions[s.index];
      if (!q || !q.type.endsWith("TEXT"))
        throw new Error("Invalid text question.");
      s.answers[q.id] = i.fields.getTextInputValue("answer").trim();
      if (i.isFromMessage()) await i.update(this.page(s));
      else await i.reply({ ...this.page(s), flags: MessageFlags.Ephemeral });
    } catch (error) {
      await this.error(i, error);
    }
  }
  private async error(i: Component, error: unknown) {
    const payload = {
      content:
        error instanceof Error
          ? error.message
          : "Unable to process event form.",
      allowedMentions: { parse: [] as [] },
    };
    if (i.deferred || i.replied)
      await i.followUp({ ...payload, flags: MessageFlags.Ephemeral });
    else await i.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }
}
