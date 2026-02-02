import { test } from "../framework/test";
import { assert } from "../framework/assert";
import ClassbanCommand from "../../src/commands/ClassbanCommand";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import { ConfigManager } from "../../src/ConfigManager";
import { DiscordUtil } from "../../src/util/DiscordUtil";
import {
  FakeGuild,
  FakeGuildMember,
  createChatInputInteraction,
} from "../framework/mocks";

async function setupCaptains() {
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
  return { guild, redM, blueM };
}

test("OpponentOnly: team-only sections list respective bans", async () => {
  const cmd = new ClassbanCommand();
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.announced = true;
  (game as any).classBanMode = "opponentOnly";
  game.setClassBanLimit(2);
  const { guild, redM, blueM } = await setupCaptains();
  (game as any).teams = {
    RED: [{ discordSnowflake: "RC", captain: true }],
    BLUE: [{ discordSnowflake: "BC", captain: true }],
    UNDECIDED: [],
  };
  const sent: any[] = [];
  const origSend = (DiscordUtil as any).sendMessage;
  (DiscordUtil as any).sendMessage = async (_ch: string, content: any) =>
    sent.push(content);
  const origGet = (DiscordUtil as any).getGuildMember;
  (DiscordUtil as any).getGuildMember = (i: any) =>
    (i.user.id === "RC" ? redM : blueM) as any;
  try {
    const ir = createChatInputInteraction("RC", {
      guild,
      member: redM as any,
      subcommand: "ban",
      strings: { class: "scout" },
      channelId: ConfigManager.getConfig().channels.redTeamChat,
      channel: {
        id: ConfigManager.getConfig().channels.redTeamChat,
        send: async () => {},
      } as any,
    });
    await cmd.execute(ir);
    const ib = createChatInputInteraction("BC", {
      guild,
      member: blueM as any,
      subcommand: "ban",
      // choose a non-forbidden class in opponentOnly mode
      strings: { class: "warrior" },
      channelId: ConfigManager.getConfig().channels.blueTeamChat,
      channel: {
        id: ConfigManager.getConfig().channels.blueTeamChat,
        send: async () => {},
      } as any,
    });
    await cmd.execute(ib);
    const summary = sent.find((s) => s.embeds);
    assert(!!summary, "OpponentOnly summary sent");
    const fields = summary.embeds[0]?.data?.fields ?? [];
    const sharedField = fields.find((f: any) => /Shared/i.test(f.name));
    const redField = fields.find((f: any) =>
      /Red Can't Use|Red Can’t Use/i.test(f.name)
    );
    const blueField = fields.find((f: any) =>
      /Blue Can't Use|Blue Can’t Use/i.test(f.name)
    );
    assert(
      sharedField?.value === "None",
      "No shared bans in opponentOnly without organiser shared"
    );
    assert(
      String(redField?.value || "").includes("Warrior"),
      "Red can't use WARRIOR"
    );
    assert(
      String(blueField?.value || "").includes("Scout"),
      "Blue can't use SCOUT"
    );
  } finally {
    (DiscordUtil as any).sendMessage = origSend;
    (DiscordUtil as any).getGuildMember = origGet;
  }
});

test("Shared mode with organiser shared + per-team bans shows all under Shared", async () => {
  const cmd = new ClassbanCommand();
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.announced = true;
  (game as any).classBanMode = "shared";
  game.setClassBanLimit(2);
  game.settings.organiserBannedClasses = ["TRANSPORTER" as any];
  const { guild, redM, blueM } = await setupCaptains();
  (game as any).teams = {
    RED: [{ discordSnowflake: "RC", captain: true }],
    BLUE: [{ discordSnowflake: "BC", captain: true }],
    UNDECIDED: [],
  };
  const sent: any[] = [];
  const origSend = (DiscordUtil as any).sendMessage;
  (DiscordUtil as any).sendMessage = async (_ch: string, content: any) =>
    sent.push(content);
  const origGet = (DiscordUtil as any).getGuildMember;
  (DiscordUtil as any).getGuildMember = (i: any) =>
    (i.user.id === "RC" ? redM : blueM) as any;
  try {
    const ir = createChatInputInteraction("RC", {
      guild,
      member: redM as any,
      subcommand: "ban",
      strings: { class: "scout" },
      channelId: ConfigManager.getConfig().channels.redTeamChat,
      channel: {
        id: ConfigManager.getConfig().channels.redTeamChat,
        send: async () => {},
      } as any,
    });
    await cmd.execute(ir);
    const ib = createChatInputInteraction("BC", {
      guild,
      member: blueM as any,
      subcommand: "ban",
      strings: { class: "miner" },
      channelId: ConfigManager.getConfig().channels.blueTeamChat,
      channel: {
        id: ConfigManager.getConfig().channels.blueTeamChat,
        send: async () => {},
      } as any,
    });
    await cmd.execute(ib);
    const summary = sent.find((s) => s.embeds);
    assert(!!summary, "Shared summary sent");
    const fields = summary.embeds[0]?.data?.fields ?? [];
    const sharedField = fields.find((f: any) => /Shared/i.test(f.name));
    const redField = fields.find((f: any) =>
      /Red Can't Use|Red Can’t Use/i.test(f.name)
    );
    const blueField = fields.find((f: any) =>
      /Blue Can't Use|Blue Can’t Use/i.test(f.name)
    );
    const val = String(sharedField?.value || "");
    assert(
      val.includes("Transporter") &&
        val.includes("Scout") &&
        val.includes("Miner"),
      "All shared visible"
    );
    assert(redField?.value === "None", "No red-only in shared");
    assert(blueField?.value === "None", "No blue-only in shared");
  } finally {
    (DiscordUtil as any).sendMessage = origSend;
    (DiscordUtil as any).getGuildMember = origGet;
  }
});
