import { strict as assert } from "node:assert";
import { APIEmbed, EmbedBuilder } from "discord.js";
import { gameFeed } from "../src/logic/gameFeed/GameFeed";
import { CurrentGameManager } from "../src/logic/CurrentGameManager";
import { GuildMembership } from "../src/logic/GuildMembership";
import TeamCommand from "../src/commands/TeamCommand";
import { addRegisteredPlayersFeed } from "../src/logic/gameFeed/RegisteredGameFeed";
import { addTeamsGameFeed } from "../src/logic/gameFeed/TeamsGameFeed";
import { test } from "./framework/test";
import { Channels } from "../src/Channels";

const defer = <T>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; };
const flush = () => new Promise<void>(r=>setImmediate(r));
const player = (id:string) => ({discordSnowflake:id,ignUsed:id,elo:1000,captain:false}) as any;
function timers() {
  const oldSet=global.setInterval, oldClear=global.clearInterval;
  const ticks=new Map<number,()=>void>(); let i=0;
  (global as any).setInterval=(fn:()=>void)=>{ticks.set(++i,fn);return i;};
  (global as any).clearInterval=(id:number)=>ticks.delete(id);
  return { tick: async()=>{for(const fn of ticks.values())fn();await flush();}, restore:()=>{global.setInterval=oldSet;global.clearInterval=oldClear;} };
}
test("REGRESSION: failed first existence GET must not starve changed second feed",async()=>{
  const t=timers(); let title="Teams A"; let count=0; const edits:string[]=[]; let fail=false;
  const published = new Map<string, EmbedBuilder>();
  const channel:any={id:"review-starvation",send:async({embeds}:any)=>{
    const id=String(++count);published.set(id,embeds[0]);return {id};
  },messages:{
    fetch:async({message,force}:any)=>{assert.equal(force,true);if(fail&&message==="1")throw {code:50013};return {embeds:[published.get(message)]};},
    edit:async(id:string,{embeds}:any)=>{edits.push(id);published.set(id,embeds[0]);}
  }};
  try {
    gameFeed.addFeedMessage(channel,"registered",async()=>new EmbedBuilder().setTitle("Roster"));
    gameFeed.addFeedMessage(channel,"teams",async()=>new EmbedBuilder().setTitle(title));
    await gameFeed.startFeed(channel);assert.equal(count,2);
    fail=true;title="Teams B";await t.tick();await t.tick();
    assert.equal(count,2,"must not duplicate first feed");
    assert.deepEqual(edits,["2"],"independent team update must proceed despite first GET failure");
  } finally {gameFeed.stopFeed(channel);t.restore();}
});
test("unchanged feed repairs externally changed embeds without editing Discord metadata differences", async () => {
  const t = timers();
  let published: APIEmbed;
  let edits = 0;
  let sends = 0;
  const expected = () => new EmbedBuilder().setTitle("Roster")
    .addFields({ name: "Players", value: "Alice" });
  const channel: any = {
    id: "review-content-drift",
    send: async ({ embeds }: any) => {
      sends++;
      published = embeds[0].toJSON();
      return { id: "message" };
    },
    messages: {
      fetch: async () => ({
        embeds: [{ toJSON: () => ({
          ...published, type: "rich",
          fields: published.fields?.map(field => ({ ...field, inline: false })),
        }) }],
      }),
      edit: async (_id: string, { embeds }: any) => {
        edits++;
        published = embeds[0].toJSON();
      },
    },
  };
  try {
    gameFeed.addFeedMessage(channel, "roster", async () => expected());
    await gameFeed.startFeed(channel);
    await t.tick();
    assert.equal(edits, 0, "Server metadata and default inline flag are not drift");
    published = { ...published!, title: "Outdated roster" };
    await t.tick();
    assert.equal(edits, 1, "Authoritative content is repaired");
    assert.equal(published.title, "Roster");
    await t.tick();
    assert.equal(edits, 1, "No repeated edit for equivalent content");
    assert.equal(sends, 1, "No duplicate message");
  } finally {
    gameFeed.stopFeed(channel);
    t.restore();
  }
});

test("stop/restart while old send pending removes orphan and publishes replacement immediately",async()=>{
  const t=timers(); const pending=defer<any>(); const began=defer<void>(); let sends=0,deletes=0;
  const channel:any={id:"review-restart",send:async()=>{sends++;if(sends===1){began.resolve();return pending.promise;}return {id:"new",delete:async()=>{}};}};
  try{
    gameFeed.addFeedMessage(channel,"old",async()=>new EmbedBuilder().setTitle("Old"));
    const old=gameFeed.startFeed(channel);await began.promise;gameFeed.stopFeed(channel);
    gameFeed.addFeedMessage(channel,"new",async()=>new EmbedBuilder().setTitle("New"));
    await gameFeed.startFeed(channel);assert.equal(sends,1,"new start returns before publication");
    pending.resolve({id:"old",delete:async()=>{deletes++;}});await old;
    assert.equal(deletes,1);assert.equal(sends,2,"replacement publishes as soon as old generation drains");
  } finally {gameFeed.stopFeed(channel);t.restore();}
});
test("parallel membership reconciliation retains a member who returned before verification completed",async()=>{
  const game=CurrentGameManager.getCurrentGame(); const previous=TeamCommand.instance;const cmd=new TeamCommand();
  const slow=defer<any>(), observed=defer<void>();let returned=false;
  game.reset();game.announced=true;game.teams.UNDECIDED=[player("slow"),player("returning")];
  const guild:any={id:"review",members:{fetch:async({user,force}:any)=>{
    assert.equal(force,true);if(user==="slow")return slow.promise;
    if(!returned){observed.resolve();throw {code:10007};}return {id:user};
  }}};
  try{
    const running=cmd.runRosterOperation(()=>GuildMembership.reconcile(guild,cmd));
    await observed.promise;returned=true;slow.resolve({id:"slow"});
    const removed=await running;assert.deepEqual(removed,[]);
    assert.equal(game.getPlayers().some(p=>p.discordSnowflake==="returning"),true);
  } finally {game.reset();TeamCommand.instance=previous;}
});
test("batch failure waits for remaining pending request and blocks mutation",async()=>{
  const game=CurrentGameManager.getCurrentGame();const previous=TeamCommand.instance;const cmd=new TeamCommand();
  const pending=defer<any>(), began=defer<void>();let done=false;let calls=0;
  game.reset();game.announced=true;game.teams.UNDECIDED=["gone","error","wait","ok","later"].map(player);
  const guild:any={id:"review",members:{fetch:async({user}:any)=>{calls++;if(user==="gone")throw {code:10007};if(user==="error")throw {code:503};if(user==="wait"){began.resolve();return pending.promise;}return {id:user};}}};
  try{
    const run=cmd.runRosterOperation(()=>GuildMembership.reconcile(guild,cmd)).then(()=>{done=true;return false;},()=>{done=true;return true;});
    await began.promise;await flush();assert.equal(done,false);assert.equal(calls,4);assert.equal(game.getPlayers().length,5);
    pending.resolve({id:"wait"});assert.equal(await run,true);assert.equal(game.getPlayers().length,5);assert.equal(calls,4);
  } finally {game.reset();TeamCommand.instance=previous;}
});
test("only late signups and empty teams serialize within limits",async()=>{
  const game=CurrentGameManager.getCurrentGame();game.reset();const embeds:any[]=[];
  const channel:any={id:"review-late-only",send:async({embeds:e}:any)=>{embeds.push(e[0].toJSON());return {id:String(embeds.length)};}};
  try {
    game.teams.UNDECIDED=Array.from({length:100},(_,i)=>player("LatePlayer"+i));
    for(const p of game.getPlayers())game.lateSignups.add(p.discordSnowflake);
    await addRegisteredPlayersFeed(channel);await addTeamsGameFeed(channel);await gameFeed.startFeed(channel);
    assert.equal(embeds.length,2);assert.equal(embeds[0].title,"Registered Players (0)");
    assert.equal(embeds[0].fields[0].value.length,1024);
    assert.equal(embeds[1].fields[0].value,"No players");
  } finally {gameFeed.stopFeed(channel);game.reset();}
});
test("departure events are scoped to their original game and guild", async () => {
  const game = CurrentGameManager.getCurrentGame();
  const previous = TeamCommand.instance;
  const oldChannel = Channels.gameFeed;
  const cmd = new TeamCommand();
  const hold = defer<void>(), began = defer<void>();
  game.reset();
  game.announced = true;
  game.teams.UNDECIDED = [player("returning")];
  (Channels as any).gameFeed = { guild: { id: "game-guild", members: {
    fetch: async () => { throw { code: 10007 }; },
  } } };
  try {
    assert.equal(await cmd.handleGuildDeparture("returning", "other-guild"), false);
    assert.equal(game.getPlayers().length, 1);
    const replacing = cmd.runRosterOperation(async () => {
      began.resolve();
      await hold.promise;
      game.reset();
      game.announced = true;
      game.teams.UNDECIDED = [player("returning")];
    });
    await began.promise;
    const oldDeparture = cmd.handleGuildDeparture("returning", "game-guild");
    hold.resolve();
    await replacing;
    assert.equal(await oldDeparture, false);
    assert.equal(game.getPlayers().length, 1);
    assert.equal(await cmd.handleGuildDeparture("returning", "game-guild"), true);
    assert.equal(game.getPlayers().length, 0);
  } finally {
    game.reset();
    TeamCommand.instance = previous;
    Channels.gameFeed = oldChannel;
  }
});

test("uncertain absent-candidate recheck leaves the entire roster unchanged", async () => {
  const game = CurrentGameManager.getCurrentGame();
  const previous = TeamCommand.instance;
  const cmd = new TeamCommand();
  const calls = new Map<string, number>();
  game.reset();
  game.announced = true;
  game.teams.UNDECIDED = ["gone", "uncertain", "present"].map(player);
  const guild: any = { id: "review", members: { fetch: async ({ user }: any) => {
    const attempt = (calls.get(user) ?? 0) + 1;
    calls.set(user, attempt);
    if (user === "present") return { id: user };
    if (user === "uncertain" && attempt === 2) throw { code: 503 };
    throw { code: 10007 };
  } } };
  try {
    await assert.rejects(cmd.runRosterOperation(() => GuildMembership.reconcile(guild, cmd)));
    assert.equal(game.getPlayers().length, 3);
    assert.equal(calls.get("gone"), 2);
    assert.equal(calls.get("uncertain"), 2);
    assert.equal(calls.get("present"), 1);
  } finally {
    game.reset();
    TeamCommand.instance = previous;
  }
});
