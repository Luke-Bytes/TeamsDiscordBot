import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { AutoCaptainSelector } from "../../src/logic/AutoCaptainSelector";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import { ConfigManager } from "../../src/ConfigManager";
import { PermissionsUtil } from "../../src/util/PermissionsUtil";
import { FakeGuild, FakeGuildMember } from "../framework/mocks";

function setRole(member: FakeGuildMember, roleId: string) {
  return member.roles.add(roleId);
}

test("Auto-captain selection removes old captain roles when replaced", async () => {
  const config = ConfigManager.getConfig();
  const guild = new FakeGuild() as any;

  const oldCaptain = new FakeGuildMember("U1");
  await setRole(oldCaptain, config.roles.captainRole);
  await setRole(oldCaptain, config.roles.blueTeamRole);
  guild.addMember(oldCaptain as any);

  const p2 = new FakeGuildMember("U2");
  const p3 = new FakeGuildMember("U3");
  guild.addMember(p2 as any);
  guild.addMember(p3 as any);

  (PermissionsUtil as any).config.roles = {
    ...(PermissionsUtil as any).config.roles,
    captainRole: config.roles.captainRole,
    blueTeamRole: config.roles.blueTeamRole,
    redTeamRole: config.roles.redTeamRole,
  };

  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.announced = true;
  game.teams.BLUE.push({
    discordSnowflake: "U1",
    captain: true,
    ignUsed: "OldCap",
    elo: 900, // ineligible for auto selection
  } as any);
  game.teams.UNDECIDED.push(
    {
      discordSnowflake: "U2",
      captain: false,
      ignUsed: "P2",
      elo: 1200,
    } as any,
    {
      discordSnowflake: "U3",
      captain: false,
      ignUsed: "P3",
      elo: 1300,
    } as any
  );

  const result = await AutoCaptainSelector.randomiseCaptains(guild, false);
  assert(!("error" in result), "Auto-captain selection should succeed");

  assert(
    !oldCaptain.roles.cache.has(config.roles.captainRole),
    "Old captain role removed"
  );
  assert(
    !oldCaptain.roles.cache.has(config.roles.blueTeamRole),
    "Old captain team role removed"
  );
});
