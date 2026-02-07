import { test } from "../framework/test";
import { assert } from "../framework/assert";
import UnregisterCommand from "../../src/commands/UnregisterCommand";
import TeamCommand from "../../src/commands/TeamCommand";
import {
  createChatInputInteraction,
  FakeGuild,
  FakeGuildMember,
} from "../framework/mocks";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import { ConfigManager } from "../../src/ConfigManager";

function setRole(member: FakeGuildMember, roleId: string) {
  return member.roles.add(roleId);
}

test("/unregister removes captain and team roles", async () => {
  const config = ConfigManager.getConfig();
  const teamCommand = new TeamCommand();
  const cmd = new UnregisterCommand(teamCommand);
  const guild = new FakeGuild() as any;
  const member = new FakeGuildMember("U1");
  await setRole(member, config.roles.captainRole);
  await setRole(member, config.roles.redTeamRole);
  guild.addMember(member as any);

  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.announced = true;
  game.teams.RED.push({
    discordSnowflake: "U1",
    captain: true,
    ignUsed: "Cap",
    elo: 1200,
  } as any);

  const i = createChatInputInteraction("U1", {
    guild,
    channelId: config.channels.registration,
  }) as any;
  i.inGuild = () => true;
  i.guild = guild;

  await cmd.execute(i);

  assert(
    !member.roles.cache.has(config.roles.captainRole),
    "Captain role removed"
  );
  assert(
    !member.roles.cache.has(config.roles.redTeamRole),
    "Team role removed"
  );
});
