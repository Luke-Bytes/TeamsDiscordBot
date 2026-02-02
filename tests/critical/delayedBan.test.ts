import { test } from "../framework/test";
import { assert } from "../framework/assert";
import ClassbanCommand from "../../src/commands/ClassbanCommand";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import {
  createChatInputInteraction,
  FakeGuild,
  FakeGuildMember,
} from "../framework/mocks";
import { ConfigManager } from "../../src/ConfigManager";
import { DiscordUtil } from "../../src/util/DiscordUtil";
import fs from "fs";
import path from "path";

const namesPath = path.resolve(process.cwd(), "organisers-hosts.json");

function writeNamesFile(data: object) {
  fs.writeFileSync(namesPath, JSON.stringify(data, null, 2), "utf8");
}

function safeReadNamesFile(): string | null {
  try {
    return fs.readFileSync(namesPath, "utf8");
  } catch {
    return null;
  }
}

function setupDelayedGame(phase = 3) {
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.announced = true;
  game.classBanMode = "shared";
  game.setClassBanLimit(2);
  game.settings.delayedBan = phase;
  return game;
}

function setupCaptains(guild: FakeGuild) {
  const cfg = ConfigManager.getConfig();
  const redM = new FakeGuildMember("RC");
  redM.roles.add(cfg.roles.captainRole);
  redM.roles.add(cfg.roles.redTeamRole);
  guild.addMember(redM);
  const blueM = new FakeGuildMember("BC");
  blueM.roles.add(cfg.roles.captainRole);
  blueM.roles.add(cfg.roles.blueTeamRole);
  guild.addMember(blueM);
  return { redM, blueM };
}

test("Delayed ban hides bans publicly and DMs host", async () => {
  const cmd = new ClassbanCommand();
  const originalNames = safeReadNamesFile();
  const guild = new FakeGuild() as any;
  const cfg = ConfigManager.getConfig();
  const sent: any[] = [];
  const dmSent: any[] = [];

  const origSend = DiscordUtil.sendMessage;
  const origGet = DiscordUtil.getGuildMember;
  try {
    writeNamesFile({
      organisers: [],
      hosts: [{ ign: "HostIgn", discordId: "HOST1" }],
    });
    const game = setupDelayedGame(3);
    game.host = "HostIgn";

    const { redM, blueM } = setupCaptains(guild);
    (game as any).teams = {
      RED: [{ discordSnowflake: "RC", ignUsed: "RedC", captain: true }],
      BLUE: [{ discordSnowflake: "BC", ignUsed: "BlueC", captain: true }],
      UNDECIDED: [],
    };

    (DiscordUtil as any).sendMessage = async (ch: string, content: any) =>
      sent.push({ ch, content });
    (DiscordUtil as any).getGuildMember = (i: any) =>
      (i.user.id === "RC" ? redM : blueM) as any;

    const client = {
      users: {
        fetch: async (_id: string) => ({
          send: async (payload: any) => dmSent.push(payload),
        }),
      },
    };

    const ir = createChatInputInteraction("RC", {
      guild,
      member: redM as any,
      subcommand: "ban",
      channelId: cfg.channels.redTeamChat,
      channel: { id: cfg.channels.redTeamChat, send: async () => {} } as any,
      strings: { class: "scout" },
    }) as any;
    ir.client = client;
    await cmd.execute(ir);

    const ib = createChatInputInteraction("BC", {
      guild,
      member: blueM as any,
      subcommand: "ban",
      channelId: cfg.channels.blueTeamChat,
      channel: { id: cfg.channels.blueTeamChat, send: async () => {} } as any,
      strings: { class: "warrior" },
    }) as any;
    ib.client = client;
    await cmd.execute(ib);

    const summary = sent.find((s) => s.ch === "gameFeed" && s.content?.embeds);
    assert(!!summary, "Posts delayed summary to game feed");
    const summaryEmbed = summary.content.embeds[0];
    assert(
      summaryEmbed?.title?.includes("Delayed Class Bans"),
      "Delayed summary title present"
    );
    assert(
      summaryEmbed?.description?.includes("Phase 3"),
      "Delayed summary includes phase"
    );
    assert(!summaryEmbed?.fields?.length, "Delayed summary does not list bans");

    assert(dmSent.length === 1, "DM sent to host once");
    const dmEmbed = dmSent[0].embeds?.[0];
    assert(dmEmbed?.description?.includes("Phase 3"), "Host DM mentions phase");
    assert(
      dmEmbed?.fields?.[0]?.value?.includes("Scout") &&
        dmEmbed?.fields?.[0]?.value?.includes("Warrior"),
      "Host DM includes banned classes"
    );
  } finally {
    if (originalNames === null) {
      try {
        fs.unlinkSync(namesPath);
      } catch {
        // ignore cleanup failure
      }
    } else {
      writeNamesFile(JSON.parse(originalNames));
    }
    (DiscordUtil as any).sendMessage = origSend;
    (DiscordUtil as any).getGuildMember = origGet;
  }
});

test("Delayed ban skips host DM when host is unknown", async () => {
  const cmd = new ClassbanCommand();
  const originalNames = safeReadNamesFile();
  const guild = new FakeGuild() as any;
  const cfg = ConfigManager.getConfig();
  const sent: any[] = [];
  let fetchCalled = false;

  const origSend = DiscordUtil.sendMessage;
  const origGet = DiscordUtil.getGuildMember;
  try {
    writeNamesFile({ organisers: [], hosts: [] });
    const game = setupDelayedGame(2);
    game.host = "MissingHost";

    const { redM, blueM } = setupCaptains(guild);
    (game as any).teams = {
      RED: [{ discordSnowflake: "RC", ignUsed: "RedC", captain: true }],
      BLUE: [{ discordSnowflake: "BC", ignUsed: "BlueC", captain: true }],
      UNDECIDED: [],
    };

    (DiscordUtil as any).sendMessage = async (ch: string, content: any) =>
      sent.push({ ch, content });
    (DiscordUtil as any).getGuildMember = (i: any) =>
      (i.user.id === "RC" ? redM : blueM) as any;

    const client = {
      users: {
        fetch: async (_id: string) => {
          fetchCalled = true;
          return { send: async () => {} };
        },
      },
    };

    const ir = createChatInputInteraction("RC", {
      guild,
      member: redM as any,
      subcommand: "ban",
      channelId: cfg.channels.redTeamChat,
      channel: { id: cfg.channels.redTeamChat, send: async () => {} } as any,
      strings: { class: "scout" },
    }) as any;
    ir.client = client;
    await cmd.execute(ir);

    const ib = createChatInputInteraction("BC", {
      guild,
      member: blueM as any,
      subcommand: "ban",
      channelId: cfg.channels.blueTeamChat,
      channel: { id: cfg.channels.blueTeamChat, send: async () => {} } as any,
      strings: { class: "warrior" },
    }) as any;
    ib.client = client;
    await cmd.execute(ib);

    assert(!fetchCalled, "No DM fetch when host ID missing");
    const summary = sent.find((s) => s.ch === "gameFeed" && s.content?.embeds);
    assert(!!summary, "Posts class ban summary when host DM fails");
    const summaryEmbed = summary.content.embeds[0];
    assert(
      summaryEmbed?.title?.includes("Class Bans Locked In"),
      "Fallback summary shows full bans"
    );
  } finally {
    if (originalNames === null) {
      try {
        fs.unlinkSync(namesPath);
      } catch {
        // ignore cleanup failure
      }
    } else {
      writeNamesFile(JSON.parse(originalNames));
    }
    (DiscordUtil as any).sendMessage = origSend;
    (DiscordUtil as any).getGuildMember = origGet;
  }
});

test("Delayed ban DM failure does not block announcements", async () => {
  const cmd = new ClassbanCommand();
  const originalNames = safeReadNamesFile();
  const guild = new FakeGuild() as any;
  const cfg = ConfigManager.getConfig();
  const sent: any[] = [];

  const origSend = DiscordUtil.sendMessage;
  const origGet = DiscordUtil.getGuildMember;
  try {
    writeNamesFile({
      organisers: [],
      hosts: [{ ign: "HostIgn", discordId: "HOST1" }],
    });
    const game = setupDelayedGame(4);
    game.host = "HostIgn";

    const { redM, blueM } = setupCaptains(guild);
    (game as any).teams = {
      RED: [{ discordSnowflake: "RC", ignUsed: "RedC", captain: true }],
      BLUE: [{ discordSnowflake: "BC", ignUsed: "BlueC", captain: true }],
      UNDECIDED: [],
    };

    (DiscordUtil as any).sendMessage = async (ch: string, content: any) =>
      sent.push({ ch, content });
    (DiscordUtil as any).getGuildMember = (i: any) =>
      (i.user.id === "RC" ? redM : blueM) as any;

    const client = {
      users: {
        fetch: async (_id: string) => {
          throw new Error("DM blocked");
        },
      },
    };

    const ir = createChatInputInteraction("RC", {
      guild,
      member: redM as any,
      subcommand: "ban",
      channelId: cfg.channels.redTeamChat,
      channel: { id: cfg.channels.redTeamChat, send: async () => {} } as any,
      strings: { class: "scout" },
    }) as any;
    ir.client = client;
    await cmd.execute(ir);

    const ib = createChatInputInteraction("BC", {
      guild,
      member: blueM as any,
      subcommand: "ban",
      channelId: cfg.channels.blueTeamChat,
      channel: { id: cfg.channels.blueTeamChat, send: async () => {} } as any,
      strings: { class: "warrior" },
    }) as any;
    ib.client = client;
    await cmd.execute(ib);

    const summary = sent.find((s) => s.ch === "gameFeed" && s.content?.embeds);
    assert(!!summary, "Posts class ban summary even if DM fails");
    const summaryEmbed = summary.content.embeds[0];
    assert(
      summaryEmbed?.title?.includes("Class Bans Locked In"),
      "Fallback summary shows full bans"
    );
  } finally {
    if (originalNames === null) {
      try {
        fs.unlinkSync(namesPath);
      } catch {
        // ignore cleanup failure
      }
    } else {
      writeNamesFile(JSON.parse(originalNames));
    }
    (DiscordUtil as any).sendMessage = origSend;
    (DiscordUtil as any).getGuildMember = origGet;
  }
});

test("Delayed ban /class bans still blocked until both bans used", async () => {
  const cmd = new ClassbanCommand();
  const game = setupDelayedGame(2);
  const cfg = ConfigManager.getConfig();
  const guild = new FakeGuild() as any;
  const { redM } = setupCaptains(guild);

  const origGet = DiscordUtil.getGuildMember;
  (DiscordUtil as any).getGuildMember = () => redM as any;
  try {
    const ir = createChatInputInteraction("RC", {
      guild,
      member: redM as any,
      subcommand: "ban",
      channelId: cfg.channels.redTeamChat,
      channel: { id: cfg.channels.redTeamChat, send: async () => {} } as any,
      strings: { class: "scout" },
    }) as any;
    ir.client = { users: { fetch: async () => ({ send: async () => {} }) } };
    await cmd.execute(ir);

    const view = createChatInputInteraction("RC", {
      guild,
      member: redM as any,
      subcommand: "bans",
      channelId: cfg.channels.redTeamChat,
    });
    await cmd.execute(view);
    const reply = view.replies.find((r) => r.type === "reply");
    assert(
      reply?.payload?.embeds?.[0]?.description?.includes("not available"),
      "Still blocks /class bans before both captains ban"
    );
  } finally {
    (DiscordUtil as any).getGuildMember = origGet;
  }
});

test("Delayed ban count is unique across organiser/captains", async () => {
  const cmd = new ClassbanCommand();
  const game = setupDelayedGame(2);
  game.settings.organiserBannedClasses = ["SCOUT" as any];
  game.settings.sharedCaptainBannedClasses = ["SCOUT" as any, "WARRIOR" as any];
  game.settings.nonSharedCaptainBannedClasses = {
    RED: ["WARRIOR" as any],
    BLUE: [],
  } as any;
  game.markCaptainHasBanned("RC");
  game.markCaptainHasBanned("BC");

  const view = createChatInputInteraction("RC", { subcommand: "bans" });
  await cmd.execute(view);
  const reply = view.replies.find((r) => r.type === "reply");
  const desc = reply?.payload?.embeds?.[0]?.description ?? "";
  assert(desc.includes("**2**"), "Counts unique bans across sources");
});

test("Delayed ban counts both teams even if classBanMode is opponentOnly", async () => {
  const cmd = new ClassbanCommand();
  const game = setupDelayedGame(4);
  game.classBanMode = "opponentOnly";
  game.settings.nonSharedCaptainBannedClasses = {
    RED: ["SCOUT" as any],
    BLUE: ["WARRIOR" as any],
  } as any;
  game.markCaptainHasBanned("RC");
  game.markCaptainHasBanned("BC");

  const view = createChatInputInteraction("RC", { subcommand: "bans" });
  await cmd.execute(view);
  const reply = view.replies.find((r) => r.type === "reply");
  const desc = reply?.payload?.embeds?.[0]?.description ?? "";
  assert(
    desc.includes("**2**"),
    "Counts bans across both teams in delayed mode"
  );
});

test("Non-delayed ban still shows full list", async () => {
  const cmd = new ClassbanCommand();
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.announced = true;
  game.classBanMode = "shared";
  game.setClassBanLimit(2);
  game.settings.sharedCaptainBannedClasses = ["SCOUT" as any, "WARRIOR" as any];
  game.markCaptainHasBanned("RC");
  game.markCaptainHasBanned("BC");

  const view = createChatInputInteraction("RC", { subcommand: "bans" });
  await cmd.execute(view);
  const reply = view.replies.find((r) => r.type === "reply");
  const fields = reply?.payload?.embeds?.[0]?.fields ?? [];
  assert(fields.length > 0, "Non-delayed bans still show full list");
});
