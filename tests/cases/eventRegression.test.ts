import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";
import { EventService, eventService } from "../../src/logic/EventService";
import SignCommand from "../../src/commands/SignCommand";
import EventCommand from "../../src/commands/EventCommand";
import { MessageFlags } from "discord.js";
import { PermissionsUtil } from "../../src/util/PermissionsUtil";
import { ConfigManager } from "../../src/ConfigManager";

test("closed event withdrawal promotes FIFO reserves; finishing retains history and prevents changes", async () => {
  const event: any = {
    id: "event",
    guildId: "guild",
    state: "CLOSED",
    revision: 0,
    capacity: 1,
    signupDeadline: new Date(0),
  };
  const rows: any[] = [
    {
      id: "confirmed",
      discordUserId: "confirmed",
      status: "CONFIRMED",
      queuedAt: new Date(1),
    },
    {
      id: "later",
      discordUserId: "later",
      status: "RESERVE",
      queuedAt: new Date(3),
    },
    {
      id: "first",
      discordUserId: "first",
      status: "RESERVE",
      queuedAt: new Date(2),
    },
  ];
  let conflict = false;
  let conflictsRetried = 0;
  const db: any = {
    standaloneEvent: {
      findFirst: async () => ({ ...event }),
      updateMany: async () => {
        if (conflict) {
          conflict = false;
          conflictsRetried++;
          throw Object.assign(new Error("Write conflict"), { code: "P2034" });
        }
        return { count: 1 };
      },
      update: async ({ data }: any) => Object.assign(event, data),
    },
    eventSignup: {
      findUnique: async ({ where }: any) =>
        rows.find(
          (r) => r.discordUserId === where.eventId_discordUserId.discordUserId
        ),
      count: async () => rows.filter((r) => r.status === "CONFIRMED").length,
      findMany: async ({ where }: any) =>
        rows
          .filter((r) => r.status === where.status)
          .sort((a, b) => a.queuedAt - b.queuedAt),
      update: async ({ where, data }: any) =>
        Object.assign(
          rows.find((r) => r.id === where.id),
          data
        ),
      updateMany: async ({ where, data }: any) => {
        const matching = rows.filter(
          (r) => !where.id || where.id.in.includes(r.id)
        );
        matching.forEach((r) => Object.assign(r, data));
        return { count: matching.length };
      },
    },
    $transaction: async (run: any) => run(db),
  };
  const service = new EventService(db);
  await service.withdraw("guild", "event", "confirmed");
  assertEqual(rows[0].status, "WITHDRAWN", "withdrawal preserved");
  assertEqual(
    rows[2].status,
    "CONFIRMED",
    "oldest reserve promoted despite closure and deadline"
  );
  assertEqual(
    rows[1].status,
    "RESERVE",
    "later reserve retains queue position"
  );
  assert(
    rows[2].roleSyncPending && rows[2].promotionPending,
    "promotion side effects persisted"
  );
  assert(typeof rows[0].roleSyncToken === "string", "withdrawal queues a versioned role operation");
  assert(typeof rows[2].roleSyncToken === "string" && typeof rows[2].promotionToken === "string", "promotion queues independent versions");
  const promotedVersion = rows[2].roleSyncToken;
  conflict = true;
  await service.finish("guild", "event");
  assertEqual(conflictsRetried, 1, "Finishing retries a rolled-back write conflict");
  assert(rows[2].roleSyncToken !== promotedVersion && !rows[2].promotionPending, "finish replaces in-flight role work and cancels promotions");
  assertEqual(rows.length, 3, "finishing preserves historical submissions");
  assert(
    rows.every((r) => r.roleSyncPending),
    "finished event queues role cleanup"
  );
  let rejected = false;
  try {
    await service.withdraw("guild", "event", "first");
  } catch {
    rejected = true;
  }
  assert(rejected, "finished event rejects player changes");
});

test("event export stays private and neutralises CSV formulas in headers and answers", async () => {
  const oldGet = eventService.get;
  const oldRoster = eventService.roster;
  const oldAuth = PermissionsUtil.isUserAuthorised;
  const calls: { method: string; payload: any }[] = [];
  try {
    PermissionsUtil.isUserAuthorised = async () => true;
    eventService.get = async () => ({
      id: "event", guildId: "guild",
      questions: [{ id: "q", label: "=HEADER()", type: "SHORT_TEXT", required: true }],
    }) as any;
    eventService.roster = async () => [{
      discordUserId: "user", minecraftUsername: "Player", minecraftUUID: "a".repeat(32),
      status: "RESERVE", acceptedTermsAt: new Date(0), queuedAt: new Date(0),
      answers: { q: '=HYPERLINK("bad")\nsecond line' },
    }] as any;
    const interaction = {
      guildId: "guild", user: { id: "organiser" },
      options: { getSubcommand: () => "export", getString: () => null, getSubcommandGroup: () => null },
      deferReply: async (payload: any) => { calls.push({ method: "defer", payload }); },
      editReply: async (payload: any) => { calls.push({ method: "edit", payload }); },
      reply: async (payload: any) => { calls.push({ method: "reply", payload }); },
    };
    await new EventCommand().execute(interaction as any);
    assertEqual(calls[0]?.payload.flags, MessageFlags.Ephemeral, "Export must be private");
    assertEqual(calls.length, 2, "No additional public output");
    assertEqual(calls[1].method, "edit", "Attachment edits private reply");
    const csv = calls[1].payload.files[0].attachment.toString();
    assert(csv.includes("\"'=HEADER()\""), "Formula header neutralised");
    assert(csv.includes("\"'=HYPERLINK(\"\"bad\"\")\nsecond line\""), "Formula answer and embedded quotes escaped");
  } finally {
    eventService.get = oldGet;
    eventService.roster = oldRoster;
    PermissionsUtil.isUserAuthorised = oldAuth;
  }
});

test("event form requires private owner consent and rejects forms from a replaced event", async () => {
  const config = ConfigManager.getConfig();
  const channel = config.channels.eventSignUps;
  const originals = {
    get: eventService.get,
    roster: eventService.roster,
    identity: eventService.identity,
    signup: eventService.signup,
  };
  const event: any = {
    id: "event",
    title: "Cup",
    terms: "Rules",
    formRevision: 1,
    state: "OPEN",
    capacity: null,
    signupDeadline: null,
    questions: [
      { id: "q", label: "Availability?", type: "SHORT_TEXT", required: true },
    ],
  };
  let saves = 0;
  function interaction(user = "owner"): any {
    const calls: any[] = [];
    const i: any = {
      guildId: "guild",
      channelId: "event-channel",
      user: { id: user },
      calls,
      options: { getSubcommand: () => "up", getString: () => null },
    };
    for (const method of [
      "reply",
      "editReply",
      "followUp",
      "deferReply",
      "update",
    ])
      i[method] = async (payload: any) => calls.push({ method, payload });
    return i;
  }
  config.channels.eventSignUps = "event-channel";
  eventService.get = async () => ({ ...event });
  eventService.roster = async () => [];
  eventService.identity = async () => ({
    uuid: "a".repeat(32),
    username: "Player",
  });
  eventService.signup = async () => {
    saves++;
    return {} as any;
  };
  try {
    const command = new SignCommand();
    const start = interaction();
    await command.execute(start);
    assert(
      start.calls.some(
        (c: any) => c.method === "deferReply" && !c.payload?.flags
      ),
      "slash command acknowledgement is public"
    );
    const publicReply = start.calls.find(
      (c: any) => c.method === "editReply"
    ).payload;
    assert(
      !JSON.stringify(publicReply).includes("Availability?"),
      "public acknowledgement must not reveal private questions"
    );
    const page = start.calls.find(
      (c: any) => c.method === "followUp" && c.payload.flags
    ).payload;
    assert(page.components?.length, "questionnaire stays private");
    const next = page.components
      .flatMap((r: any) => r.toJSON().components)
      .find((b: any) => b.label === "Next").custom_id;
    const stolen = interaction("intruder");
    stolen.customId = next;
    await command.handleButtonPress(stolen);
    assert(
      stolen.calls.some((c: any) =>
        String(c.payload.content).includes("belongs to another user")
      ),
      "session ownership enforced"
    );
    const early = interaction();
    early.customId = next.replace("sign_next", "sign_submit");
    await command.handleButtonPress(early);
    assert(
      early.calls.some((c: any) =>
        String(c.payload.content).includes("Review all pages")
      ),
      "consent cannot bypass required answers"
    );
    // Start a fresh form so the stale-event assertion is independent of button throttling.
    const fresh = interaction();
    await command.execute(fresh);
    event.id = "future-event";
    const stale = interaction();
    const freshPage = fresh.calls.find(
      (c: any) => c.method === "followUp" && c.payload.flags
    ).payload;
    stale.customId = freshPage.components
      .flatMap((r: any) => r.toJSON().components)
      .find((b: any) => b.label === "Next").custom_id;
    await command.handleButtonPress(stale);
    assert(
      stale.calls.some((c: any) =>
        String(c.payload.content).includes("no longer active")
      ),
      "old form cannot apply to future event"
    );
    assertEqual(saves, 0, "no unauthorised or incomplete application saved");
  } finally {
    Object.assign(eventService, originals);
    config.channels.eventSignUps = channel;
  }
});
