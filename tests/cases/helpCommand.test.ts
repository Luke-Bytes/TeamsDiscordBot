import { test } from "../framework/test";
import { assert } from "../framework/assert";
import HelpCommand from "../../src/commands/HelpCommand";
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
    makeCmd("nickname", "Set nickname", ""),
    makeCmd("register", "Register", ""),
    makeCmd("performance", "Perf", ""),
  ]);

  const i = createChatInputInteraction("U1", { strings: {} }) as any;
  await help.execute(i);
  const reply = i.replies.find((r: any) => r.type === "reply");
  const desc = reply?.payload?.embeds?.[0]?.data?.description ?? "";
  assert(desc.includes("/nickname"), "Includes user command");
  assert(desc.includes("/register"), "Includes user command");
  assert(!desc.includes("/performance"), "Excludes dev command");
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
      String(embed.footer?.text || "").includes("Dev mode is disabled"),
      "Footer notes dev disabled"
    );
  } finally {
    (ConfigManager as any).getConfig = origConfig;
  }
});
