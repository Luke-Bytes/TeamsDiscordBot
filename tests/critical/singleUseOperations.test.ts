import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";
import { SeasonType } from "@prisma/client";
import SeasonCommand from "../../src/commands/SeasonCommand";
import ScriptsCommand from "../../src/commands/ScriptsCommand";
import PunishCommand from "../../src/commands/PunishCommand";
import RestartCommand from "../../src/commands/RestartCommand";
import { GameRecoveryCoordinator } from "../../src/logic/ActiveGameRecovery";
import { DiscordUtil } from "../../src/util/DiscordUtil";
import { PermissionsUtil } from "../../src/util/PermissionsUtil";
import { SeasonService } from "../../src/database/SeasonService";
import { TitleService } from "../../src/logic/TitleService";
import { Channels } from "../../src/Channels";
import { prismaClient } from "../../src/database/prismaClient";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

function button(customId: string, id: string, user = "ORG") {
  const responses: string[] = [];
  return {
    customId,
    message: { id },
    user: { id: user },
    guildId: "guild",
    member: {},
    responses,
    reply: async (payload: any) => { responses.push(payload.content); },
    update: async (payload: any) => { responses.push(payload.content); },
    editReply: async (payload: any) => { responses.push(payload.content); },
  } as any;
}

test("season confirmation is message-bound, organiser-bound and claimed before async operations", async () => {
  const command = new SeasonCommand() as any;
  const previousReply = DiscordUtil.replyWithMessage;
  const previousRole = PermissionsUtil.hasRole;
  const previousBootstrap = SeasonService.bootstrap;
  let nextMessage = "season-one";
  let executions = 0;
  const gate = deferred();
  try {
    (PermissionsUtil as any).hasRole = () => true;
    (DiscordUtil as any).replyWithMessage = async () => ({ id: nextMessage });
    (SeasonService as any).bootstrap = async () => {
      executions++;
      await gate.promise;
      return { number: 42, type: SeasonType.RANKED };
    };
    await command.requestConfirmation({ user: { id: "ORG" } }, {
      kind: "start", userId: "ORG", type: SeasonType.RANKED,
    }, "Start?");
    const wrong = button("season-confirm", "season-one", "OTHER");
    await command.handleButtonPress(wrong);
    assertEqual(executions, 0, "Different user cannot consume the request");

    const stale = button("season-confirm", "different-message");
    await command.handleButtonPress(stale);
    assertEqual(executions, 0, "A copied/stale message cannot confirm");

    const first = button("season-confirm", "season-one");
    const duplicate = button("season-confirm", "season-one");
    const one = command.handleButtonPress(first);
    const two = command.handleButtonPress(duplicate);
    await two;
    gate.resolve();
    await one;
    assertEqual(executions, 1, "Concurrent clicks cause one side effect");
    assert(duplicate.responses[0].includes("expired"), "Duplicate gets expiry feedback");

    nextMessage = "season-two";
    await command.requestConfirmation({ user: { id: "ORG" } }, {
      kind: "start", userId: "ORG", type: SeasonType.RANKED,
    }, "Start?");
    await command.handleButtonPress(button("season-cancel", "season-two"));
    await command.handleButtonPress(button("season-confirm", "season-two"));
    assertEqual(executions, 1, "Cancellation cannot be followed by a confirm");
  } finally {
    (DiscordUtil as any).replyWithMessage = previousReply;
    (PermissionsUtil as any).hasRole = previousRole;
    (SeasonService as any).bootstrap = previousBootstrap;
  }
});

test("season failure is consumed and requires a fresh, reviewed request", async () => {
  const command = new SeasonCommand() as any;
  const priorReply = DiscordUtil.replyWithMessage;
  const priorRole = PermissionsUtil.hasRole;
  const priorBootstrap = SeasonService.bootstrap;
  let calls = 0;
  try {
    (PermissionsUtil as any).hasRole = () => true;
    (DiscordUtil as any).replyWithMessage = async () => ({ id: "season-failure" });
    (SeasonService as any).bootstrap = async () => { calls++; throw new Error("partial"); };
    await command.requestConfirmation({ user: { id: "ORG" } }, {
      kind: "start", userId: "ORG", type: SeasonType.RANKED,
    }, "Start?");
    const first = button("season-confirm", "season-failure");
    await command.handleButtonPress(first);
    await command.handleButtonPress(button("season-confirm", "season-failure"));
    assertEqual(calls, 1, "A failed operation cannot be replayed");
    assert(first.responses.some((s: string) => s.includes("partially completed")), "Failure warns about partial effect");
  } finally {
    (DiscordUtil as any).replyWithMessage = priorReply;
    (PermissionsUtil as any).hasRole = priorRole;
    (SeasonService as any).bootstrap = priorBootstrap;
  }
});

test("scripts reconciliation rejects wrong users and duplicate presses before publishing", async () => {
  const command = new ScriptsCommand();
  const priorReply = DiscordUtil.replyWithMessage;
  const priorAuth = PermissionsUtil.isUserAuthorised;
  const priorRole = PermissionsUtil.hasRole;
  const priorReconcile = TitleService.reconcile;
  const priorAnnouncements = Channels.announcements;
  let runs = 0;
  let publications = 0;
  const gate = deferred();
  try {
    (PermissionsUtil as any).isUserAuthorised = async () => true;
    (PermissionsUtil as any).hasRole = () => true;
    (DiscordUtil as any).replyWithMessage = async () => ({ id: "scripts-one" });
    (TitleService as any).reconcile = async () => {
      runs++;
      await gate.promise;
      return { newlyUnlocked: [], blocks: ["Published"] };
    };
    (Channels as any).announcements = { send: async () => { publications++; } };
    await command.execute({ user: { id: "ORG" } } as any);
    const wrong = button("scripts-confirm:titles-update", "scripts-one", "OTHER");
    await command.handleButtonPress(wrong);
    await command.handleButtonPress(button("scripts-confirm:titles-update", "old-message"));
    assertEqual(runs, 0, "Stale/wrong-user requests are inert");
    const first = command.handleButtonPress(button("scripts-confirm:titles-update", "scripts-one"));
    await command.handleButtonPress(button("scripts-confirm:titles-update", "scripts-one"));
    gate.resolve();
    await first;
    assertEqual(runs, 1, "One reconciliation");
    assertEqual(publications, 1, "One publication");
  } finally {
    (DiscordUtil as any).replyWithMessage = priorReply;
    (PermissionsUtil as any).isUserAuthorised = priorAuth;
    (PermissionsUtil as any).hasRole = priorRole;
    (TitleService as any).reconcile = priorReconcile;
    (Channels as any).announcements = priorAnnouncements;
  }
});

test("restart confirmation requires its exact message and is single-use", async () => {
  const command = new RestartCommand();
  const previousRole = PermissionsUtil.hasRole;
  let restarts = 0;
  let id = "";
  try {
    GameRecoveryCoordinator.resetForTests();
    (PermissionsUtil as any).hasRole = () => true;
    command.restartBot = () => { restarts++; };
    await command.execute({
      member: {}, guildId: "guild", user: { id: "ORG" },
      options: { getBoolean: () => false },
      reply: async (payload: any) => {
        id = payload.components[0].components[0].data.custom_id;
        return { resource: { message: { id: "restart-confirm" } } };
      },
    } as any);
    await command.handleButtonPress(button(id, "stale-message"));
    await command.handleButtonPress(button(id, "restart-confirm", "OTHER"));
    assertEqual(restarts, 0, "Stale and wrong-user clicks do not restart");
    await Promise.all([
      command.handleButtonPress(button(id, "restart-confirm")),
      command.handleButtonPress(button(id, "restart-confirm")),
    ]);
    await command.handleButtonPress(button(id, "restart-confirm"));
    assertEqual(restarts, 1, "Confirmed restart is claimed only once");
  } finally {
    (PermissionsUtil as any).hasRole = previousRole;
    GameRecoveryCoordinator.resetForTests();
  }
});



test("scripts reconciliation failure consumes the message without an unsafe retry", async () => {
  const command = new ScriptsCommand();
  const priorReply = DiscordUtil.replyWithMessage;
  const priorAuth = PermissionsUtil.isUserAuthorised;
  const priorRole = PermissionsUtil.hasRole;
  const priorReconcile = TitleService.reconcile;
  let calls = 0;
  try {
    (PermissionsUtil as any).isUserAuthorised = async () => true;
    (PermissionsUtil as any).hasRole = () => true;
    (DiscordUtil as any).replyWithMessage = async () => ({ id: "scripts-failure" });
    (TitleService as any).reconcile = async () => {
      calls++;
      throw new Error("Partial reconciliation");
    };
    await command.execute({ user: { id: "ORG" } } as any);
    const first = button("scripts-confirm:titles-update", "scripts-failure");
    await command.handleButtonPress(first);
    await command.handleButtonPress(button("scripts-confirm:titles-update", "scripts-failure"));
    assertEqual(calls, 1, "An ambiguous failed reconciliation is not replayed");
    assert(first.responses.some((s: string) => s.includes("partially completed")), "Organiser is told to inspect");
  } finally {
    (DiscordUtil as any).replyWithMessage = priorReply;
    (PermissionsUtil as any).isUserAuthorised = priorAuth;
    (PermissionsUtil as any).hasRole = priorRole;
    (TitleService as any).reconcile = priorReconcile;
  }
});

test("expunge write failure is single-use and requires inspection", async () => {
  const command = new PunishCommand() as any;
  const priorRole = PermissionsUtil.hasRole;
  const priorFind = prismaClient.playerPunishment.findFirst;
  const priorUpdate = prismaClient.playerPunishment.update;
  let writes = 0;
  try {
    (PermissionsUtil as any).hasRole = () => true;
    (prismaClient.playerPunishment as any).findFirst = async () => ({
      id: "record", reasons: ["Late", "AFK"],
      punishmentDates: [new Date(), new Date()], punishmentExpiry: null,
    });
    (prismaClient.playerPunishment as any).update = async () => {
      writes++;
      throw new Error("Uncertain DB acknowledgement");
    };
    command.expungeSessions.set("ORG", {
      userId: "ORG", playerId: "P1", createdAt: Date.now(), messageId: "expunge-failure",
    });
    const first = button("punish-expunge-select", "expunge-failure");
    first.values = ["idx:0"];
    await command.handleSelectMenu(first);
    const duplicate = button("punish-expunge-select", "expunge-failure");
    duplicate.values = ["idx:0"];
    await command.handleSelectMenu(duplicate);
    assertEqual(writes, 1, "Failed write must not be reissued from original menu");
    assert(first.responses.some((s: string) => s.includes("uncertain")), "Organiser sees uncertain status");
  } finally {
    (PermissionsUtil as any).hasRole = priorRole;
    (prismaClient.playerPunishment as any).findFirst = priorFind;
    (prismaClient.playerPunishment as any).update = priorUpdate;
  }
});

test("expunge validates message and claims session before DB access", async () => {
  const command = new PunishCommand() as any;
  const priorRole = PermissionsUtil.hasRole;
  const priorFind = prismaClient.playerPunishment.findFirst;
  const priorUpdate = prismaClient.playerPunishment.update;
  const gate = deferred();
  let writes = 0;
  try {
    (PermissionsUtil as any).hasRole = () => true;
    (prismaClient.playerPunishment as any).findFirst = async () => {
      await gate.promise;
      return { id: "rec", reasons: ["Late", "AFK"], punishmentDates: [new Date(), new Date()], punishmentExpiry: null };
    };
    (prismaClient.playerPunishment as any).update = async () => { writes++; return {}; };
    command.expungeSessions.set("ORG", { userId: "ORG", playerId: "P1", createdAt: Date.now(), messageId: "expunge-one" });
    const wrongUser = button("punish-expunge-select", "expunge-one", "OTHER");
    wrongUser.values = ["idx:0"];
    await command.handleSelectMenu(wrongUser);
    const stale = button("punish-expunge-select", "old-message");
    stale.values = ["idx:0"];
    await command.handleSelectMenu(stale);
    assertEqual(writes, 0, "Wrong user/message cannot expunge");

    const first = button("punish-expunge-select", "expunge-one");
    first.values = ["idx:0"];
    const second = button("punish-expunge-select", "expunge-one");
    second.values = ["idx:0"];
    const run = command.handleSelectMenu(first);
    await command.handleSelectMenu(second);
    gate.resolve();
    await run;
    assertEqual(writes, 1, "Concurrent selections make one write");

    command.expungeSessions.set("ORG", { userId: "ORG", playerId: "P1", createdAt: Date.now(), messageId: "expunge-two" });
    const cancel = button("punish-expunge-select", "expunge-two");
    cancel.values = ["cancel"];
    await command.handleSelectMenu(cancel);
    const retry = button("punish-expunge-select", "expunge-two");
    retry.values = ["idx:0"];
    await command.handleSelectMenu(retry);
    assertEqual(writes, 1, "Cancelled menu is single-use");
  } finally {
    (PermissionsUtil as any).hasRole = priorRole;
    (prismaClient.playerPunishment as any).findFirst = priorFind;
    (prismaClient.playerPunishment as any).update = priorUpdate;
  }
});
