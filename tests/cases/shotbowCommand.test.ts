import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { ShotbowStatusAPI } from "../../src/api/ShotbowStatusAPI";
import ShotbowCommand, {
  buildShotbowEmbed,
} from "../../src/commands/ShotbowCommand";
import {
  buildApprovedKnowledge,
  retrieveApprovedKnowledge,
} from "../../src/ai/Knowledge";

function json(body: unknown, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

// Existing ping tests isolate Crafty; the official endpoint has its own tests below.
function pingOnly(
  fetcher: typeof fetch,
  now = Date.now,
  token = () => undefined as string | undefined,
  timeoutMs = 5_000
) {
  return new ShotbowStatusAPI(
    (url, init) =>
      String(url).startsWith("https://shotbow.net/")
        ? Promise.resolve(new Response(null, { status: 404 }))
        : fetcher(url, init),
    now,
    token,
    timeoutMs
  );
}

function online(online = 142, max = 1000) {
  return { success: true, data: { players: { online, max } } };
}

test("Shotbow validates online and zero-player responses", async () => {
  for (const n of [142, 0]) {
    const api = pingOnly(async () => json(online(n)));
    const result = await api.getStatus();
    assert(result.kind === "online" && result.online === n, "Online count");
    assert(
      buildShotbowEmbed(result)
        .toJSON()
        .description?.includes(`**Players:** ${n}/1,000`),
      "Formatted count"
    );
  }
  const proxy = buildShotbowEmbed({ kind: "online", online: 42, max: 1 });
  assert(
    proxy.toJSON().description?.includes("**Players:** 42\n"),
    "Proxy capacity omitted"
  );
});

test("Shotbow only treats explicit Minecraft server errors as offline", async () => {
  const body = { success: false, message: "Server is offline" };
  const api = pingOnly(async () => json(body, 404));
  assert((await api.getStatus()).kind === "offline", "Explicit offline");
  for (const status of [401, 403, 429, 500, 502, 503]) {
    const failure = pingOnly(async () => json(body, status));
    assert(
      (await failure.getStatus()).kind === "unavailable",
      "Provider failure"
    );
  }
  for (const body of [
    { success: false },
    { success: false, message: "Not found" },
    { success: false, message: "Request timed out" },
    { success: false, message: "Internal server error" },
    { success: true, data: {} },
    { success: true, data: { players: { online: "1", max: 100 } } },
    online(-1),
    online(1.5),
    online(1, -1),
    null,
  ]) {
    const failure = pingOnly(async () => json(body));
    assert(
      (await failure.getStatus()).kind === "unavailable",
      "Malformed or ambiguous"
    );
  }
});

test("Shotbow handles invalid JSON, network failure and request timeout", async () => {
  const malformed = pingOnly(async () => new Response("<html>"));
  assert((await malformed.getStatus()).kind === "unavailable", "Non-JSON");
  const network = pingOnly(async () => {
    throw new Error("Network error");
  });
  assert((await network.getStatus()).kind === "unavailable", "Network failure");
  const timeout = pingOnly(
    async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("Aborted"))
        );
      }),
    Date.now,
    () => undefined,
    5
  );
  assert((await timeout.getStatus()).kind === "unavailable", "Timeout");
});

test("Shotbow coalesces concurrent requests and caches results for 30 seconds", async () => {
  let now = 0;
  let calls = 0;
  const api = pingOnly(
    async () => {
      calls++;
      return json(online());
    },
    () => now
  );
  const a = api.getStatus();
  const b = api.getStatus();
  assert(a === b, "Same pending request");
  await Promise.all([a, b]);
  now = 29_999;
  await api.getStatus();
  assert(calls === 1, "Cached");
  now = 30_000;
  await api.getStatus();
  assert(Number(calls) === 2, "Refresh at expiry");
});

test("Shotbow respects Retry-After seconds and HTTP dates", async () => {
  for (const header of ["90", new Date(90_000).toUTCString()]) {
    let now = 0;
    let calls = 0;
    const api = pingOnly(
      async () => {
        calls++;
        return calls === 1
          ? json({}, 429, { "Retry-After": header })
          : json(online());
      },
      () => now
    );
    assert((await api.getStatus()).kind === "unavailable", "429");
    now = 89_999;
    assert((await api.getStatus()).kind === "unavailable", "Blocked");
    assert(calls === 1, "No retry during limit");
    now = 90_000;
    assert((await api.getStatus()).kind === "online", "Retry after limit");
    assert(Number(calls) === 2, "One retry");
  }
  let now = 0;
  let calls = 0;
  const api = pingOnly(
    async () => {
      calls++;
      return json({}, 429);
    },
    () => now
  );
  await api.getStatus();
  now = 29_999;
  await api.getStatus();
  assert(calls === 1, "Default backoff");
});

test("Shotbow uses fixed Java address and optional Bearer authentication", async () => {
  for (const token of [undefined, "  test-token  ", " "]) {
    const api = pingOnly(
      async (input, init) => {
        const url = new URL(String(input));
        assert(url.origin === "https://api.crafty.gg", "Fixed provider");
        assert(url.pathname === "/api/v2/servers/ping", "Ping endpoint");
        assert(
          url.searchParams.get("ip") === "play.shotbow.net",
          "Verified address"
        );
        assert(url.searchParams.get("edition") === "java", "Java edition");
        assert(init?.redirect === "error", "Do not forward credentials");
        assert(
          new Headers(init?.headers).get("authorization") ===
            (token?.trim() ? "Bearer test-token" : null),
          "Optional authentication"
        );
        return json(online());
      },
      Date.now,
      () => token
    );
    assert((await api.getStatus()).kind === "online", "Request validated");
  }
});

test("Shotbow command defers publicly and edits with a clean embed for every outcome", async () => {
  for (const [body, expected] of [
    [online(), "🟢 Online"],
    [{ success: false, message: "Server is offline" }, "🔴 Offline"],
    [{ success: false }, "🟠 Status unavailable"],
  ] as const) {
    let deferred = false;
    let reply: any;
    const api = pingOnly(async () => {
      assert(deferred, "Defer before request");
      return json(body);
    });
    const command = new ShotbowCommand(api);
    assert(command.data.toJSON().options?.length === 0, "No options");
    assert(
      command.data.toJSON().default_member_permissions == null,
      "All members"
    );
    await command.execute({
      deferReply: async (options: any) => {
        assert(!options.ephemeral && !options.flags, "Public defer");
        deferred = true;
      },
      editReply: async (payload: any) => {
        reply = payload;
      },
    } as any);
    assert(reply?.embeds?.length === 1, "Single embed");
    const embed = reply.embeds[0].toJSON();
    assert(
      embed.title === "Shotbow" && embed.description.startsWith(expected),
      "Correct status"
    );
    assert(
      reply.flags == null && reply.allowedMentions.parse.length === 0,
      "Public, no mentions"
    );
  }
});

test("Navi retrieves the Shotbow status command for common player questions", () => {
  const knowledge = buildApprovedKnowledge(process.cwd());
  for (const question of [
    "Is Shotbow online?",
    "Is Shotbow down?",
    "How many players are on Shotbow?",
    "How do I check the server status?",
  ]) {
    const chunks = retrieveApprovedKnowledge(knowledge, question, false);
    assert(
      chunks.some((chunk) => chunk.heading.includes("`/shotbow`")),
      question
    );
  }
});

const officialPopulation = {
  all: 39,
  all_us: 39,
  all_eu: 0,
  minez: 6,
  smash: 0,
  annihilation: 31,
  gg: 0,
  slaughter: 0,
  ghostcraft: 0,
  lobby: 2,
  minez_us: 6,
  annihilation_us: 31,
  hcfactions: 4,
};

test("Shotbow displays official totals and only populated allowlisted modes", async () => {
  const api = new ShotbowStatusAPI(
    async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === "shotbow.net") {
        assert(url.pathname === "/serverList.json", "Official endpoint");
        assert(url.searchParams.get("t") === "12345", "Cache buster");
        assert(
          !new Headers(init?.headers).has("authorization"),
          "No Crafty credentials"
        );
        return json(officialPopulation);
      }
      return json(online(42));
    },
    () => 12345,
    () => "test-token"
  );
  const status = await api.getStatus();
  assert(status.kind === "online", "Ping succeeds");
  const desc = buildShotbowEmbed(status).toJSON().description ?? "";
  assert(desc.includes("**Players:** 39/1,000"), "Official network total");
  assert(
    desc.includes("**Annihilation:** 31\n**MineZ:** 6"),
    "Populated modes"
  );
  for (const ignored of [
    "SMASH",
    "GG",
    "Slaughter",
    "Ghostcraft",
    "lobby",
    "hcfactions",
    "_us",
  ]) {
    assert(!desc.includes(ignored), `Omit ${ignored}`);
  }
});

test("Shotbow displays all six supported modes when populated, sorted by population", async () => {
  const api = new ShotbowStatusAPI(async (input) =>
    String(input).startsWith("https://shotbow.net/")
      ? json({
          all: 21,
          minez: 1,
          smash: 2,
          annihilation: 3,
          gg: 4,
          slaughter: 5,
          ghostcraft: 6,
        })
      : json(online(21))
  );
  const status = await api.getStatus();
  assert(
    status.population?.modes.map((mode) => mode.name).join(",") ===
      "Ghostcraft,Slaughter,GG,Annihilation,SMASH,MineZ",
    "All supported modes"
  );
});

test("Shotbow omits invalid mode counts and zero counts without inventing data", async () => {
  const api = new ShotbowStatusAPI(async (input) =>
    String(input).startsWith("https://shotbow.net/")
      ? json({
          all: 5,
          minez: "3",
          smash: -1,
          annihilation: 0,
          gg: 1.5,
          slaughter: 6,
        })
      : json(online(5))
  );
  const status = await api.getStatus();
  assert(status.population?.modes.length === 0, "No invalid or absent modes");
  assert(
    !buildShotbowEmbed(status).toJSON().description?.includes("**MineZ:**"),
    "No zero rows"
  );
});

test("Shotbow keeps normal ping when official endpoint fails or is malformed", async () => {
  for (const response of [
    () => json({ all: "39", minez: 6 }),
    () => json({}, 503),
    () => new Response("<html>"),
    () => {
      throw new Error("Network failure");
    },
  ]) {
    const api = new ShotbowStatusAPI(async (input) =>
      String(input).startsWith("https://shotbow.net/")
        ? response()
        : json(online())
    );
    const status = await api.getStatus();
    assert(
      status.kind === "online" && !status.population,
      "Normal ping retained"
    );
  }
});

test("Shotbow preserves official counts when Crafty is unavailable or contradictory", async () => {
  for (const ping of [
    () => json({}, 503),
    () => json({ success: false, message: "Server is offline" }, 404),
  ]) {
    const api = new ShotbowStatusAPI(async (input) =>
      String(input).startsWith("https://shotbow.net/")
        ? json(officialPopulation)
        : ping()
    );
    const status = await api.getStatus();
    const desc = buildShotbowEmbed(status).toJSON().description ?? "";
    assert(status.kind === "unavailable", "Reachability not confirmed");
    assert(
      desc.includes("**Reported players:** 39") &&
        desc.includes("**MineZ:** 6"),
      "Official data retained"
    );
  }
  const empty = new ShotbowStatusAPI(async (input) =>
    String(input).startsWith("https://shotbow.net/")
      ? json({ all: 0 })
      : json({ success: false, message: "Server is offline" }, 404)
  );
  assert(
    (await empty.getStatus()).kind === "offline",
    "Empty population does not contradict ping"
  );
});

test("Shotbow coalesces both requests and respects independent provider limits", async () => {
  let now = 0;
  let crafty = 0;
  let official = 0;
  const api = new ShotbowStatusAPI(
    async (input) => {
      if (String(input).startsWith("https://shotbow.net/")) {
        official++;
        return official === 1
          ? json({}, 429, { "Retry-After": "60" })
          : json(officialPopulation);
      }
      crafty++;
      return crafty === 1
        ? json({}, 429, { "Retry-After": "90" })
        : json(online());
    },
    () => now
  );
  await Promise.all([api.getStatus(), api.getStatus()]);
  assert(crafty === 1 && official === 1, "One request per source");
  now = 30_000;
  await api.getStatus();
  assert(crafty === 1 && official === 1, "Both limits respected");
  now = 60_000;
  const status = await api.getStatus();
  assert(
    status.population?.total === 39 && crafty === 1 && Number(official) === 2,
    "Official recovers independently"
  );
  now = 90_000;
  assert(
    (await api.getStatus()).kind === "online" && Number(crafty) === 2,
    "Crafty recovers"
  );
});

