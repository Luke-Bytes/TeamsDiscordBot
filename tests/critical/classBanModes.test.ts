import { test } from "../framework/test";
import { assert } from "../framework/assert";
import ClassbanCommand from "../../src/commands/ClassbanCommand";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import { ConfigManager } from "../../src/ConfigManager";
import { DiscordUtil } from "../../src/util/DiscordUtil";
import { ModifierSelector } from "../../src/logic/ModifierSelector";
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

test("ModifierSelector removes Transporter from bans when TP Enabled - Skying Banned is active", async () => {
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.settings.organiserBannedClasses = ["TRANSPORTER" as any, "SCOUT" as any];
  game.settings.sharedCaptainBannedClasses = ["TRANSPORTER" as any];
  game.settings.nonSharedCaptainBannedClasses = {
    RED: ["TRANSPORTER" as any],
    BLUE: ["MINER" as any, "TRANSPORTER" as any],
  };

  const origSelect = ModifierSelector.prototype.select;
  ModifierSelector.prototype.select = function () {
    return [{ category: "TP Enabled - Skying Banned", name: "Enabled" }];
  };

  try {
    ModifierSelector.runSelection();
    assert(
      !game.settings.organiserBannedClasses.includes("TRANSPORTER" as any),
      "Transporter should be removed from organiser bans"
    );
    assert(
      !game.settings.sharedCaptainBannedClasses.includes("TRANSPORTER" as any),
      "Transporter should be removed from shared captain bans"
    );
    assert(
      !game.settings.nonSharedCaptainBannedClasses!.RED.includes(
        "TRANSPORTER" as any
      ) &&
        !game.settings.nonSharedCaptainBannedClasses!.BLUE.includes(
          "TRANSPORTER" as any
        ),
      "Transporter should be removed from per-team bans"
    );
  } finally {
    ModifierSelector.prototype.select = origSelect;
  }
});

test("Transporter cannot be banned while TP Enabled - Skying Banned is active", async () => {
  const cmd = new ClassbanCommand();
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.announced = true;
  game.classBanMode = "shared";
  game.setClassBanLimit(2);
  game.settings.modifiers = [
    { category: "TP Enabled - Skying Banned", name: "Enabled" },
  ];

  const { guild, redM } = await setupCaptains();
  (game as any).teams = {
    RED: [{ discordSnowflake: "RC", captain: true }],
    BLUE: [{ discordSnowflake: "BC", captain: true }],
    UNDECIDED: [],
  };

  const origGet = (DiscordUtil as any).getGuildMember;
  (DiscordUtil as any).getGuildMember = () => redM as any;

  try {
    const interaction = createChatInputInteraction("RC", {
      guild,
      member: redM as any,
      subcommand: "ban",
      strings: { class: "transporter" },
      channelId: ConfigManager.getConfig().channels.redTeamChat,
      channel: {
        id: ConfigManager.getConfig().channels.redTeamChat,
        send: async () => {},
      } as any,
    });
    await cmd.execute(interaction);
    const refusal = interaction.replies.find(
      (r: any) => r.type === "editReply"
    );
    const embed = refusal?.payload?.embeds?.[0]?.data;
    assert(!!embed, "Should reply with refusal embed");
    assert(
      /Cannot Ban Modifier-Protected Class/i.test(String(embed.title ?? "")),
      "Should explain that the class is protected by a modifier"
    );
  } finally {
    (DiscordUtil as any).getGuildMember = origGet;
  }
});

test("ModifierSelector removes Swapper from bans when Swapper modifier is active", async () => {
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.settings.organiserBannedClasses = ["SWAPPER" as any, "SCOUT" as any];
  game.settings.sharedCaptainBannedClasses = ["SWAPPER" as any];
  game.settings.nonSharedCaptainBannedClasses = {
    RED: ["SWAPPER" as any],
    BLUE: ["MINER" as any, "SWAPPER" as any],
  };

  const origSelect = ModifierSelector.prototype.select;
  ModifierSelector.prototype.select = function () {
    return [{ category: "Swapper", name: "Enabled" }];
  };

  try {
    ModifierSelector.runSelection();
    assert(
      !game.settings.organiserBannedClasses.includes("SWAPPER" as any),
      "Swapper should be removed from organiser bans"
    );
    assert(
      !game.settings.sharedCaptainBannedClasses.includes("SWAPPER" as any),
      "Swapper should be removed from shared captain bans"
    );
    assert(
      !game.settings.nonSharedCaptainBannedClasses!.RED.includes(
        "SWAPPER" as any
      ) &&
        !game.settings.nonSharedCaptainBannedClasses!.BLUE.includes(
          "SWAPPER" as any
        ),
      "Swapper should be removed from per-team bans"
    );
  } finally {
    ModifierSelector.prototype.select = origSelect;
  }
});

test("Swapper cannot be banned while Swapper modifier is active", async () => {
  const cmd = new ClassbanCommand();
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.announced = true;
  game.classBanMode = "shared";
  game.setClassBanLimit(2);
  game.settings.modifiers = [{ category: "Swapper", name: "Enabled" }];

  const { guild, redM } = await setupCaptains();
  (game as any).teams = {
    RED: [{ discordSnowflake: "RC", captain: true }],
    BLUE: [{ discordSnowflake: "BC", captain: true }],
    UNDECIDED: [],
  };

  const origGet = (DiscordUtil as any).getGuildMember;
  (DiscordUtil as any).getGuildMember = () => redM as any;

  try {
    const interaction = createChatInputInteraction("RC", {
      guild,
      member: redM as any,
      subcommand: "ban",
      strings: { class: "swapper" },
      channelId: ConfigManager.getConfig().channels.redTeamChat,
      channel: {
        id: ConfigManager.getConfig().channels.redTeamChat,
        send: async () => {},
      } as any,
    });
    await cmd.execute(interaction);
    const refusal = interaction.replies.find(
      (r: any) => r.type === "editReply"
    );
    const embed = refusal?.payload?.embeds?.[0]?.data;
    assert(!!embed, "Should reply with refusal embed");
    assert(
      /Cannot Ban Modifier-Protected Class/i.test(String(embed.title ?? "")),
      "Should explain that Swapper is protected by a modifier"
    );
  } finally {
    (DiscordUtil as any).getGuildMember = origGet;
  }
});
