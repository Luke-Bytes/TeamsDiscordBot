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

test("No modifiers defaults to shared: all bans appear under Shared", async () => {
  const cmd = new ClassbanCommand();
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.announced = true;
  // Simulate announcement with modifiers=no default -> shared mode
  (game as any).classBanMode = "shared";
  game.setClassBanLimit(2);
  // organiser shared ban
  game.settings.organiserBannedClasses = ["TRANSPORTER" as any];

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
    // Red bans SCOUT
    const ir = createChatInputInteraction("RC", {
      guild,
      member: redM as any,
      subcommand: "ban",
      strings: { class: "scout" },
      channelId: cfg.channels.redTeamChat,
      channel: { id: cfg.channels.redTeamChat, send: async () => {} } as any,
    });
    await cmd.execute(ir);
    // Blue bans MINER (this should trigger locked-in summary)
    const ib = createChatInputInteraction("BC", {
      guild,
      member: blueM as any,
      subcommand: "ban",
      strings: { class: "miner" },
      channelId: cfg.channels.blueTeamChat,
      channel: { id: cfg.channels.blueTeamChat, send: async () => {} } as any,
    });
    await cmd.execute(ib);

    const summary = sent.find((s) => s.embeds);
    assert(!!summary, "Locked-in summary sent");
    const fields = summary.embeds[0]?.data?.fields ?? [];
    const sharedField = fields.find((f: any) => /Shared/i.test(f.name));
    const redField = fields.find((f: any) =>
      /Red Can't Use|Red Can’t Use/i.test(f.name)
    );
    const blueField = fields.find((f: any) =>
      /Blue Can't Use|Blue Can’t Use/i.test(f.name)
    );
    assert(!!sharedField, "Shared field exists");
    const val = String(sharedField.value || "");
    assert(
      val.includes("Transporter") &&
        val.includes("Scout") &&
        val.includes("Miner"),
      "Shared includes organiser + both captain bans"
    );
    assert(redField?.value === "None", "Red-only is None in shared mode");
    assert(blueField?.value === "None", "Blue-only is None in shared mode");
  } finally {
    (DiscordUtil as any).sendMessage = origSend;
    (DiscordUtil as any).getGuildMember = origGet;
  }
});
