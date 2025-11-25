import { test } from "../framework/test";
import { assert } from "../framework/assert";
import CaptainPlanDMManager from "../../src/logic/CaptainPlanDMManager";
import { MessageSafetyUtil } from "../../src/util/MessageSafetyUtil";
import { Client, Message, User } from "discord.js";

function createFakeUser(id: string, dmLog: any[]): User {
  return {
    id,
    bot: false,
    send: async (payload: any) => {
      dmLog.push(payload);
      return {};
    },
  } as unknown as User;
}

function createFakeClient(user: User): Client {
  return {
    users: {
      fetch: async () => user,
    },
  } as unknown as Client;
}

function createDM(author: User, content: string, attachmentCount = 0): Message {
  return {
    author: author as User & { bot: boolean },
    guild: null,
    content,
    attachments: { size: attachmentCount },
  } as unknown as Message;
}

test("CaptainPlanDMManager rejects empty or low-effort plans", async () => {
  const dmLog: any[] = [];
  const fakeUser = createFakeUser("cap-1", dmLog);
  const manager = new CaptainPlanDMManager();
  await manager.startForCaptain({
    client: createFakeClient(fakeUser),
    captainId: fakeUser.id,
    team: "RED",
    teamList: "Alice\nBob",
    members: ["cap-1", "p2"],
  });

  const handled = await manager.handleDM(createDM(fakeUser, "hi"));
  assert(handled, "Manager should handle short message");
  assert(
    manager.hasPendingSession(fakeUser.id),
    "Session should stay in awaitMessage after rejection"
  );
  const feedback = dmLog[dmLog.length - 1];
  assert(
    typeof feedback === "object" &&
      feedback.content.includes("little more detail"),
    "Captain should receive guidance for short plans"
  );
});

test("CaptainPlanDMManager accepts valid plans and sends preview buttons", async () => {
  const dmLog: any[] = [];
  const fakeUser = createFakeUser("cap-2", dmLog);
  const manager = new CaptainPlanDMManager();
  await manager.startForCaptain({
    client: createFakeClient(fakeUser),
    captainId: fakeUser.id,
    team: "BLUE",
    teamList: "Charlie\nDana",
    members: ["cap-2", "p3"],
  });

  const message = createDM(
    fakeUser,
    "Push mid, defend nexus, rotate invis on call."
  );
  const handled = await manager.handleDM(message);
  assert(handled, "Manager should handle valid plan");
  assert(
    !manager.hasPendingSession(fakeUser.id),
    "Session should move to confirmation stage"
  );
  assert(
    manager.buttonIds.includes(`plan-confirm:${fakeUser.id}`),
    "Confirm button should be registered"
  );
  const preview = dmLog[dmLog.length - 1];
  assert(
    preview.components?.length === 1,
    "Preview response should include action row"
  );
});

test("MessageSafetyUtil blocks mass mentions and slurs", () => {
  const mentionResult = MessageSafetyUtil.validateCaptainPlanMessage(
    "Focus mid @everyone bring invis pots",
    false
  );
  assert(!mentionResult.valid, "Mass mentions should be blocked");
  const slurResult = MessageSafetyUtil.validateCaptainPlanMessage(
    "our plan insults with slur retard",
    false
  );
  assert(!slurResult.valid, "Slurs should be blocked");
  const attachmentResult = MessageSafetyUtil.validateCaptainPlanMessage(
    "",
    true
  );
  assert(
    attachmentResult.valid,
    "Attachments should bypass length requirement"
  );
});
