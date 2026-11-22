import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";
import { EventQuestion, EventService } from "../../src/logic/EventService";

const oldQuestion: EventQuestion = {
  id: "q1",
  label: "What would you like captains to know?",
  type: "LONG_TEXT",
  required: true,
};

function fixture(state = "OPEN") {
  const event: any = {
    id: "cup",
    guildId: "guild",
    state,
    openedAt: state === "DRAFT" ? null : new Date(),
    revision: 0,
    formRevision: 4,
    capacity: 5,
    signupDeadline: null,
    questions: [oldQuestion],
  };
  const applications: any[] = [
    {
      status: "CONFIRMED",
      answers: { q1: "Happy to defend" },
    },
    {
      status: "RESERVE",
      answers: { q1: "I prefer mid" },
    },
  ];
  let questionWrites = 0;
  const db: any = {
    standaloneEvent: {
      findFirst: async ({ where }: any) =>
        where.id === event.id && where.guildId === event.guildId
          ? { ...event }
          : null,
      updateMany: async ({ where, data }: any) => {
        if (where.id !== event.id || where.revision !== event.revision)
          return { count: 0 };
        event.revision += data.revision.increment;
        return { count: 1 };
      },
      update: async ({ data }: any) => {
        if (data.questions) {
          questionWrites++;
          event.questions = data.questions;
          event.formRevision += data.formRevision.increment;
        } else {
          Object.assign(event, data);
        }
        return { ...event };
      },
    },
    eventSignup: {
      findMany: async ({ where }: any) =>
        applications.filter(
          (row) =>
            !where.status ||
            (where.status.in
              ? where.status.in.includes(row.status)
              : where.status === row.status)
        ),
      count: async ({ where }: any) =>
        applications.filter((row) => row.status === where.status).length,
      updateMany: async () => ({ count: 0 }),
    },
    $transaction: async (run: any) => run(db),
  };
  return {
    event,
    applications,
    service: new EventService(db),
    questionWrites: () => questionWrites,
  };
}

async function errorMessage(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return String(error);
  }
  throw new Error("Expected rejection.");
}

test("organiser can close an opened event, edit questions, and reopen with existing sign-ups", async () => {
  const f = fixture();
  await f.service.close("guild", "cup");
  assertEqual(f.event.state, "CLOSED", "event closed for question maintenance");
  const revision = f.event.formRevision;
  const edited: EventQuestion[] = [
    { ...oldQuestion, label: "Tell your captain what roles you prefer" },
  ];
  await f.service.setQuestions("guild", "cup", edited);
  assertEqual(
    f.event.questions[0].label,
    edited[0].label,
    "question text edited"
  );
  assertEqual(f.event.formRevision, revision + 1, "form revision advanced");
  assertEqual(
    f.applications[0].answers.q1,
    "Happy to defend",
    "confirmed player's original answer preserved"
  );
  assertEqual(
    f.applications[1].answers.q1,
    "I prefer mid",
    "reserve player's original answer preserved"
  );
  await f.service.reopen("guild", "cup");
  assertEqual(f.event.state, "OPEN", "same event reopened");
  assertEqual(f.event.questions[0].id, "q1", "question ID remains stable");
});

test("questions stay locked while OPEN or FINISHED, and draft editing still works", async () => {
  const questions = [{ ...oldQuestion, label: "Updated question" }];
  const open = fixture("OPEN");
  const blocked = await errorMessage(() =>
    open.service.setQuestions("guild", "cup", questions)
  );
  assert(blocked.includes("/event close"), "clear instruction to close first");
  assertEqual(open.questionWrites(), 0, "open event unchanged");

  const finished = fixture("FINISHED");
  await errorMessage(() =>
    finished.service.setQuestions("guild", "cup", questions)
  );
  assertEqual(finished.questionWrites(), 0, "finished event unchanged");

  const draft = fixture("DRAFT");
  await draft.service.setQuestions("guild", "cup", questions);
  assertEqual(draft.questionWrites(), 1, "draft edits still permitted");
});

test("closed event edits reject changes that invalidate confirmed/reserve responses", async () => {
  const f = fixture("CLOSED");
  const requiredNewQuestion: EventQuestion = {
    id: "q2",
    label: "Who do you want to captain?",
    type: "SHORT_TEXT",
    required: true,
  };
  const missing = await errorMessage(() =>
    f.service.setQuestions("guild", "cup", [oldQuestion, requiredNewQuestion])
  );
  assert(
    missing.includes("invalidate existing sign-up answers"),
    "required additions cannot invalidate previous signups"
  );

  const changedType = await errorMessage(() =>
    f.service.setQuestions("guild", "cup", [
      { ...oldQuestion, type: "SINGLE_CHOICE", options: ["Defend", "Scout"] },
    ])
  );
  assert(
    changedType.includes("invalidate existing sign-up answers"),
    "new choices must accept saved answers"
  );

  const removed = await errorMessage(() =>
    f.service.setQuestions("guild", "cup", [])
  );
  assert(
    removed.includes("invalidate existing sign-up answers"),
    "removing answered question is blocked"
  );
  assertEqual(f.questionWrites(), 0, "invalid edits never save");

  await f.service.setQuestions("guild", "cup", [
    oldQuestion,
    { ...requiredNewQuestion, required: false },
  ]);
  assertEqual(f.questionWrites(), 1, "optional addition is allowed");
  assertEqual(f.event.formRevision, 5, "successful change advances revision");
});

test("closed event editing checks only active applicants and keeps withdrawn history", async () => {
  const f = fixture("CLOSED");
  f.applications.push({
    status: "WITHDRAWN",
    answers: { removed: "prior answer" },
  });
  await f.service.setQuestions("guild", "cup", [
    { ...oldQuestion, label: "Updated" },
  ]);
  assertEqual(
    f.questionWrites(),
    1,
    "withdrawn history does not block current form updates"
  );
});
