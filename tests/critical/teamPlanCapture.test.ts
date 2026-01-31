import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";
import { parsePlanText, buildTeamPlanRecord } from "../../src/util/PlanUtil";
import { GameInstance } from "../../src/database/GameInstance";
import CaptainPlanDMManager from "../../src/logic/CaptainPlanDMManager";

const PLAN_TEXT = `**Mid Blocks Plan**
\`\`\`
A
B
C
\`\`\`
**Game Plan**
\`\`\`
X
Y
Z
\`\`\``;

test("Plan parser captures mid blocks and game plan (happy path)", async () => {
  const parsed = parsePlanText(PLAN_TEXT);
  assert(parsed.midBlocks === "A\nB\nC", "Mid blocks parsed");
  assert(parsed.gamePlan === "X\nY\nZ", "Game plan parsed");
  assert(parsed.confidence === "full", "Parser confidence should be full");
});

test("Plan parser returns none when no headers are present (sad path)", async () => {
  const parsed = parsePlanText("hello world");
  assert(parsed.confidence === "none", "Should not parse without headers");
});

test("Plan parser handles only mid blocks present (sad path)", async () => {
  const text = `**Mid Blocks Plan**\n\`\`\`\nA\n\`\`\``;
  const parsed = parsePlanText(text);
  assert(parsed.midBlocks === "A", "Mid blocks parsed");
  assert(parsed.gamePlan === null, "Game plan missing");
  assert(parsed.confidence === "partial", "Parser confidence should be partial");
});

test("Plan parser ignores extra lines after header without code block (edge)", async () => {
  const text = `**Game Plan**\nLine1\nLine2\n**Mid Blocks Plan**\nLine3`;
  const parsed = parsePlanText(text);
  assert(parsed.gamePlan?.includes("Line1"), "Game plan lines parsed");
});

test("Plan parser handles uppercase headers and spacing (edge)", async () => {
  const text = `MID   BLOCKS   PLAN\n\`\`\`\nMB\n\`\`\`\nGAME PLAN\n\`\`\`\nGP\n\`\`\``;
  const parsed = parsePlanText(text);
  assert(parsed.midBlocks === "MB", "Mid blocks parsed with uppercase header");
  assert(parsed.gamePlan === "GP", "Game plan parsed with uppercase header");
});

test("Plan parser uses the first matching section when duplicated (edge)", async () => {
  const text = `**Mid Blocks Plan**\n\`\`\`\nOld\n\`\`\`\n**Mid Blocks Plan**\n\`\`\`\nNew\n\`\`\``;
  const parsed = parsePlanText(text);
  assert(parsed.midBlocks === "Old", "First mid block captured");
});

test("Plan parser trims whitespace inside code blocks (edge)", async () => {
  const text = `**Game Plan**\n\`\`\`\n  A\n  B\n\`\`\``;
  const parsed = parsePlanText(text);
  assert(parsed.gamePlan === "A\n  B", "Whitespace trimmed but internal spacing preserved");
});

test("buildTeamPlanRecord uses raw only when partial (edge)", async () => {
  const record = buildTeamPlanRecord(
    `**Game Plan**\n\`\`\`\nPlan\n\`\`\``,
    "DM"
  );
  assert(record?.raw, "Raw should be kept for partial parse");
});

test("DM plan confirm stores plan on game instance (edge)", async () => {
  const game = GameInstance.getInstance();
  game.reset();
  const mgr = new CaptainPlanDMManager();
  const captainId = "cap-1";

  await mgr.startForCaptain({
    client: {
      users: {
        fetch: async () => ({
          send: async () => {},
        }),
      },
    } as any,
    captainId,
    team: "RED",
    teamList: "A\nB",
    members: [
      { id: "cap-1", ign: "Cap" },
      { id: "p1", ign: "P1" },
    ],
  });

  // Simulate captain message and confirm
  await mgr.handleDM({
    author: { id: captainId, bot: false, send: async () => ({}) },
    content: PLAN_TEXT,
    attachments: { size: 0 },
    guild: null,
  } as any);

  await mgr.handleButtonPress({
    customId: `plan-confirm:${captainId}`,
    client: {} as any,
    deferUpdate: async () => {},
    editReply: async () => {},
  } as any);

  assert(game.redTeamPlan?.gamePlan === "X\nY\nZ", "DM plan stored");
});
