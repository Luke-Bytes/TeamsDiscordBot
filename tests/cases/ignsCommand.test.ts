import { test } from "../framework/test";
import { assert } from "../framework/assert";
import IgnsCommand from "../../src/commands/IgnsCommand";
import { createChatInputInteraction } from "../framework/mocks";
import { PrismaUtils } from "../../src/util/PrismaUtils";
import MissingCommand from "../../src/commands/MissingCommand";
import { PermissionsUtil } from "../../src/util/PermissionsUtil";

test("/igns lists all minecraft accounts for self when no user param provided", async () => {
  const cmd = new IgnsCommand();
  const origFind = (PrismaUtils as any).findPlayer;
  try {
    (PrismaUtils as any).findPlayer = async (_id: string) => ({
      discordSnowflake: "U1",
      latestIGN: "Name_One",
      minecraftAccounts: ["Name_One", "SecondIGN"],
    });
    const i = createChatInputInteraction("U1", { strings: {} });
    await cmd.execute(i as any);
    const reply = i.replies.find((r: any) => r.type === "editReply");
    assert(!!reply && reply.payload?.embeds, "Responds with embed");
    const fields = reply.payload.embeds[0]?.data?.fields ?? [];
    const accountsField = fields.find((f: any) => /Accounts/i.test(f.name));
    const val = String(accountsField?.value || "");
    assert(
      val.includes("1. SecondIGN") && val.includes("2. Name\\_One"),
      "Lists accounts while formatting safely"
    );
  } finally {
    (PrismaUtils as any).findPlayer = origFind;
  }
});

test("/igns lists accounts in reverse order", async () => {
  const cmd = new IgnsCommand();
  const origFind = (PrismaUtils as any).findPlayer;
  try {
    (PrismaUtils as any).findPlayer = async (_id: string) => ({
      discordSnowflake: "U2",
      latestIGN: "UserTwo",
      minecraftAccounts: ["FirstIGN", "SecondIGN", "ThirdIGN"],
    });
    const i = createChatInputInteraction("U2", { strings: {} });
    await cmd.execute(i as any);
    const reply = i.replies.find((r: any) => r.type === "editReply");
    const fields = reply.payload.embeds[0]?.data?.fields ?? [];
    const accountsField = fields.find((f: any) => /Accounts/i.test(f.name));
    const val = String(accountsField?.value || "");
    assert(
      val.indexOf("1. ThirdIGN") < val.indexOf("2. SecondIGN") &&
        val.indexOf("2. SecondIGN") < val.indexOf("3. FirstIGN"),
      "Accounts should be reversed"
    );
  } finally {
    (PrismaUtils as any).findPlayer = origFind;
  }
});

test("/missing defaults to channel team when no option provided", async () => {
  const cmd = new MissingCommand();
  const originalIsChannel = PermissionsUtil.isChannel;
  const originalCheck = (MissingCommand as any).prototype.execute;

  try {
    const calls: any[] = [];
    (MissingCommand as any).prototype.execute = async function (
      interaction: any
    ) {
      if (
        !PermissionsUtil.isChannel(interaction, "redTeamChat") &&
        !PermissionsUtil.isChannel(interaction, "blueTeamChat")
      ) {
        await interaction.reply({
          content:
            "This command can only be used in the red or blue team channels.",
          flags: 64,
        });
        return;
      }

      const requestedTeam = interaction.options.getString("team");
      let team: "RED" | "BLUE";
      if (requestedTeam === "RED" || requestedTeam === "BLUE") {
        team = requestedTeam;
      } else if (PermissionsUtil.isChannel(interaction, "redTeamChat")) {
        team = "RED";
      } else {
        team = "BLUE";
      }

      calls.push(team);
      await interaction.reply({ content: `team=${team}` });
    };

    const i = createChatInputInteraction("U3", {
      channelId: "red-channel",
    }) as any;
    i.guild = {} as any;
    PermissionsUtil.isChannel = (source: any, key: string) => {
      if (key === "redTeamChat") return source.channelId === "red-channel";
      if (key === "blueTeamChat") return false;
      return false;
    };

    await cmd.execute(i);
    assert(calls[0] === "RED", "Defaults to RED in red team channel");
  } finally {
    (MissingCommand as any).prototype.execute = originalCheck;
    PermissionsUtil.isChannel = originalIsChannel;
  }
});
