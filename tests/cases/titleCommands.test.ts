import { MessageFlags } from "discord.js";
import { test } from "../framework/test";
import { assert } from "../framework/assert";
import TitlesCommand from "../../src/commands/TitlesCommand";
import TitleCommand from "../../src/commands/TitleCommand";
import ProfileEditCommand from "../../src/commands/ProfileEditCommand";
import { TitleStore } from "../../src/util/TitleStore";
import { prismaClient } from "../../src/database/prismaClient";
import { PrismaUtils } from "../../src/util/PrismaUtils";
import { ConfigManager } from "../../src/ConfigManager";
import {
  createChatInputInteraction,
  FakeGuild,
  FakeGuildMember,
} from "../framework/mocks";
function writeTitles(
  titles: Array<{ id: string; label: string; reason?: string }>
) {
  TitleStore.setOverride(titles);
}

test("/titles lists titles and defaults reason to ???", async () => {
  writeTitles([
    { id: "CHAMPION", label: "Champion", reason: "Come first in a season." },
    { id: "THE_SUC", label: "The Suc" },
  ]);

  const cmd = new TitlesCommand();
  const i = createChatInputInteraction("U1") as any;
  await cmd.execute(i);
  const reply = i.replies.find((r: any) => r.type === "reply");
  const embed = reply?.payload?.embeds?.[0];
  const fields = embed?.fields ?? embed?.data?.fields ?? [];
  assert(fields.length === 2, "Lists two titles");
  const noReason = fields.find((f: any) => f.name === "The Suc");
  assert(noReason?.value === "???", "Defaults reason to ???");
});

test("/title rejects non-organiser", async () => {
  const cmd = new TitleCommand();
  const i = createChatInputInteraction("U2", {
    strings: { player: "U2" },
  }) as any;
  i.inGuild = () => true;
  i.member = {} as any;
  await cmd.execute(i);
  const reply = i.replies.find((r: any) => r.type === "reply");
  assert(
    reply?.payload?.flags === MessageFlags.Ephemeral,
    "Non-organiser blocked"
  );
});

test("/title add/remove updates unlocked titles", async () => {
  writeTitles([
    { id: "CHAMPION", label: "Champion", reason: "Come first in a season." },
    { id: "ACE", label: "Ace", reason: "Come second or higher in a season." },
  ]);

  const origFind = (PrismaUtils as any).findPlayer;
  const origProfile = (prismaClient as any).profile;

  try {
    (PrismaUtils as any).findPlayer = async (_id: string) => ({
      id: "P1",
      discordSnowflake: "U1",
      latestIGN: "PlayerOne",
    });
    let unlocked: string[] = [];
    (prismaClient as any).profile = {
      findUnique: async () => ({ unlockedTitles: unlocked }),
      upsert: async (args: any) => {
        unlocked = args.update.unlockedTitles ?? args.create.unlockedTitles;
        return {};
      },
    };

    const cfg = ConfigManager.getConfig();
    const guild = new FakeGuild() as any;
    const member = new FakeGuildMember("ORG");
    await member.roles.add(cfg.roles.organiserRole);
    guild.addMember(member);

    const cmd = new TitleCommand();
    const i = createChatInputInteraction("ORG", {
      guild,
      member: member as any,
      strings: { player: "U1" },
    }) as any;
    i.inGuild = () => true;
    await cmd.execute(i);

    const buttonAdd: any = {
      customId: "title-add",
      user: { id: "ORG" },
      update: async (payload: any) => {
        buttonAdd.payload = payload;
        return {};
      },
    };
    await cmd.handleButtonPress!(buttonAdd);
    const selectAdd: any = {
      customId: "title-select:add",
      user: { id: "ORG" },
      values: ["CHAMPION"],
      update: async (_payload: any) => ({}),
      reply: async (_payload: any) => ({}),
    };
    await cmd.handleSelectMenu!(selectAdd);
    assert(unlocked.includes("CHAMPION"), "Title added");

    const buttonRemove: any = {
      customId: "title-remove",
      user: { id: "ORG" },
      update: async (payload: any) => {
        buttonRemove.payload = payload;
        return {};
      },
      reply: async (_payload: any) => ({}),
    };
    await cmd.handleButtonPress!(buttonRemove);
    const selectRemove: any = {
      customId: "title-select:remove",
      user: { id: "ORG" },
      values: ["CHAMPION"],
      update: async (_payload: any) => ({}),
      reply: async (_payload: any) => ({}),
    };
    await cmd.handleSelectMenu!(selectRemove);
    assert(!unlocked.includes("CHAMPION"), "Title removed");
  } finally {
    (PrismaUtils as any).findPlayer = origFind;
    (prismaClient as any).profile = origProfile;
    TitleStore.clearOverride();
  }
});

test("/profilecreate shows unlocked titles in selector", async () => {
  writeTitles([{ id: "CHAMPION", label: "Champion" }]);

  const origFind = (PrismaUtils as any).findPlayer;
  const origProfile = (prismaClient as any).profile;
  const cfg = ConfigManager.getConfig();
  try {
    (PrismaUtils as any).findPlayer = async (_id: string) => ({
      id: "P2",
      discordSnowflake: "U2",
      latestIGN: "PlayerTwo",
    });
    (prismaClient as any).profile = {
      findUnique: async () => ({
        unlockedTitles: ["CHAMPION"],
        title: "CHAMPION",
      }),
      upsert: async () => ({}),
    };

    const guild = new FakeGuild() as any;
    const member = new FakeGuildMember("U2");
    guild.addMember(member);
    const edit = new ProfileEditCommand();
    const i = createChatInputInteraction("U2", {
      guild,
      member: member as any,
      channelId: cfg.channels.botCommands,
    }) as any;
    i.inGuild = () => true;
    i.guild = guild;
    i.user.username = "UserTwo";
    await edit.execute(i);

    const buttonInteraction: any = {
      customId: "profile-edit:title",
      user: { id: "U2" },
      update: async (payload: any) => {
        buttonInteraction.payload = payload;
        return {};
      },
    };
    await edit.handleButtonPress!(buttonInteraction);
    const payload = buttonInteraction.payload;
    const rows = (payload?.components ?? []).map((row: any) =>
      typeof row?.toJSON === "function" ? row.toJSON() : row
    );
    const selectOptions: Array<{ value?: string }> = [];
    for (const row of rows) {
      const comps = (row?.components ?? []).map((comp: any) =>
        typeof comp?.toJSON === "function" ? comp.toJSON() : comp
      );
      for (const comp of comps) {
        if (comp?.custom_id === "profile-select:title") {
          if (Array.isArray(comp.options)) {
            selectOptions.push(...comp.options);
          } else if (Array.isArray(comp?.data?.options)) {
            selectOptions.push(...comp.data.options);
          }
        }
      }
    }
    assert(
      selectOptions.some((o: any) => o.value === "CHAMPION"),
      "Unlocked title appears in selector"
    );
    const disabled =
      rows
        .flatMap((row: any) => row?.components ?? [])
        .map((comp: any) =>
          typeof comp?.toJSON === "function" ? comp.toJSON() : comp
        )
        .find((comp: any) => comp?.custom_id === "profile-select:title")
        ?.disabled ?? false;
    assert(disabled !== true, "Selector enabled when titles exist");
  } finally {
    (PrismaUtils as any).findPlayer = origFind;
    (prismaClient as any).profile = origProfile;
    TitleStore.clearOverride();
  }
});

test("/titles uses mocked title list without touching disk", async () => {
  writeTitles([{ id: "ACE", label: "Ace" }]);
  try {
    const cmd = new TitlesCommand();
    const i = createChatInputInteraction("U9") as any;
    await cmd.execute(i);
    const reply = i.replies.find((r: any) => r.type === "reply");
    const embed = reply?.payload?.embeds?.[0];
    const fields = embed?.fields ?? embed?.data?.fields ?? [];
    assert(fields.length === 1, "Uses mocked titles");
    assert(fields[0].name === "Ace", "Mocked title rendered");
  } finally {
    TitleStore.clearOverride();
  }
});
