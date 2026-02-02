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

test("Class bans disabled returns disabled message", async () => {
  const cmd = new ClassbanCommand();
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.announced = true;
  game.setClassBanLimit(0);
  const i = createChatInputInteraction("C1", { subcommand: "bans" });
  await cmd.execute(i);
  const reply = i.replies.find((r) => r.type === "reply");
  assert(
    !!reply && reply.payload?.embeds,
    "Responds with disabled message embed"
  );
});

test("Captain class ban forbids core classes in opponentOnly mode", async () => {
  const cmd = new ClassbanCommand();
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.announced = true;
  game.setClassBanLimit(2);
  (game as any).classBanMode = "opponentOnly";
  const guild = new FakeGuild() as any;
  const cfg = ConfigManager.getConfig();

  const capt = new FakeGuildMember("CAP");
  await capt.roles.add(cfg.roles.captainRole);
  await capt.roles.add(cfg.roles.blueTeamRole);
  guild.addMember(capt);
  const blueCaptain = {
    discordSnowflake: "CAP",
    ignUsed: "BlueC",
    captain: true,
  } as any;
  (game as any).teams = { RED: [], BLUE: [blueCaptain], UNDECIDED: [] };

  // Try ban transporter (forbidden core)
  const origGet = (DiscordUtil as any).getGuildMember;
  (DiscordUtil as any).getGuildMember = () => capt as any;
  const i = createChatInputInteraction("CAP", {
    guild,
    member: capt as any,
    subcommand: "ban",
    channelId: cfg.channels.blueTeamChat,
    channel: {
      id: cfg.channels.blueTeamChat,
      send: async (_: any) => {},
    } as any,
    strings: { class: "transporter" },
  });
  await cmd.execute(i);
  const reply = i.replies.find((r) => r.type === "editReply");
  assert(
    !!reply && reply.payload?.embeds,
    "Responds with cannot ban core class"
  );

  // Ban scout (allowed) should be applied against opponent team
  const i2 = createChatInputInteraction("CAP", {
    guild,
    member: capt as any,
    subcommand: "ban",
    channelId: cfg.channels.blueTeamChat,
    channel: {
      id: cfg.channels.blueTeamChat,
      send: async (_: any) => {},
    } as any,
    strings: { class: "scout" },
  });
  await cmd.execute(i2);
  const redBans = game.settings.nonSharedCaptainBannedClasses.RED;
  assert(
    redBans.includes("SCOUT" as any),
    "Opponent-only ban applies to opponent team"
  );
  (DiscordUtil as any).getGuildMember = origGet;
});

test("Captain cannot ban a class already banned by organiser", async () => {
  const cmd = new ClassbanCommand();
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.announced = true;
  game.setClassBanLimit(2);
  (game as any).classBanMode = "shared";
  game.settings.organiserBannedClasses = ["SCOUT" as any];

  const guild = new FakeGuild() as any;
  const cfg = ConfigManager.getConfig();

  const capt = new FakeGuildMember("CAP2");
  await capt.roles.add(cfg.roles.captainRole);
  await capt.roles.add(cfg.roles.redTeamRole);
  guild.addMember(capt);
  const redCaptain = {
    discordSnowflake: "CAP2",
    ignUsed: "RedC",
    captain: true,
  } as any;
  (game as any).teams = { RED: [redCaptain], BLUE: [], UNDECIDED: [] };

  const origGet = (DiscordUtil as any).getGuildMember;
  (DiscordUtil as any).getGuildMember = () => capt as any;
  try {
    const i = createChatInputInteraction("CAP2", {
      guild,
      member: capt as any,
      subcommand: "ban",
      channelId: cfg.channels.redTeamChat,
      channel: {
        id: cfg.channels.redTeamChat,
        send: async (_: any) => {},
      } as any,
      strings: { class: "scout" },
    });
    await cmd.execute(i);

    const reply = i.replies.find((r) => r.type === "editReply");
    assert(!!reply && reply.payload?.embeds, "Rejects already-banned class");
    assert(
      game.getTotalCaptainBans() === 0,
      "Should not consume a captain ban when organiser already banned it"
    );
    assert(
      (game.settings.sharedCaptainBannedClasses ?? []).length === 0,
      "Should not add the duplicate ban to shared captain bans"
    );
  } finally {
    (DiscordUtil as any).getGuildMember = origGet;
  }
});

test("Consolidated summary posted when both captains ban", async () => {
  const cmd = new ClassbanCommand();
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.announced = true;
  game.setClassBanLimit(2);
  (game as any).classBanMode = "shared";
  const cfg = ConfigManager.getConfig();
  const guild = new FakeGuild() as any;

  const redM = new FakeGuildMember("RC");
  await redM.roles.add(cfg.roles.captainRole);
  await redM.roles.add(cfg.roles.redTeamRole);
  guild.addMember(redM);
  const blueM = new FakeGuildMember("BC");
  await blueM.roles.add(cfg.roles.captainRole);
  await blueM.roles.add(cfg.roles.blueTeamRole);
  guild.addMember(blueM);

  const redC = {
    discordSnowflake: "RC",
    ignUsed: "RedC",
    captain: true,
  } as any;
  const blueC = {
    discordSnowflake: "BC",
    ignUsed: "BlueC",
    captain: true,
  } as any;
  (game as any).teams = { RED: [redC], BLUE: [blueC], UNDECIDED: [] };

  const sent: any[] = [];
  const origSend = DiscordUtil.sendMessage;
  (DiscordUtil as any).sendMessage = async (ch: string, content: any) =>
    sent.push({ ch, content });

  const origGet = (DiscordUtil as any).getGuildMember;
  (DiscordUtil as any).getGuildMember = (i: any) =>
    (i.user.id === "RC" ? redM : blueM) as any;
  try {
    const ir = createChatInputInteraction("RC", {
      guild,
      member: redM as any,
      subcommand: "ban",
      channelId: cfg.channels.redTeamChat,
      channel: {
        id: cfg.channels.redTeamChat,
        send: async (_: any) => {},
      } as any,
      strings: { class: "scout" },
    });
    await cmd.execute(ir);
    const ib = createChatInputInteraction("BC", {
      guild,
      member: blueM as any,
      subcommand: "ban",
      channelId: cfg.channels.blueTeamChat,
      channel: {
        id: cfg.channels.blueTeamChat,
        send: async (_: any) => {},
      } as any,
      strings: { class: "warrior" },
    });
    await cmd.execute(ib);
    const summary = sent.find((s) => s.ch === "gameFeed" && s.content?.embeds);
    assert(!!summary, "Posts consolidated summary when both bans used");
  } finally {
    (DiscordUtil as any).sendMessage = origSend;
    (DiscordUtil as any).getGuildMember = origGet;
  }
});
