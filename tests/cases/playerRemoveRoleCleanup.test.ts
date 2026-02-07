import { test } from "../framework/test";
import { assert } from "../framework/assert";
import PlayerCommand from "../../src/commands/PlayerCommand";
import {
  createChatInputInteraction,
  FakeGuild,
  FakeGuildMember,
} from "../framework/mocks";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import { ConfigManager } from "../../src/ConfigManager";
import { PrismaUtils } from "../../src/util/PrismaUtils";

function setRole(member: FakeGuildMember, roleId: string) {
  return member.roles.add(roleId);
}

test("/player remove clears captain and team roles", async () => {
  const config = ConfigManager.getConfig();
  const cmd = new PlayerCommand();
  const guild = new FakeGuild() as any;
  const organiser = new FakeGuildMember("ORG");
  await setRole(organiser, config.roles.organiserRole);
  guild.addMember(organiser as any);

  const member = new FakeGuildMember("U2");
  await setRole(member, config.roles.captainRole);
  await setRole(member, config.roles.redTeamRole);
  guild.addMember(member as any);

  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.announced = true;
  game.teams.RED.push({
    discordSnowflake: "U2",
    captain: true,
    ignUsed: "PlayerTwo",
    latestIGN: "PlayerTwo",
    elo: 1200,
  } as any);

  const origFind = (PrismaUtils as any).findPlayer;
  (PrismaUtils as any).findPlayer = async (_id: string) => ({
    discordSnowflake: "U2",
    latestIGN: "PlayerTwo",
  });

  try {
    const i = createChatInputInteraction("ORG", {
      guild,
      strings: { player: "PlayerTwo" },
      subcommand: "remove",
    }) as any;
    i.inGuild = () => true;
    i.guild = guild;
    i.member = organiser as any;

    await cmd.execute(i);

    assert(
      !member.roles.cache.has(config.roles.captainRole),
      "Captain role removed"
    );
    assert(
      !member.roles.cache.has(config.roles.redTeamRole),
      "Team role removed"
    );
  } finally {
    (PrismaUtils as any).findPlayer = origFind;
  }
});
