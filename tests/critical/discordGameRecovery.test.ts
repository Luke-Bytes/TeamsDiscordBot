import { AnniClass, AnniMap } from "@prisma/client";
import { test } from "../framework/test";
import { assert, assertEqual as expectEqual } from "../framework/assert";
const assertEqual = <T>(actual: T, expected: T) =>
  expectEqual(actual, expected, "discord recovery");
import {
  parseAnnouncement,
  parseBans,
  parseDiscordMessageLink,
  parseModifiers,
  parseRegistration,
  parseTeams,
} from "../../src/logic/DiscordGameRecovery";

const embed = (data: object) => ({ embeds: [data] }) as any;

test("discord recovery parses announced time, map, bans, modifier and double elo", () => {
  const result = parseAnnouncement(
    embed({
      title: "🎉 FRIENDLY WAR ANNOUNCEMENT",
      description: "🌟 A special DOUBLE ELO game! 🌟 Get ready to fight!",
      fields: [
        {
          name: "🕒 **TIME**",
          value: "**<t:1795212000:F>** (<t:1795212000:R>)",
        },
        { name: "🗺️ **MAP**", value: "**Arid1v1**" },
        { name: "🚫 **BANNED CLASSES**", value: "Swapper" },
        {
          name: "⚙️ **MODIFIERS**",
          value: "**Nexus Damage: No Nexus Damage before phase 4 (Four)**",
        },
      ],
      footer: { text: "Organised by Luke - Hosted by Meramii" },
    })
  );
  assertEqual(result.map, AnniMap.ARID1V1);
  assertEqual(result.bans?.[0], AnniClass.SWAPPER);
  assertEqual(result.modifiers?.[0].category, "Nexus Damage");
  assertEqual(
    result.modifiers?.[0].name,
    "No Nexus Damage before phase 4 (Four)"
  );
  assert(result.doubleElo, "double ELO detected");
  assertEqual(
    result.startTime.toISOString(),
    new Date(1795212000 * 1000).toISOString()
  );
  assertEqual(result.organiser, "Luke");
  assertEqual(result.host, "Meramii");
});

test("discord recovery parses registration feed and late signups", () => {
  const result = parseRegistration(
    embed({
      title: "Registered Players (3)",
      description: "```\nyenzz\nUngenes\nChimchar_\n```",
      fields: [{ name: "Late Signups (1)", value: "```\nSun_Nika_\n```" }],
    })
  );
  assertEqual(result.names.join(","), "yenzz,Ungenes,Chimchar_,Sun_Nika_");
  assertEqual(result.late.length, 1);
});

test("discord recovery rejects incomplete registration feeds", () => {
  let rejected = false;
  try {
    parseRegistration(
      embed({
        title: "Registered Players (20)",
        description: "```\nBob\n```",
        fields: [],
      })
    );
  } catch {
    rejected = true;
  }
  assert(rejected, "truncated registration feeds must fail");
});

test("discord recovery parses current-team fields with verified counts", () => {
  const result = parseTeams(
    embed({
      title: "Current Teams",
      fields: [
        { name: "🔴 Red Team [2]", value: "xNolva\nChimchar\\_" },
        { name: "🔵 Blue Team [2]", value: "Sun\\_Nika\\_\nDeshigh" },
      ],
    })
  );
  assertEqual(result.names.RED.join(","), "xNolva,Chimchar_");
  assertEqual(result.names.BLUE.join(","), "Sun_Nika_,Deshigh");
  assertEqual(result.captains.RED, "xNolva");
  assertEqual(result.method, null);
});

test("discord recovery parses snake-draft markers and captains", () => {
  const result = parseTeams(
    embed({
      title: "Snake Drafting Teams",
      fields: [
        { name: "🔵 Blue Team 🔵", value: "**\t⚫ Sun_Nika_**\n\t⚪ Deshigh" },
        { name: "🔴 Red Team 🔴", value: "**\t⚪ xNolva**\n\t⚪ Ungenes" },
      ],
    })
  );
  assertEqual(result.names.RED.join(","), "xNolva,Ungenes");
  assertEqual(result.names.BLUE.join(","), "Sun_Nika_,Deshigh");
  assertEqual(result.method, "SNAKE_DRAFT");
});

test("discord recovery requires a message link belonging to the same guild", () => {
  const valid = parseDiscordMessageLink(
    "https://discord.com/channels/123456789012345678/223456789012345678/323456789012345678",
    "123456789012345678"
  );
  assertEqual(valid.messageId, "323456789012345678");
  let rejected = false;
  try {
    parseDiscordMessageLink(
      "https://discord.com/channels/999456789012345678/223456789012345678/323456789012345678",
      "123456789012345678"
    );
  } catch {
    rejected = true;
  }
  assert(rejected, "cross-guild message link rejected");
});

test("discord recovery rejects unknown banned classes and malformed modifiers", () => {
  assertEqual(parseBans("none").length, 0);
  assertEqual(parseModifiers("none").length, 0);
  let rejectedBans = false;
  let rejectedModifiers = false;
  try {
    parseBans("NotAClass");
  } catch {
    rejectedBans = true;
  }
  try {
    parseModifiers("NoDamageBeforeFour");
  } catch {
    rejectedModifiers = true;
  }
  assert(
    rejectedBans && rejectedModifiers,
    "unsupported settings must fail closed"
  );
});
