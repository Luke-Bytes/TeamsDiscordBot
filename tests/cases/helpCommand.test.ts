import { test } from "../framework/test";
import { assert } from "../framework/assert";
import HelpCommand from "../../src/commands/HelpCommand";
import { CommandHandler } from "../../src/commands/CommandHandler";
import { createChatInputInteraction } from "../framework/mocks";
import { Command } from "../../src/commands/CommandInterface";
import { ConfigManager } from "../../src/ConfigManager";

const makeCmd = (
  name: string,
  description: string,
  executeSource: string
): Command => {
  const exec = new Function(`return async function(){ ${executeSource} }`)();
  return {
    data: {} as any,
    name,
    description,
    buttonIds: [],
    execute: exec as any,
  } as Command;
};

test("/help defaults to user commands", async () => {
  const help = new HelpCommand(() => [
    makeCmd("ask", "Ask Navi", "config.dev.enabled"),
    makeCmd("nickname", "Set nickname", ""),
    makeCmd("register", "Register", ""),
    makeCmd("performance", "Perf", ""),
    makeCmd("stats", "Stats", ""),

    makeCmd("vc", "Voice channels", ""),
    makeCmd("future-command", "New feature", ""),
    makeCmd("cleanup", "Cleanup", "PermissionsUtil.hasRole()"),
  ]);

  const i = createChatInputInteraction("U1", { strings: {} }) as any;
  await help.execute(i);
  const reply = i.replies.find((r: any) => r.type === "reply");
  const fields = reply?.payload?.embeds?.[0]?.data?.fields ?? [];
  const field = (name: string) =>
    fields.find((f: any) => f.name === name)?.value ?? "";
  assert(
    field("Getting started & information").includes("**/ask** — Ask Navi"),
    "Includes Navi as a user command"
  );
  assert(
    field("Joining games & events").includes("**/register**"),
    "Registration is grouped with joining games"
  );
  assert(
    field("Profiles, stats & rankings").includes("**/stats**"),
    "Stats section"
  );
  assert(
    field("Minecraft accounts & player records").includes("**/nickname**"),
    "Account section"
  );
  assert(field("Utilities").includes("**/vc**"), "Utilities section");
  assert(
    field("Other commands").includes("**/future-command**"),
    "New user commands are not hidden"
  );
  const text = fields.map((f: any) => f.value).join("\n");
  assert(!text.includes("/performance"), "Excludes dev command");
  assert(!text.includes("/cleanup"), "Excludes organiser command");
  for (const name of [
    "ask",
    "register",
    "stats",
    "nickname",
    "vc",
    "future-command",
  ]) {
    assert(
      text.split(`**/${name}**`).length === 2,
      `Shows /${name} exactly once`
    );
  }
});

test("/help lists all reviewed executable player paths from the actual registry", async () => {
  const handler = new CommandHandler();
  handler.loadCommands();
  const i = createChatInputInteraction("U1", { strings: {} }) as any;
  await handler.helpCommand.execute(i);
  const fields = i.replies.find((r: any) => r.type === "reply")?.payload
    ?.embeds?.[0]?.toJSON().fields ?? [];
  assert(
    fields.find((field: any) => field.name === "Utilities")?.value.includes(
      "**/game request** — Generate a formatted game request to send to Shotbow hosts"
    ),
    "External host request template is described accurately under utilities"
  );
  const paths = fields.flatMap((field: any) =>
    [...field.value.matchAll(/\*\*\/([^*]+)\*\*/g)].map((m: any) => m[1])
  );
  const expected = [
    "ask", "website", "wiki", "shotbow", "maps",
    "register", "unregister", "registered", "sign up", "sign edit",
    "sign view", "sign withdraw", "spectate", "need", "game request",
    "captainnominate", "class ban", "class bans", "team list", "teamless",
    "plan make", "missing", "mvp vote", "forfeit",
    "profile", "profilecreate", "stats", "leaderboards", "titles", "wrapped",
    "season view", "season status", "igns", "name history", "nickname", "punished",
    "vc create", "vc delete", "vc lock", "vc unlock", "vc add", "vc remove",
    "vc limit", "vc info", "timestamp", "coinflip", "game scenario guide",
    "game scenario open", "game scenario report-class",
  ];
  assert(
    JSON.stringify(paths.sort()) === JSON.stringify(expected.sort()),
    `Player paths differ: ${JSON.stringify(paths)}`
  );

  const organiser = createChatInputInteraction("U2", {
    strings: { scope: "organiser" },
  }) as any;
  await handler.helpCommand.execute(organiser);
  const description = organiser.replies.find((r: any) => r.type === "reply")
    ?.payload?.embeds?.[0]?.toJSON().description ?? "";
  for (const name of ["team generate", "season configure", "game scenario cancel"]) {
    assert(description.includes(`/${name} —`), `Includes organiser /${name}`);
  }
  for (const name of expected) {
    assert(!description.includes(`/${name} —`), `Excludes player /${name}`);
  }
});

test("/help paginates large registries without dropping commands or exceeding Discord limits", async () => {
  for (const scope of ["user", "organiser"] as const) {
    const commands = Array.from({ length: 180 }, (_, n) =>
      makeCmd(`command-${n}`, "Description ".repeat(8), scope === "organiser" ? "PermissionsUtil.hasRole()" : ""));
    const pages: any[] = [];
    const send = async (payload: any) => { pages.push(payload.embeds[0]); };
    await new HelpCommand(() => commands).execute({
      options: { getString: () => scope },
      reply: send,
      followUp: send,
    } as any);
    assert(pages.length > 1, "Large registry is paginated");
    const text = pages.map((page) => {
      const data = page.toJSON();
      assert(page.length <= 6000 && (data.description?.length ?? 0) <= 4096, "Embed limits");
      assert((data.fields ?? []).length <= 25 && (data.fields ?? []).every((field: any) => field.value.length <= 1024), "Field limits");
      return [data.description, ...(data.fields ?? []).map((field: any) => field.value)].join("\n");
    }).join("\n");
    for (const command of commands) {
      assert(text.includes(scope === "user" ? `**/${command.name}**` : `/${command.name} —`), "No omitted command");
    }
  }
});

test("/help organisers shows only organiser commands", async () => {
  const help = new HelpCommand(() => [
    makeCmd("cleanup", "Cleanup", "PermissionsUtil.hasRole()"),
    makeCmd("stats", "Stats", ""),
  ]);

  const i = createChatInputInteraction("U2", {
    strings: { scope: "organiser" },
  }) as any;
  await help.execute(i);
  const reply = i.replies.find((r: any) => r.type === "reply");
  const desc = reply?.payload?.embeds?.[0]?.data?.description ?? "";
  assert(desc.includes("/cleanup"), "Includes organiser command");
  assert(!desc.includes("/stats"), "Excludes user command");
});

test("/help dev shows dev commands and notes dev disabled", async () => {
  const help = new HelpCommand(() => [
    makeCmd("ask", "Ask Navi", "config.dev.enabled"),
    makeCmd("test", "Test", "isDebugEnabled()"),
  ]);
  const origConfig = ConfigManager.getConfig.bind(ConfigManager);
  (ConfigManager as any).getConfig = () => ({
    ...origConfig(),
    dev: { enabled: false, guildId: "dev" },
  });

  try {
    const i = createChatInputInteraction("U3", {
      strings: { scope: "dev" },
    }) as any;
    await help.execute(i);
    const reply = i.replies.find((r: any) => r.type === "reply");
    const embed = reply?.payload?.embeds?.[0]?.data ?? {};
    assert(
      String(embed.description || "").includes("/test"),
      "Includes dev command"
    );
    assert(
      !String(embed.description || "").includes("/ask"),
      "Excludes Navi from dev commands"
    );
    assert(
      String(embed.footer?.text || "").includes("Dev mode is disabled"),
      "Footer notes dev disabled"
    );
  } finally {
    (ConfigManager as any).getConfig = origConfig;
  }
});
