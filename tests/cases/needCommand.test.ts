import NeedCommand from "../../src/commands/NeedCommand";
import TeamCommand from "../../src/commands/TeamCommand";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import { Channels } from "../../src/Channels";
import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";

async function scenario(run: (h: any) => Promise<void>) {
  const originalGame = CurrentGameManager.getCurrentGame;
  const originalInstance = NeedCommand.instance;
  const keys = [
    "registration",
    "gameFeed",
    "redTeamChat",
    "blueTeamChat",
  ] as const;
  const originalChannels = keys.map((k) => Channels[k]);
  const posts: any[] = [];
  const plans: any[] = [];
  const members = ["captain", "one", "two"].map((id) => ({
    discordSnowflake: id,
    ignUsed: id,
  }));
  const game: any = {
    announced: true,
    teamsDecidedBy: "DRAFT",
    token: "game-1",
    teams: { RED: [members[0]], BLUE: [], UNDECIDED: members.slice(1) },
    getLifecycleToken: () => game.token,
    getGameStartStatus: () => "started",
    getPlayers: () => Object.values(game.teams).flat(),
    getPlayersTeam: (p: any) =>
      Object.keys(game.teams).find((t) => game.teams[t].includes(p)),
    getCaptainOfTeam: (t: string) => (t === "RED" ? members[0] : undefined),
    movePlayerBetweenTeams: async (id: string, from: string, to: string) => {
      const p = game.teams[from].find((p: any) => p.discordSnowflake === id);
      if (!p) return false;
      await Promise.resolve();
      game.teams[from] = game.teams[from].filter((x: any) => x !== p);
      game.teams[to].push(p);
      return true;
    },
  };
  CurrentGameManager.getCurrentGame = () => game;
  for (const key of keys)
    Channels[key] = {
      send: async (payload: any) => {
        const message: any = {
          id: String(posts.length),
          url: `https://discord.test/${posts.length}`,
          edits: [],
          edit: async (p: any) => {
            message.edits.push(p);
          },
        };
        posts.push({ key, payload, message });
        return message;
      },
    } as any;
  const teams = new TeamCommand();
  const command = new NeedCommand(teams, {
    handleRosterUpdate: async (p: any) => {
      plans.push(p);
    },
  } as any);
  function interaction(id = "captain", options: any = {}) {
    const replies: string[] = [];
    return {
      user: { id, username: id },
      member: { id, roles: { cache: { has: () => id === "organiser" } } },
      guildId: "guild",
      guild: {},
      client: {},
      inGuild: () => true,
      options: {
        getString: () => options.team ?? null,
        getBoolean: () => options.ping ?? false,
      },
      replies,
      deferReply: async () => {},
      editReply: async (p: string) => {
        replies.push(p);
      },
    } as any;
  }
  async function click(id: string, post = posts[0], action = "join") {
    const i = interaction(id);
    i.message = post.message;
    i.customId =
      post.payload.components[0].components[
        action === "join" ? 0 : 1
      ].data.custom_id;
    await command.handleButtonPress(i);
    return i;
  }
  try {
    await run({ command, game, posts, plans, interaction, click });
  } finally {
    CurrentGameManager.getCurrentGame = originalGame;
    NeedCommand.instance = originalInstance;
    keys.forEach((k, n) => {
      Channels[k] = originalChannels[n];
    });
  }
}

test("/need shares one vacancy across both posts and accepts exactly one registered claimant", () =>
  scenario(async (h) => {
    await h.command.execute(h.interaction());
    assertEqual(h.posts.length, 2, "posts to both public channels");
    await h.command.execute(h.interaction());
    assertEqual(h.posts.length, 2, "duplicate request does not repost");
    const outsider = await h.click("outsider");
    assert(
      outsider.replies[0].includes("/register"),
      "unregistered click explains registration"
    );
    await Promise.all([h.click("one"), h.click("two", h.posts[1])]);
    assertEqual(h.game.teams.RED.length, 2, "only one claimant added");
    assertEqual(
      h.game.teams.UNDECIDED.length,
      1,
      "other claimant remains unassigned"
    );
    assert(
      h.posts
        .slice(0, 2)
        .every((p: any) => p.message.edits[0].components.length === 0),
      "both buttons removed"
    );
    assertEqual(h.posts[2].key, "redTeamChat", "notifies correct team");
    assert(
      h.posts[2].payload.content.includes("<@captain>"),
      "mentions captain"
    );
    assertEqual(h.plans.length, 1, "updates captain plan once");
  }));

test("/need cancellation and lifecycle expiry reject stale claims without changing the roster", () =>
  scenario(async (h) => {
    await h.command.execute(h.interaction());
    await h.click("one", h.posts[0], "cancel");
    assertEqual(
      h.posts[0].message.edits.length,
      0,
      "ordinary player cannot cancel"
    );
    await h.click("captain", h.posts[1], "cancel");
    await h.click("one");
    assertEqual(h.game.teams.RED.length, 1, "cancelled request cannot recruit");
    await h.command.execute(h.interaction());
    h.game.token = "next-game";
    const stale = await h.click("one", h.posts[2]);
    assert(stale.replies[0].includes("expired"), "old lifecycle rejected");
    assertEqual(h.game.teams.RED.length, 1, "stale request cannot recruit");
  }));
