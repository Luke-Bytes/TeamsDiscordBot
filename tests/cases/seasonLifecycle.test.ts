import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { SeasonService } from "../../src/database/SeasonService";
import SeasonCommand from "../../src/commands/SeasonCommand";
import ScriptsCommand from "../../src/commands/ScriptsCommand";
import {
  SeasonClosureReason,
  SeasonLifecycleState,
  SeasonType,
} from "@prisma/client";
import { prismaClient } from "../../src/database/prismaClient";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import { PermissionsUtil } from "../../src/util/PermissionsUtil";
import { DiscordUtil } from "../../src/util/DiscordUtil";

test("season configure parses UTC dates, explicit offsets, and off, and rejects ambiguous or invalid dates", async () => {
  const originalConfigure = SeasonService.configure;
  const originalAuthorised = PermissionsUtil.isUserAuthorised;
  try {
    (PermissionsUtil as any).isUserAuthorised = async () => true;
    for (const [input, expected] of [
      ["2099-11-13", "2099-11-13T00:00:00.000Z"],
      ["2099-11-13T18:30:00+01:00", "2099-11-13T17:30:00.000Z"],
      ["off", null],
      ["Friday", "invalid"],
      ["2099-02-30", "invalid"],
      ["2099-11-13T18:30", "invalid"],
    ]) {
      let called = false;
      let reply = "";
      (SeasonService as any).configure = async (configuration: any) => {
        called = true;
        assert(
          (configuration.firstRolloverAt?.toISOString() ?? null) === expected,
          "Start parses to the intended instant"
        );
        return { number: 6, firstRolloverAt: configuration.firstRolloverAt };
      };
      await new SeasonCommand().execute({
        options: {
          getSubcommand: () => "configure",
          getInteger: () => null,
          getString: (name: string) => (name === "start" ? input : null),
        },
        reply: async ({ content }: any) => {
          reply = content;
        },
      } as any);
      assert(
        called === (expected !== "invalid"),
        "Only unambiguous valid dates reach the service"
      );
      assert(
        reply.length > 0,
        "The organiser receives a result or validation error"
      );
    }
  } finally {
    SeasonService.configure = originalConfigure;
    PermissionsUtil.isUserAuthorised = originalAuthorised;
  }
});

async function withSeasonMocks(run: (service: any) => Promise<void>) {
  const service = SeasonService as any;
  const serviceKeys = [
    "getActiveSeason",
    "requireActiveSeason",
    "closeSeason",
    "refreshPresence",
    "scheduleDeadline",
    "queueBlocks",
    "deliverPendingAnnouncements",
    "relaxedRecap",
  ];
  const seasonKeys = [
    "findFirst",
    "findUnique",
    "findMany",
    "create",
    "update",
  ];
  const restore = [
    ...serviceKeys.map((key) => {
      const original = service[key];
      return () => {
        service[key] = original;
      };
    }),
    ...seasonKeys.map((key) => {
      const original = (prismaClient.season as any)[key];
      return () => {
        (prismaClient.season as any)[key] = original;
      };
    }),
  ];
  const originalCount = prismaClient.game.count;
  try {
    service.refreshPresence = async () => {};
    service.scheduleDeadline = () => {};
    service.queueBlocks = async () => {};
    service.deliverPendingAnnouncements = async () => {};
    await run(service);
  } finally {
    restore.forEach((fn) => fn());
    prismaClient.game.count = originalCount;
  }
}

test("scheduled first rollover overrides old thresholds, defers for a game, and catches up after downtime", async () => {
  await withSeasonMocks(async (service) => {
    const season: any = {
      id: "scheduled",
      gameLimit: 1,
      rolloverDeadline: new Date(0),
      firstRolloverAt: new Date(Date.now() + 86_400_000),
    };
    service.getActiveSeason = async () => season;
    (prismaClient.game as any).count = async () => {
      throw new Error("Scheduled rollover must not count games");
    };
    let closures = 0;
    service.closeSeason = async (_season: any, reason: SeasonClosureReason) => {
      assert(
        reason === SeasonClosureReason.SCHEDULED,
        "Scheduled reason survives overdue limits"
      );
      closures++;
    };
    (prismaClient.season as any).update = async ({ data }: any) =>
      Object.assign(season, data);
    const before = await SeasonService.evaluateRollover(false);
    assert(
      !before.closed && !before.pending && closures === 0,
      "No closure before the scheduled start"
    );
    season.firstRolloverAt = new Date(Date.now() - 1000);
    const during = await SeasonService.evaluateRollover(true);
    assert(
      during.pending && season.rolloverPending && closures === 0,
      "Active game defers scheduled closure"
    );
    const after = await SeasonService.evaluateRollover(false);
    assert(
      after.closed && Number(closures) === 1,
      "An overdue persisted schedule closes after game completion or restart"
    );
  });
});

test("rollover counts games only when the count can affect the reason", async () => {
  await withSeasonMocks(async (service) => {
    const season: any = {
      id: "limits",
      gameLimit: null,
      rolloverDeadline: null,
    };
    service.getActiveSeason = async () => season;
    let counts = 0;
    let reason: SeasonClosureReason | undefined;
    (prismaClient.game as any).count = async ({ where }: any) => {
      assert(
        where.seasonId === season.id && where.finished,
        "Counts finished games in the active season"
      );
      counts++;
      return 5;
    };
    service.closeSeason = async (_season: any, value: SeasonClosureReason) => {
      reason = value;
    };
    assert(
      !(await SeasonService.evaluateRollover(false)).closed,
      "No limits means no rollover"
    );
    season.rolloverDeadline = new Date(0);
    assert(
      (await SeasonService.evaluateRollover(false)).closed,
      "Time-only limit still closes"
    );
    assert(
      reason === SeasonClosureReason.MONTH_LIMIT && counts === 0,
      "Time-only rollover avoids game count"
    );
    season.gameLimit = 5;
    assert(
      (await SeasonService.evaluateRollover(false)).closed,
      "Game limit still closes"
    );
    assert(
      String(reason) === SeasonClosureReason.GAME_LIMIT && Number(counts) === 1,
      "Game-limit reason retains precedence"
    );
  });
});

test("post-game status reads only the counts needed for its message", async () => {
  const service = SeasonService as any;
  const originalEvaluate = SeasonService.evaluateRollover;
  const originalSend = DiscordUtil.sendMessage;
  const originalAnnouncementCount = prismaClient.seasonAnnouncement.count;
  try {
    await withSeasonMocks(async () => {
      const season: any = {
        id: "post-game",
        number: 6,
        gameLimit: 10,
        firstRolloverAt: new Date("2099-01-01T00:00:00Z"),
      };
      service.requireActiveSeason = async () => season;
      service.evaluateRollover = async () => ({
        closed: false,
        pending: false,
      });
      let counts = 0;
      const messages: string[] = [];
      (DiscordUtil as any).sendMessage = async (
        _channel: string,
        text: string
      ) => {
        messages.push(text);
      };
      (prismaClient.seasonAnnouncement as any).count = async () => {
        throw new Error(
          "The post-game message does not need announcement counts"
        );
      };
      (prismaClient.game as any).count = async () => {
        counts++;
        return 3;
      };
      await SeasonService.afterGameSaved();
      assert(
        messages[0].includes("first rollover scheduled") && counts === 0,
        "Scheduled message needs no count"
      );
      season.firstRolloverAt = null;
      await SeasonService.afterGameSaved();
      assert(
        messages[1].includes("7 game(s) remaining") && Number(counts) === 1,
        "Game limit uses a fresh count"
      );
      season.gameLimit = null;
      await SeasonService.afterGameSaved();
      assert(
        messages[2].includes("no game limit") && Number(counts) === 1,
        "Unlimited message needs no count"
      );
    });
  } finally {
    SeasonService.evaluateRollover = originalEvaluate;
    DiscordUtil.sendMessage = originalSend;
    prismaClient.seasonAnnouncement.count = originalAnnouncementCount;
  }
});

test("season presence counts only visible game progress", async () => {
  const service = SeasonService as any;
  const oldClient = service.client;
  const oldActive = SeasonService.getActiveSeason;
  const oldCount = prismaClient.game.count;
  const season: any = {
    id: "presence",
    number: 6,
    type: SeasonType.RANKED,
    gameLimit: 10,
  };
  let counts = 0;
  let activity = "";
  try {
    service.client = {
      user: {
        setActivity: (value: string) => {
          activity = value;
        },
      },
    };
    service.getActiveSeason = async () => season;
    (prismaClient.game as any).count = async () => {
      counts++;
      return 3;
    };
    await SeasonService.refreshPresence();
    assert(
      activity.includes("3/10 games") && counts === 1,
      "Game progress reads fresh count"
    );
    season.rolloverPending = true;
    await SeasonService.refreshPresence();
    assert(
      activity.includes("rollover pending") && counts === 1,
      "Pending progress avoids count"
    );
    season.rolloverPending = false;
    season.firstRolloverAt = new Date("2099-01-01T00:00:00Z");
    await SeasonService.refreshPresence();
    assert(
      activity.includes("2099-01-01 UTC") && counts === 1,
      "Scheduled progress avoids count"
    );
    season.firstRolloverAt = null;
    season.gameLimit = null;
    season.monthLimit = 1;
    season.rolloverDeadline = new Date(Date.now() + 86_400_000);
    await SeasonService.refreshPresence();
    assert(
      activity.includes("1d left") && counts === 1,
      "Time-only progress avoids count"
    );
  } finally {
    service.client = oldClient;
    SeasonService.getActiveSeason = oldActive;
    prismaClient.game.count = oldCount;
  }
});

test("configure preserves omitted scheduling and ranked limits, supports clearing, and rejects past starts", async () => {
  await withSeasonMocks(async (service) => {
    const season: any = {
      id: "configure",
      type: SeasonType.RELAXED,
      startDate: new Date(),
      rankedGameLimit: 30,
      rankedMonthLimit: 2,
      gameLimit: 15,
      monthLimit: 1,
      firstRolloverAt: new Date(Date.now() + 86_400_000),
    };
    service.requireActiveSeason = service.getActiveSeason = async () => season;
    (prismaClient.season as any).update = async ({ data }: any) => {
      for (const [key, value] of Object.entries(data))
        if (value !== undefined) season[key] = value;
      return season;
    };
    (prismaClient.game as any).count = async () => 0;
    const date = season.firstRolloverAt;
    await SeasonService.configure({ nextTypeOverride: SeasonType.RANKED });
    assert(
      season.firstRolloverAt === date &&
        season.gameLimit === 15 &&
        season.monthLimit === 1,
      "Omitted fields do not halve limits again or clear scheduling"
    );
    season.rolloverPending = true;
    season.closureReason = SeasonClosureReason.SCHEDULED;
    await SeasonService.configure({
      firstRolloverAt: null,
      gameLimit: null,
      monthLimit: null,
    });
    assert(
      season.firstRolloverAt === null &&
        season.gameLimit === null &&
        season.monthLimit === null &&
        !season.rolloverPending &&
        season.closureReason === null,
      "Explicit clearing disables scheduling and both limits"
    );
    let rejected = false;
    try {
      await SeasonService.configure({ firstRolloverAt: new Date(0) });
    } catch (error) {
      rejected = error instanceof Error && error.message.includes("future");
    }
    assert(rejected, "Past start dates are rejected");
  });
});

test("successive ranked and relaxed rollovers retain baseline limits and consume the first schedule", async () => {
  await withSeasonMocks(async (service) => {
    let closing: any = {
      id: "s6",
      number: 6,
      type: SeasonType.RANKED,
      gameLimit: 30,
      monthLimit: 2,
      firstRolloverAt: new Date(0),
      recapProcessedAt: new Date(),
      titlesProcessedAt: new Date(),
    };
    const successors: any[] = [];
    (prismaClient.season as any).findUnique = async () => closing;
    (prismaClient.season as any).findFirst = async ({ where }: any) =>
      where ? null : closing;
    service.getActiveSeason = async () => successors.at(-1) ?? null;
    (prismaClient.season as any).create = async ({ data }: any) => {
      const next = { id: `s${data.number}`, ...data };
      successors.push(next);
      return next;
    };
    (prismaClient.season as any).update = async ({ data }: any) =>
      Object.assign(closing, data);
    const relaxed = await service.finishClosure(closing.id);
    assert(
      relaxed.gameLimit === 15 && relaxed.monthLimit === 1,
      "Legacy ranked limits create a half-length relaxed successor"
    );
    assert(
      !relaxed.firstRolloverAt,
      "One-time first rollover date is not inherited"
    );
    closing = {
      ...relaxed,
      recapProcessedAt: new Date(),
      titlesProcessedAt: new Date(),
    };
    const ranked = await service.finishClosure(closing.id);
    assert(
      ranked.gameLimit === 30 && ranked.monthLimit === 2,
      "Ranked successor restores the full baseline"
    );
    assert(successors.length === 2, "Exactly one successor per closure");
  });
});

test("season closure claims legacy missing, null, and active lifecycle states", async () => {
  const service = SeasonService as any;
  const originalRequire = SeasonService.requireActiveSeason;
  const originalUpdateMany = prismaClient.season.updateMany;
  const originalFinish = service.finishClosure;
  const originalDelivery = service.deliverPendingAnnouncements;
  const game = CurrentGameManager.getCurrentGame();
  const originalAnnounced = game.announced;
  try {
    service.deliverPendingAnnouncements = async () => {};
    game.announced = false;
    // Model MongoDB matching: explicit null does not match a missing field.
    for (const stored of [
      {},
      { lifecycleState: null },
      { lifecycleState: SeasonLifecycleState.ACTIVE },
    ]) {
      const active = {
        id: "legacy-season",
        number: 6,
        isActive: true,
        ...stored,
      };
      service.requireActiveSeason = async () => active;
      let claimed = false;
      let finished = false;
      (prismaClient.season as any).updateMany = async ({
        where,
        data,
      }: any) => {
        const hasState = Object.prototype.hasOwnProperty.call(
          stored,
          "lifecycleState"
        );
        claimed =
          where.id === active.id &&
          where.isActive === true &&
          where.OR.some(({ lifecycleState: filter }: any) =>
            typeof filter === "object" && filter !== null
              ? filter.isSet === false && !hasState
              : hasState && filter === (stored as any).lifecycleState
          );
        assert(
          data.lifecycleState === SeasonLifecycleState.CLOSING,
          "Claim transitions the season to CLOSING"
        );
        return { count: claimed ? 1 : 0 };
      };
      service.finishClosure = async (id: string) => {
        assert(
          claimed && id === active.id,
          "Finish only after claiming the season"
        );
        finished = true;
        return { number: 7 };
      };
      const successor = await SeasonService.closeActiveSeason(
        SeasonClosureReason.MANUAL
      );
      assert(
        finished && successor.number === 7,
        "Closure proceeds to its successor"
      );
    }
  } finally {
    service.requireActiveSeason = originalRequire;
    prismaClient.season.updateMany = originalUpdateMany;
    service.finishClosure = originalFinish;
    service.deliverPendingAnnouncements = originalDelivery;
    game.announced = originalAnnounced;
  }
});

test("stale rollover does not close the successor or use replaced configuration", async () => {
  await withSeasonMocks(async (service) => {
    let season = { id: "old", gameLimit: 4 };
    service.getActiveSeason = async () => ({ ...season });
    let closes = 0;
    service.closeSeason = async () => {
      closes++;
    };
    (prismaClient.game as any).count = async () => {
      season = { id: "successor", gameLimit: 100 };
      return 4;
    };
    assert(
      !(await SeasonService.evaluateRollover(false)).closed,
      "Stale decision rejected"
    );
    assert(closes === 0, "Successor is not closed");
    season = { id: "old", gameLimit: 4 };
    (prismaClient.game as any).count = async () => {
      season.gameLimit = 100;
      return 4;
    };
    assert(
      !(await SeasonService.evaluateRollover(false)).closed,
      "Changed limit invalidates decision"
    );
    assert(closes === 0, "No closure under replaced limits");
  });
});

test("overlapping lifecycle requests are queued and re-evaluated", async () => {
  await withSeasonMocks(async (service) => {
    let season = { id: "old", gameLimit: 4 };
    service.getActiveSeason = service.requireActiveSeason = async () => ({
      ...season,
    });
    (prismaClient.game as any).count = async () => 4;
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const claims: string[] = [];
    service.closeSeason = async (target: any) => {
      claims.push(target.id);
      entered();
      await blocked;
      season = { id: "successor", gameLimit: 100 };
      return season;
    };
    const first = SeasonService.evaluateRollover(false);
    await started;
    const second = SeasonService.evaluateRollover(false);
    const manual = SeasonService.closeActiveSeason(SeasonClosureReason.MANUAL);
    const configure = SeasonService.configure({ gameLimit: 10 }).then(
      () => false,
      () => true
    );
    // Let the manual and configuration requests capture the original target.
    await Promise.resolve();
    release();
    assert((await first).closed, "First request closes original season");
    assert(!(await second).closed, "Queued evaluation sees successor limits");
    let rejected = false;
    try {
      await manual;
    } catch {
      rejected = true;
    }
    assert(rejected, "Stale manual request cannot close successor");
    assert(await configure, "Queued configuration cannot modify successor");
    rejected = false;
    try {
      await SeasonService.closeActiveSeason(
        SeasonClosureReason.MANUAL,
        undefined,
        "old"
      );
    } catch {
      rejected = true;
    }
    assert(
      rejected,
      "Confirmation issued before rollover cannot close successor"
    );
    assert(claims.join() === "old", "One closure execution");
  });
});

test("automatic rollover rechecks active game state after asynchronous reads", async () => {
  await withSeasonMocks(async (service) => {
    const game = CurrentGameManager.getCurrentGame();
    const previous = game.announced;
    const season: any = { id: "active-game", gameLimit: 1 };
    let closes = 0;
    try {
      game.announced = false;
      service.getActiveSeason = async () => ({ ...season });
      service.closeSeason = async () => {
        closes++;
      };
      (prismaClient.game as any).count = async () => {
        game.announced = true;
        return 1;
      };
      (prismaClient.season as any).update = async ({ data }: any) =>
        Object.assign(season, data);
      const result = await SeasonService.evaluateRollover();
      assert(
        result.pending &&
          !result.closed &&
          closes === 0 &&
          season.rolloverPending,
        "Newly announced game defers rollover"
      );
    } finally {
      game.announced = previous;
    }
  });
});

test("season admission waits for closure and rejects direct installation during the claim", async () => {
  await withSeasonMocks(async (service) => {
    const game = CurrentGameManager.getCurrentGame();
    const originalClaim = prismaClient.season.updateMany;
    const originalFinish = service.finishClosure;
    const oldSeason = { id: "old", number: 1, type: SeasonType.RANKED, gameLimit: 1, isActive: true };
    const nextSeason = { id: "next", number: 2, type: SeasonType.RELAXED, gameLimit: null, isActive: true };
    let active: any = oldSeason;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let rollover: Promise<any> | undefined;
    let admission: Promise<string> | undefined;
    try {
      game.reset();
      service.getActiveSeason = async () => ({ ...active });
      service.requireActiveSeason = async () => ({ ...active });
      (prismaClient.game as any).count = async () => 1;
      (prismaClient.season as any).updateMany = async () => {
        entered();
        await blocked;
        return { count: 1 };
      };
      service.finishClosure = async () => { active = nextSeason; return nextSeason; };
      rollover = SeasonService.evaluateRollover();
      await started;
      let refused = false;
      try { game.beginConfirmedAnnouncement(); }
      catch (error) { refused = String(error).includes("rollover is in progress"); }
      assert(refused && !game.announced, "Direct game installation cannot bypass a closure claim");

      admission = SeasonService.withGameAdmission((season) => {
        game.isRelaxedSeason = season.type === SeasonType.RELAXED;
        game.beginConfirmedAnnouncement();
        return season.id;
      });
      await Promise.resolve();
      assert(!game.announced, "Queued admission cannot install while the claim is pending");
      release();
      assert((await rollover).closed, "Original season closes");
      assert(await admission === "next", "Admission reads successor under the lifecycle lock");
      assert(game.announced && game.isRelaxedSeason && game.noElo, "Successor rating rules apply to the next game");
      let typeRejected = false;
      try { await SeasonService.configure({ currentType: SeasonType.RANKED }); }
      catch (error) { typeRejected = String(error).includes("while a game is announced"); }
      assert(typeRejected, "Season type cannot change beneath an announced game");
    } finally {
      release();
      await rollover?.catch(() => {});
      await admission?.catch(() => {});
      prismaClient.season.updateMany = originalClaim;
      service.finishClosure = originalFinish;
      game.reset();
    }
  });
});

test("overlapping maintenance ticks coalesce without delaying queued manual work", async () => {
  const service = SeasonService as any;
  const original = service.maintainSeasons;
  const originalDelivery = service.deliverPendingAnnouncements;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  try {
    service.maintainSeasons = async () => {
      if (++calls === 1) { entered(); await blocked; }
    };
    service.deliverPendingAnnouncements = async () => {};
    const first = service.periodicMaintenance();
    await started;
    const ticks = Array.from({ length: 20 }, () => service.periodicMaintenance());
    let callsBeforeManual = -1;
    const manual = service.serializeLifecycle(async () => { callsBeforeManual = calls; });
    release();
    await Promise.all([first, ...ticks, manual]);
    assert(callsBeforeManual === 2, "Only one pending pass is retained for a deadline reached mid-pass");
    assert(calls === 2, "Redundant ticks do not accumulate behind manual work");
    await service.periodicMaintenance();
    assert(calls === 3, "Later timer can run a fresh maintenance pass");
  } finally {
    release();
    service.maintainSeasons = original;
    service.deliverPendingAnnouncements = originalDelivery;
  }
});

test("periodic maintenance retries incomplete closure processing without a restart", async () => {
  await withSeasonMocks(async (service) => {
    const closing: any = {
      id: "old",
      number: 6,
      type: SeasonType.RELAXED,
      lifecycleState: SeasonLifecycleState.CLOSED,
      successorSeasonId: "next",
      recapProcessedAt: null,
      titlesProcessedAt: new Date(),
    };
    const next = {
      id: "next",
      number: 7,
      type: SeasonType.RANKED,
      isActive: true,
    };
    service.getActiveSeason = async () => next;
    (prismaClient.season as any).findMany = async () =>
      closing.recapProcessedAt ? [] : [closing];
    (prismaClient.season as any).findUnique = async ({ where }: any) =>
      where.id === "old" ? closing : next;
    (prismaClient.season as any).update = async ({ data }: any) =>
      Object.assign(closing, data);
    let attempts = 0;
    let recaps = 0;
    service.relaxedRecap = async () => {
      if (++attempts === 1) throw new Error("transient recap failure");
      return ["Recovered recap"];
    };
    service.queueBlocks = async (_id: string, kind: string) => {
      if (kind === "RECAP") recaps++;
    };
    await service.periodicMaintenance();
    assert(!closing.recapProcessedAt, "Failure leaves checkpoint unset");
    await service.periodicMaintenance();
    assert(
      closing.recapProcessedAt && attempts === 2 && recaps === 1,
      "Maintenance repairs closure"
    );
    await service.periodicMaintenance();
    assert(attempts === 2 && recaps === 1, "Completed recap is not repeated");
  });
});

test("season calendar deadlines preserve calendar dates and clamp month ends", () => {
  const leap = SeasonService.calculateDeadline(
    new Date("2024-01-31T19:30:00.000Z"),
    1
  );
  assert(
    leap?.toISOString() === "2024-02-29T19:30:00.000Z",
    "January 31 clamps to leap-day in a leap year"
  );

  const multiMonth = SeasonService.calculateDeadline(
    new Date("2025-11-30T19:30:00.000Z"),
    3
  );
  assert(
    multiMonth?.toISOString() === "2026-02-28T19:30:00.000Z",
    "Whole calendar month addition clamps at the destination month end"
  );
  assert(
    SeasonService.calculateDeadline(new Date(), null) === null,
    "A cleared month limit disables its deadline"
  );
});

test("relaxed seasons halve the ranked baseline without compounding", () => {
  const ranked = SeasonService.limitsForType(SeasonType.RANKED, 30, 2);
  const relaxed = SeasonService.limitsForType(SeasonType.RELAXED, 30, 2);
  assert(
    ranked.gameLimit === 30 && ranked.monthLimit === 2,
    "Ranked retains configured limits"
  );
  assert(
    relaxed.gameLimit === 15 && relaxed.monthLimit === 1,
    "Relaxed has half the configured limits"
  );
  assert(
    SeasonService.limitsForType(SeasonType.RELAXED, 31, 1).gameLimit === 15,
    "Odd game limits round down"
  );
  assert(
    SeasonService.limitsForType(SeasonType.RELAXED, 1, null).gameLimit === 1,
    "At least one game is allowed"
  );
  const disabled = SeasonService.limitsForType(SeasonType.RELAXED, null, null);
  assert(
    disabled.gameLimit === null && disabled.monthLimit === null,
    "Cleared limits remain disabled"
  );
  assert(
    SeasonService.calculateDeadline(
      new Date("2026-04-01T00:00:00Z"),
      0.5
    )?.toISOString() === "2026-04-16T00:00:00.000Z",
    "Half a month uses half the actual calendar-month interval"
  );
});

test("season command exposes the organiser lifecycle surface", () => {
  const json = new SeasonCommand().data.toJSON();
  const names = (json.options ?? []).map((option) => option.name).sort();
  assert(
    JSON.stringify(names) ===
      JSON.stringify(["configure", "end", "start", "status", "view"]),
    "Season command has view, status, configure, end, and start"
  );
});

test("scripts command no longer exposes season-update", () => {
  const json = new ScriptsCommand().data.toJSON();
  const names = (json.options ?? []).map((option) => option.name);
  assert(
    names.length === 1 && names[0] === "titles-update",
    "Only the title reconciliation repair remains"
  );
});
