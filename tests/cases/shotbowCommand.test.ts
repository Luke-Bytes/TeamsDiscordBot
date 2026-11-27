import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { generateKeyPairSync } from "node:crypto";
import { ShotbowStatusAPI } from "../../src/api/ShotbowStatusAPI";
import { MinecraftServicesAPI } from "../../src/api/MinecraftServicesAPI";
import ShotbowCommand, {
  addMinecraftServices,
  buildShotbowEmbed,
} from "../../src/commands/ShotbowCommand";
import {
  buildApprovedKnowledge,
  retrieveApprovedKnowledge,
} from "../../src/ai/Knowledge";

function json(body: unknown, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

// Ping tests isolate MCStatus.io; the official endpoint has its own tests below.
function pingOnly(fetcher: typeof fetch, now = Date.now, timeoutMs = 5_000) {
  return new ShotbowStatusAPI(
    (url, init) =>
      String(url).startsWith("https://shotbow.net/")
        ? Promise.resolve(new Response(null, { status: 404 }))
        : fetcher(url, init),
    now,
    timeoutMs
  );
}

function online(online = 142, max = 1000) {
  return { online: true, players: { online, max }, eula_blocked: false };
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
    proxy.toJSON().description?.endsWith("**Players:** 42"),
    "Proxy capacity omitted"
  );
});

test("Shotbow only treats explicit Minecraft server errors as offline", async () => {
  const body = { online: false, eula_blocked: false };
  const api = pingOnly(async () => json(body));
  assert((await api.getStatus()).kind === "offline", "Explicit offline");
  for (const status of [401, 403, 404, 429, 500, 502, 503]) {
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
    { online: true },
    { online: true, players: { online: "1", max: 100 } },
    { online: false },
    { online: false, eula_blocked: true },
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

test("Shotbow uses fixed Java address without credentials", async () => {
  const api = pingOnly(async (input, init) => {
    const url = new URL(String(input));
    assert(url.origin === "https://api.mcstatus.io", "Fixed provider");
    assert(
      url.pathname === "/v2/status/java/play.shotbow.net",
      "Verified Java address"
    );
    assert(init?.redirect === "error", "No redirects");
    assert(!new Headers(init?.headers).has("authorization"), "No credentials");
    return json(online());
  });
  assert((await api.getStatus()).kind === "online", "Request validated");
});

test("Shotbow command defers publicly and edits with a clean embed for every outcome", async () => {
  for (const [body, expected] of [
    [online(), "🟢 Online"],
    [{ online: false, eula_blocked: false }, "🔴 Address unreachable from status provider"],
    [{ success: false }, "🟠 Status unavailable"],
  ] as const) {
    let deferred = false;
    let reply: any;
    const api = pingOnly(async () => {
      assert(deferred, "Defer before request");
      return json(body);
    });
    const command = new ShotbowCommand(
      api,
      new MinecraftServicesAPI(async () => json({}, 503))
    );
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
      embed.fields?.[0]?.name === "Minecraft services" &&
        embed.fields[0].value.includes("Endpoint error"),
      "Auth check failure does not hide Shotbow status"
    );
    assert(
      embed.description.includes("`play.shotbow.net`"),
      "Server address visible in every outcome"
    );
    assert(embed.footer?.text.includes("actual sign-in") && embed.footer.text.includes("not tested"), "Endpoint-only disclaimer");
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
          "No credentials"
        );
        return json(officialPopulation);
      }
      return json(online(42));
    },
    () => 12345
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

test("Shotbow preserves official counts when MCStatus.io is unavailable or contradictory", async () => {
  for (const [ping, reachability] of [
    [() => json({}, 503), "unavailable"],
    [() => json({ online: false, eula_blocked: false }), "offline"],
  ] as const) {
    const api = new ShotbowStatusAPI(async (input) =>
      String(input).startsWith("https://shotbow.net/")
        ? json(officialPopulation)
        : ping()
    );
    const status = await api.getStatus();
    const desc = buildShotbowEmbed(status).toJSON().description ?? "";
    assert(
      status.kind === "reported-online" && status.reachability === reachability,
      "Network activity and address reachability distinguished"
    );
    assert(
      desc.includes("🟢 Online (reported by Shotbow)") &&
        desc.includes("**Players:** 39") &&
        desc.includes("**MineZ:** 6"),
      "Official data retained"
    );
    assert(
      desc.includes(
        reachability === "offline"
          ? "Login address unreachable"
          : "Login address could not be verified"
      ),
      "Accurate reachability warning"
    );
  }
  const empty = new ShotbowStatusAPI(async (input) =>
    String(input).startsWith("https://shotbow.net/")
      ? json({ all: 0 })
      : json({ online: false, eula_blocked: false })
  );
  assert(
    (await empty.getStatus()).kind === "offline",
    "Empty population does not contradict ping"
  );
});

test("Shotbow logs safe provider diagnostics only for actual requests", async () => {
  const messages: string[] = [];
  const secret = "secret-token-not-for-logs";
  const api = new ShotbowStatusAPI(
    async (input) => {
      if (String(input).startsWith("https://shotbow.net/")) {
        throw Object.assign(new Error(secret), {
          cause: { code: "ENOTFOUND", message: secret },
        });
      }
      return json({ message: secret }, 401);
    },
    () => 0,
    5_000,
    (message) => messages.push(message)
  );
  assert((await api.getStatus()).kind === "unavailable", "Both checks fail");
  await api.getStatus();
  assert(messages.length === 2, "Cached failures do not log again");
  assert(
    messages.some((message) =>
      message.includes("source=mcstatus-ping reason=http-error status=401")
    ),
    "Authentication failure identified"
  );
  assert(
    messages.some((message) =>
      message.includes(
        "source=shotbow-population reason=request-failed code=ENOTFOUND"
      )
    ),
    "Provider DNS failure identified"
  );
  assert(
    messages.every((message) => !message.includes(secret)),
    "No secrets"
  );
});

test("Minecraft services uses credential-free public probes and caches independently", async () => {
  let now = 0;
  const key = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ format: "der", type: "spki" }).toString("base64");
  let microsoftCalls = 0;
  let sessionCalls = 0;
  let keysCalls = 0;
  const messages: string[] = [];
  const api = new MinecraftServicesAPI(
    async (input, init) => {
      const url = new URL(String(input));
      assert(init?.method === "GET", "Read-only");
      assert(init?.redirect === "error", "No redirects");
      assert(
        !new Headers(init?.headers).has("authorization"),
        "No credentials"
      );
      if (url.hostname === "login.live.com") {
        assert(
          url.pathname === "/.well-known/openid-configuration",
          "Discovery endpoint"
        );
        microsoftCalls++;
        return microsoftCalls === 1
          ? json({}, 429, { "Retry-After": "120" })
          : json({
              issuer: "https://login.live.com",
              authorization_endpoint:
                "https://login.live.com/oauth20_authorize.srf",
              token_endpoint: "https://login.live.com/oauth20_token.srf",
            });
      }
      if (url.hostname === "sessionserver.mojang.com") {
        sessionCalls++;
        assert(
          url.pathname === "/session/minecraft/hasJoined" &&
            url.searchParams.get("username") === "FWStatusProbe" &&
            /^[a-f0-9]{40}$/.test(url.searchParams.get("serverId") ?? ""),
          "Synthetic session verification"
        );
        return new Response(null, { status: 204 });
      }
      assert(
        url.hostname === "api.minecraftservices.com" &&
          url.pathname === "/publickeys",
        "Public keys endpoint"
      );
      keysCalls++;
      return json({
        profilePropertyKeys: [{ publicKey: key }],
        playerCertificateKeys: [{ publicKey: key }],
      });
    },
    () => now,
    5_000,
    (message) => messages.push(message)
  );
  const [first, second] = await Promise.all([api.getStatus(), api.getStatus()]);
  assert(first === second, "Concurrent calls coalesced");
  assert(
    first.microsoftProbe === "unknown" &&
      first.sessionProbe === "responding" &&
      first.keysProbe === "responding",
    "Microsoft failure does not erase direct evidence"
  );
  now = 60_000;
  await api.getStatus();
  assert(
    microsoftCalls === 1 && sessionCalls === 2 && keysCalls === 2,
    "Microsoft backoff independent of other probes"
  );
  now = 120_000;
  const status = await api.getStatus();
  assert(
    status.microsoftProbe === "responding" &&
      status.sessionProbe === "responding" &&
      status.keysProbe === "responding",
    "All direct checks succeed"
  );
  const field =
    addMinecraftServices(
      buildShotbowEmbed({ kind: "online", online: 39, max: 100 }),
      status
    ).toJSON().fields?.[0]?.value ?? "";
  assert(
    field.split("\n").length === 3 &&
      field
        .split("\n")
        .every((line) => line.startsWith("🟢") && line.endsWith("Endpoint responding")),
    "Green indicates endpoint response only"
  );
  assert(
    messages.some((message) =>
      message.includes("source=microsoft-login reason=http-error status=429")
    ),
    "Rate limit logged"
  );
});

test("Minecraft services handles invalid responses, endpoint errors and unknown states", async () => {
  const messages: string[] = [];
  const api = new MinecraftServicesAPI(
    async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "login.live.com") {
        return json({ issuer: "https://invalid.example" });
      }
      if (url.hostname === "sessionserver.mojang.com") {
        return json({}, 503);
      }
      return json({ profilePropertyKeys: [] });
    },
    Date.now,
    5_000,
    (message) => messages.push(message)
  );
  const status = await api.getStatus();
  assert(
    status.sessionProbe === "error" &&
      status.microsoftProbe === "unknown" &&
      status.keysProbe === "unknown",
    "Partial results preserved"
  );
  const field =
    addMinecraftServices(
      buildShotbowEmbed({ kind: "offline" }),
      status
    ).toJSON().fields?.[0]?.value ?? "";
  assert(
    field.includes("Endpoint error") &&
      field.includes("Check unavailable") &&
      !field.includes("🟢"),
    "Failed checks not shown green"
  );
  assert(messages.length === 3, "Every failed source logged");
});

test("Minecraft public keys reject malformed key material independently of other probes", async () => {
  const api = new MinecraftServicesAPI(async (input) => {
    const url = String(input);
    if (url.includes("hasJoined")) return new Response(null, { status: 204 });
    if (url.includes("publickeys")) return json({
      profilePropertyKeys: [{ publicKey: "not a key" }],
      playerCertificateKeys: [{ publicKey: "bm90LWEtb2tleQ==" }],
    });
    return json({}, 403);
  });
  const result = await api.getStatus();
  assert(result.keysProbe === "unknown" && result.sessionProbe === "responding", "Malformed keys cannot erase independent evidence or appear healthy");
});

test("Throwing diagnostic logger does not erase independent provider results", async () => {
  const warn = () => { throw new Error("logger unavailable"); };
  const api = new ShotbowStatusAPI(async (input) =>
    String(input).includes("shotbow.net/serverList")
      ? json({}, 503) : json(online(12, 100)),
    Date.now, 5000, warn);
  assert((await api.getStatus()).kind === "online", "Ping survives failure of population logging");
  const services = new MinecraftServicesAPI(async (input) =>
    String(input).includes("hasJoined") ? new Response(null, { status: 204 }) : json({}, 503),
    Date.now, 5000, warn);
  const result = await services.getStatus();
  assert(result.sessionProbe === "responding" && result.keysProbe === "error" && result.microsoftProbe === "error", "Each endpoint retains independent evidence");
});

test("Shotbow command preserves successful results on unexpected diagnostic rejection", async () => {
  for (const failShotbow of [true, false]) {
    const shotbow = { getStatus: async () => {
      if (failShotbow) throw new Error("unexpected");
      return { kind: "online", online: 12, max: 100 };
    } } as unknown as ShotbowStatusAPI;
    const services = { getStatus: async () => {
      if (!failShotbow) throw new Error("unexpected");
      return { sessionProbe: "responding", keysProbe: "unknown", microsoftProbe: "unknown" };
    } } as unknown as MinecraftServicesAPI;
    let reply: any;
    await new ShotbowCommand(shotbow, services).execute({
      deferReply: async () => {},
      editReply: async (payload: any) => { reply = payload; },
    } as any);
    const embed = reply.embeds[0].toJSON();
    assert(embed.description.includes(failShotbow ? "Status unavailable" : "12/100"), "Shotbow evidence preserved");
    assert(embed.fields[0].value.includes(failShotbow ? "Endpoint responding" : "Check unavailable"), "Service evidence preserved");
  }
});

test("Shotbow zero official players alone do not establish reachability", async () => {
  const api = new ShotbowStatusAPI(async (input) =>
    String(input).startsWith("https://shotbow.net/")
      ? json({ all: 0 })
      : json({}, 503)
  );
  const status = await api.getStatus();
  assert(
    status.kind === "unavailable" && status.population?.total === 0,
    "Zero players does not prove online or offline"
  );
});

test("Shotbow coalesces both requests and respects independent provider limits", async () => {
  let now = 0;
  let ping = 0;
  let official = 0;
  const api = new ShotbowStatusAPI(
    async (input) => {
      if (String(input).startsWith("https://shotbow.net/")) {
        official++;
        return official === 1
          ? json({}, 429, { "Retry-After": "60" })
          : json(officialPopulation);
      }
      ping++;
      return ping === 1
        ? json({}, 429, { "Retry-After": "90" })
        : json(online());
    },
    () => now
  );
  await Promise.all([api.getStatus(), api.getStatus()]);
  assert(ping === 1 && official === 1, "One request per source");
  now = 30_000;
  await api.getStatus();
  assert(ping === 1 && official === 1, "Both limits respected");
  now = 60_000;
  const status = await api.getStatus();
  assert(
    status.population?.total === 39 && ping === 1 && Number(official) === 2,
    "Official recovers independently"
  );
  now = 90_000;
  assert(
    (await api.getStatus()).kind === "online" && Number(ping) === 2,
    "MCStatus.io recovers"
  );
});
