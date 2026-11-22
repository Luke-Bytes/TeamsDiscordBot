import { Prisma, StandaloneEvent, EventSignup } from "@prisma/client";
import { prismaClient } from "../database/prismaClient";
import { MojangAPI } from "../api/MojangAPI";
import {
  eventAdmissionStatus,
  regularEventSignupOpen,
  EventAdmissionPolicy,
} from "./EventPolicy";

export type EventQuestionType =
  | "SHORT_TEXT"
  | "LONG_TEXT"
  | "SINGLE_CHOICE"
  | "MULTI_CHOICE";
export interface EventQuestion {
  id: string;
  label: string;
  type: EventQuestionType;
  required: boolean;
  options?: string[];
}
export type EventAnswers = Record<string, string | string[]>;
export interface EventInput {
  title: string;
  description: string;
  terms: string;
  startsAt?: Date | null;
  capacity?: number | null;
  signupDeadline?: Date | null;
}
export interface EventApplication {
  answers: EventAnswers;
  formRevision: number;
  acceptedTerms: boolean;
  minecraftUsername?: string;
  editing?: boolean;
  expectedSignupUpdatedAt?: Date;
}
export function eventQuestions(
  event: Pick<StandaloneEvent, "questions">
): EventQuestion[] {
  return event.questions as unknown as EventQuestion[];
}
const policy = (event: StandaloneEvent) =>
  event as unknown as EventAdmissionPolicy;

export function validateEventQuestions(questions: EventQuestion[]): void {
  if (questions.length > 20)
    throw new Error("An event supports up to 20 questions.");
  const ids = new Set<string>();
  for (const q of questions) {
    if (!q.id || ids.has(q.id) || !q.label.trim() || q.label.length > 200)
      throw new Error(
        "Questions need unique IDs and labels of 1–200 characters."
      );
    ids.add(q.id);
    if (
      !["SHORT_TEXT", "LONG_TEXT", "SINGLE_CHOICE", "MULTI_CHOICE"].includes(
        q.type
      )
    )
      throw new Error("Unknown question type.");
    if (
      q.type.endsWith("CHOICE") &&
      (!q.options?.length ||
        q.options.length > 25 ||
        new Set(q.options).size !== q.options.length ||
        q.options.some((o) => !o.trim() || o.length > 100))
    )
      throw new Error(
        "Choice questions require 1–25 unique options of 1–100 characters."
      );
  }
}
export function validateEventAnswers(
  questions: EventQuestion[],
  answers: EventAnswers
): void {
  if (Object.keys(answers).some((id) => !questions.some((q) => q.id === id)))
    throw new Error("The form contains unknown answers.");
  for (const q of questions) {
    const value = answers[q.id];
    const empty =
      value === undefined ||
      (typeof value === "string" ? !value.trim() : value.length === 0);
    if (empty) {
      if (q.required) throw new Error(`Answer required: ${q.label}`);
      continue;
    }
    if (q.type === "MULTI_CHOICE") {
      if (
        !Array.isArray(value) ||
        new Set(value).size !== value.length ||
        value.some((v) => !q.options?.includes(v))
      )
        throw new Error(`Invalid choices: ${q.label}`);
    } else if (
      typeof value !== "string" ||
      value.length > 1000 ||
      (q.type === "SINGLE_CHOICE" && !q.options?.includes(value))
    )
      throw new Error(`Invalid answer: ${q.label}`);
  }
}

type EventTransaction = Parameters<
  Parameters<typeof prismaClient.$transaction>[0]
>[0];

export class EventService {
  constructor(private readonly db = prismaClient) {}
  private async transaction<T>(
    operation: (tx: EventTransaction) => Promise<T>
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.$transaction(operation);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (
          attempt >= 4 ||
          !["P2034", "P2002", "EVENT_CONFLICT"].includes(code ?? "")
        )
          throw error;
      }
    }
  }
  private async lock(tx: EventTransaction, guildId: string, eventId: string) {
    const event = await tx.standaloneEvent.findFirst({
      where: { id: eventId, guildId },
    });
    if (!event) throw new Error("Event not found in this server.");
    const result = await tx.standaloneEvent.updateMany({
      where: { id: event.id, revision: event.revision },
      data: { revision: { increment: 1 } },
    });
    if (result.count !== 1)
      throw Object.assign(new Error("Event changed; retry."), {
        code: "EVENT_CONFLICT",
      });
    return event;
  }
  async create(guildId: string, createdBy: string, input: EventInput) {
    this.validateMetadata(input);
    return this.db.standaloneEvent.create({
      data: { ...input, guildId, createdBy, questions: [] },
    });
  }
  async list(guildId: string) {
    return this.db.standaloneEvent.findMany({
      where: { guildId },
      orderBy: { createdAt: "desc" },
    });
  }
  async get(guildId: string, eventId?: string): Promise<StandaloneEvent> {
    const id =
      eventId ??
      (await this.db.eventGuildState.findUnique({ where: { guildId } }))
        ?.currentEventId;
    if (!id) throw new Error("No current event has been opened.");
    const event = await this.db.standaloneEvent.findFirst({
      where: { id, guildId },
    });
    if (!event) throw new Error("Event not found in this server.");
    return event;
  }
  private validateMetadata(input: Partial<EventInput>) {
    for (const [key, max] of [
      ["title", 200],
      ["description", 4000],
      ["terms", 12000],
    ] as const) {
      if (
        input[key] !== undefined &&
        (!input[key]!.trim() || input[key]!.length > max)
      )
        throw new Error(`${key} must contain 1–${max} characters.`);
    }
    if (
      input.capacity != null &&
      (!Number.isInteger(input.capacity) || input.capacity < 1)
    )
      throw new Error("Capacity must be a positive whole number.");
    for (const date of [input.startsAt, input.signupDeadline])
      if (date && !Number.isFinite(date.getTime()))
        throw new Error("Invalid event date.");
  }
  async update(guildId: string, eventId: string, patch: Partial<EventInput>) {
    this.validateMetadata(patch);
    return this.transaction(async (tx) => {
      const event = await this.lock(tx, guildId, eventId);
      if (event.state === "FINISHED")
        throw new Error("Finished events cannot be edited.");
      if (patch.terms !== undefined && event.openedAt)
        throw new Error("Terms are frozen after opening.");
      if (
        patch.capacity != null &&
        patch.capacity <
          (await tx.eventSignup.count({
            where: { eventId, status: "CONFIRMED" },
          }))
      )
        throw new Error("Capacity cannot be below the confirmed count.");
      const updated = await tx.standaloneEvent.update({
        where: { id: eventId },
        data: patch,
      });
      await this.promote(tx, updated);
      return updated;
    });
  }
  async deleteDraft(guildId: string, eventId: string) {
    return this.transaction(async (tx) => {
      const event = await this.lock(tx, guildId, eventId);
      if (event.state !== "DRAFT" || event.openedAt)
        throw new Error("Only unopened draft events can be deleted.");
      const current = await tx.eventGuildState.findUnique({
        where: { guildId },
      });
      if (current?.currentEventId === eventId)
        throw new Error("The current event cannot be deleted.");
      if (await tx.eventSignup.count({ where: { eventId } }))
        throw new Error("Events with sign-ups cannot be deleted.");

      const result = await tx.standaloneEvent.deleteMany({
        where: {
          id: eventId,
          guildId,
          state: "DRAFT",
          openedAt: null,
          revision: event.revision + 1,
        },
      });
      if (result.count !== 1)
        throw Object.assign(new Error("Event changed; retry."), {
          code: "EVENT_CONFLICT",
        });
      return event;
    });
  }

  async setQuestions(
    guildId: string,
    eventId: string,
    questions: EventQuestion[]
  ) {
    validateEventQuestions(questions);
    return this.transaction(async (tx) => {
      const event = await this.lock(tx, guildId, eventId);
      if (event.openedAt || event.state !== "DRAFT")
        throw new Error("Questions are frozen after opening.");
      return tx.standaloneEvent.update({
        where: { id: eventId },
        data: {
          questions: questions as unknown as Prisma.InputJsonValue,
          formRevision: { increment: 1 },
        },
      });
    });
  }
  async open(guildId: string, eventId: string) {
    return this.transaction(async (tx) => {
      const event = await this.lock(tx, guildId, eventId);
      if (event.state !== "DRAFT")
        throw new Error("Only draft events can be opened.");
      validateEventQuestions(eventQuestions(event));
      const state = await tx.eventGuildState.upsert({
        where: { guildId },
        create: { guildId },
        update: { revision: { increment: 1 } },
      });
      if (state.currentEventId) {
        const current = await tx.standaloneEvent.findUnique({
          where: { id: state.currentEventId },
        });
        if (current && current.state !== "FINISHED")
          throw new Error("Finish the current event before opening another.");
      }
      await tx.eventGuildState.update({
        where: { guildId },
        data: { currentEventId: eventId },
      });
      return tx.standaloneEvent.update({
        where: { id: eventId },
        data: { state: "OPEN", openedAt: new Date() },
      });
    });
  }
  private async transition(guildId: string, eventId: string, state: string) {
    return this.transaction(async (tx) => {
      const event = await this.lock(tx, guildId, eventId);
      if (!["OPEN", "CLOSED"].includes(event.state))
        throw new Error("This event is not active.");
      const result = await tx.standaloneEvent.update({
        where: { id: eventId },
        data: {
          state,
          ...(state === "FINISHED" ? { finishedAt: new Date() } : {}),
        },
      });
      if (state === "FINISHED")
        await tx.eventSignup.updateMany({
          where: { eventId },
          data: { roleSyncPending: true, promotionPending: false },
        });
      else await this.promote(tx, result);
      return result;
    });
  }
  async close(guildId: string, eventId: string) {
    return this.transition(guildId, eventId, "CLOSED");
  }
  async reopen(guildId: string, eventId: string) {
    return this.transition(guildId, eventId, "OPEN");
  }
  async finish(guildId: string, eventId: string) {
    return this.transition(guildId, eventId, "FINISHED");
  }
  async roster(guildId: string, eventId?: string): Promise<EventSignup[]> {
    const event = await this.get(guildId, eventId);
    const rows = await this.db.eventSignup.findMany({
      where: { eventId: event.id },
      orderBy: [{ queuedAt: "asc" }, { id: "asc" }],
    });
    if (!["OPEN", "CLOSED"].includes(event.state)) return rows;

    // Active applications display the current linked account, even if another
    // registration workflow changed Player since the event was signed up for.
    // Finished events and withdrawn applications retain their saved history.
    const ids = rows
      .filter((row) => ["CONFIRMED", "RESERVE"].includes(row.status))
      .map((row) => row.discordUserId);
    if (!ids.length) return rows;
    const players = await this.db.player.findMany({
      where: { discordSnowflake: { in: ids } },
      select: {
        discordSnowflake: true,
        primaryMinecraftAccount: true,
        latestIGN: true,
      },
    });
    const byDiscord = new Map(players.map((p) => [p.discordSnowflake, p]));
    return rows.map((row) => {
      if (!["CONFIRMED", "RESERVE"].includes(row.status)) return row;
      const player = byDiscord.get(row.discordUserId);
      return MojangAPI.validUUID(player?.primaryMinecraftAccount) &&
        player?.latestIGN
        ? {
            ...row,
            minecraftUUID: player.primaryMinecraftAccount,
            minecraftUsername: player.latestIGN,
          }
        : row;
    });
  }
  async identity(
    userId: string,
    username?: string
  ): Promise<{ uuid: string; username: string }> {
    const player = await this.db.player.findUnique({
      where: { discordSnowflake: userId },
    });
    if (
      MojangAPI.validUUID(player?.primaryMinecraftAccount) &&
      player?.latestIGN &&
      (!username || username.toLowerCase() === player.latestIGN.toLowerCase())
    )
      return {
        uuid: player.primaryMinecraftAccount,
        username: player.latestIGN,
      };
    if (!username)
      throw new Error("Please provide your Minecraft username first.");
    const uuid = await MojangAPI.usernameToUUID(username);
    if (!uuid)
      throw new Error(
        "Could not verify that Minecraft username. Check its spelling or retry later."
      );
    if (
      player?.primaryMinecraftAccount &&
      player.primaryMinecraftAccount !== uuid
    )
      throw new Error("You already have a different linked Minecraft account.");
    const owner = await this.db.player.findFirst({
      where: {
        OR: [
          { primaryMinecraftAccount: uuid },
          { minecraftAccounts: { has: uuid } },
        ],
        NOT: { discordSnowflake: userId },
      },
    });
    if (owner)
      throw new Error(
        "That Minecraft account is already linked to another member."
      );
    // The existing Friendly Wars identity is authoritative. A supplied
    // alias may verify to the same UUID, but must not rename the Player.
    return {
      uuid,
      username:
        player?.primaryMinecraftAccount === uuid && player.latestIGN
          ? player.latestIGN
          : username,
    };
  }
  private async promote(
    tx: EventTransaction,
    event: StandaloneEvent,
    withdrawalPlaces = 0
  ) {
    if (!["OPEN", "CLOSED"].includes(event.state)) return;
    const count = await tx.eventSignup.count({
      where: { eventId: event.id, status: "CONFIRMED" },
    });
    const reserves = await tx.eventSignup.findMany({
      where: { eventId: event.id, status: "RESERVE" },
      orderBy: [{ queuedAt: "asc" }, { id: "asc" }],
    });
    const selected = reserves.slice(
      0,
      event.capacity === null
        ? regularEventSignupOpen(policy(event), count, new Date())
          ? reserves.length
          : withdrawalPlaces
        : Math.max(0, event.capacity - count)
    );
    if (selected.length)
      await tx.eventSignup.updateMany({
        where: { id: { in: selected.map((s) => s.id) } },
        data: {
          status: "CONFIRMED",
          confirmedAt: new Date(),
          roleSyncPending: true,
          promotionPending: true,
        },
      });
  }
  async signup(
    guildId: string,
    eventId: string,
    userId: string,
    application: EventApplication
  ) {
    const identity = await this.identity(userId, application.minecraftUsername);
    return this.transaction(async (tx) => {
      const event = await this.lock(tx, guildId, eventId);
      const current = await tx.eventGuildState.findUnique({
        where: { guildId },
      });
      if (current?.currentEventId !== eventId)
        throw new Error("This is no longer the current event.");
      if (!["OPEN", "CLOSED"].includes(event.state))
        throw new Error("This event is not accepting applications.");
      if (
        !application.acceptedTerms ||
        application.formRevision !== event.formRevision
      )
        throw new Error(
          "Review the current form and explicitly accept the terms."
        );
      validateEventAnswers(eventQuestions(event), application.answers);
      const owner = await tx.player.findFirst({
        where: {
          OR: [
            { primaryMinecraftAccount: identity.uuid },
            { minecraftAccounts: { has: identity.uuid } },
          ],
          NOT: { discordSnowflake: userId },
        },
      });
      if (owner)
        throw new Error(
          "That Minecraft account is already linked to another member."
        );
      const player = await tx.player.findUnique({
        where: { discordSnowflake: userId },
      });
      if (
        player?.primaryMinecraftAccount &&
        player.primaryMinecraftAccount !== identity.uuid
      )
        throw new Error(
          "Your linked Minecraft account changed; restart the form."
        );
      // Event registration must never overwrite a linked player's current
      // name. Only initialise the identity if the account is not linked yet.
      const username =
        player?.primaryMinecraftAccount === identity.uuid && player.latestIGN
          ? player.latestIGN
          : identity.username;
      if (!player?.primaryMinecraftAccount || !player.latestIGN) {
        await tx.player.upsert({
          where: { discordSnowflake: userId },
          create: {
            discordSnowflake: userId,
            primaryMinecraftAccount: identity.uuid,
            minecraftAccounts: [username],
            latestIGN: username,
          },
          update: {
            primaryMinecraftAccount: identity.uuid,
            latestIGN: username,
            ...(player?.minecraftAccounts.includes(username)
              ? {}
              : { minecraftAccounts: { push: username } }),
          },
        });
      }
      await this.promote(tx, event);
      const old = await tx.eventSignup.findUnique({
        where: { eventId_discordUserId: { eventId, discordUserId: userId } },
      });
      if (
        application.editing &&
        (!old ||
          old.status === "WITHDRAWN" ||
          !application.expectedSignupUpdatedAt ||
          old.updatedAt.getTime() !==
            application.expectedSignupUpdatedAt.getTime())
      ) {
        throw new Error(
          "Your sign-up changed while editing. Restart the form."
        );
      }
      const now = new Date();
      const count = await tx.eventSignup.count({
        where: { eventId, status: "CONFIRMED" },
      });
      const status =
        old && old.status !== "WITHDRAWN"
          ? old.status
          : eventAdmissionStatus(policy(event), count, now);
      const data = {
        minecraftUUID: identity.uuid,
        minecraftUsername: username,
        answers: application.answers as Prisma.InputJsonValue,
        acceptedFormRevision: event.formRevision,
        acceptedTermsAt: now,
        status,
        ...(old && old.status !== "WITHDRAWN"
          ? {}
          : {
              queuedAt: now,
              confirmedAt: status === "CONFIRMED" ? now : null,
              withdrawnAt: null,
              roleSyncPending: true,
              promotionPending: false,
            }),
      };
      return tx.eventSignup.upsert({
        where: { eventId_discordUserId: { eventId, discordUserId: userId } },
        create: { ...data, eventId, discordUserId: userId, queuedAt: now },
        update: data,
      });
    });
  }
  async withdraw(guildId: string, eventId: string, userId: string) {
    return this.transaction(async (tx) => {
      const event = await this.lock(tx, guildId, eventId);
      if (!["OPEN", "CLOSED"].includes(event.state))
        throw new Error("This event is not active.");
      const signup = await tx.eventSignup.findUnique({
        where: { eventId_discordUserId: { eventId, discordUserId: userId } },
      });
      if (!signup || signup.status === "WITHDRAWN")
        throw new Error("You do not have an active sign-up.");
      const result = await tx.eventSignup.update({
        where: { id: signup.id },
        data: {
          status: "WITHDRAWN",
          withdrawnAt: new Date(),
          roleSyncPending: true,
          promotionPending: false,
        },
      });
      await this.promote(tx, event, signup.status === "CONFIRMED" ? 1 : 0);
      return result;
    });
  }
  async reconcile(guildId: string) {
    const state = await this.db.eventGuildState.findUnique({
      where: { guildId },
    });
    if (!state?.currentEventId) return;
    const event = await this.get(guildId, state.currentEventId);
    if (!["OPEN", "CLOSED"].includes(event.state)) return;
    await this.transaction(async (tx) => {
      const locked = await this.lock(tx, guildId, event.id);
      await this.promote(tx, locked);
    });
  }
  async pendingRoles(guildId: string) {
    return this.db.eventSignup.findMany({
      where: { roleSyncPending: true, event: { guildId } },
      include: { event: true },
    });
  }
  async markRoleSynced(signupId: string, updatedAt: Date) {
    await this.db.eventSignup.updateMany({
      where: { id: signupId, updatedAt },
      data: { roleSyncPending: false },
    });
  }
}
export const eventService = new EventService();
