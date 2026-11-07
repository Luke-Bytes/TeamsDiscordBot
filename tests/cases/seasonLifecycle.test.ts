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
    "closeActiveSeason",
    "refreshPresence",
    "scheduleDeadline",
    "queueBlocks",
    "deliverPendingAnnouncements",
  ];
  const seasonKeys = ["findFirst", "findUnique", "create", "update"];
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
    (prismaClient.game as any).count = async () => 12;
    let closures = 0;
    service.closeActiveSeason = async (reason: SeasonClosureReason) => {
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
  const game = CurrentGameManager.getCurrentGame();
  const originalAnnounced = game.announced;
  try {
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
    game.announced = originalAnnounced;
  }
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
