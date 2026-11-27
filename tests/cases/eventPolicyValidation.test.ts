import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";
import {
  EventAdmissionPolicy,
  eventAdmissionStatus,
  eventReservePromotions,
  regularEventSignupOpen,
} from "../../src/logic/EventPolicy";

const deadline = new Date("2030-06-01T12:00:00Z");
const before = new Date(deadline.getTime() - 1);
const open: EventAdmissionPolicy = {
  state: "OPEN",
  capacity: 2,
  signupDeadline: deadline,
};

test("event admission closes exactly at capacity or the deadline", () => {
  assertEqual(eventAdmissionStatus(open, 1, before), "CONFIRMED", "last place");
  assertEqual(eventAdmissionStatus(open, 2, before), "RESERVE", "capacity");
  assertEqual(
    eventAdmissionStatus(open, 0, deadline),
    "RESERVE",
    "deadline boundary"
  );
  assertEqual(
    eventAdmissionStatus(open, 0, new Date(deadline.getTime() + 1)),
    "RESERVE",
    "after deadline"
  );
});

test("manual event closure overrides available places; unlimited events remain open", () => {
  assertEqual(
    eventAdmissionStatus({ ...open, state: "CLOSED" }, 0, before),
    "RESERVE",
    "manual closure"
  );
  assert(
    regularEventSignupOpen(
      { ...open, capacity: null, signupDeadline: null },
      10000,
      deadline
    ),
    "unlimited admission"
  );
  assert(
    regularEventSignupOpen(open, 1, before),
    "capacity closure reopens after withdrawal"
  );
});

test("draft and finished events reject applications and never promote reserves", () => {
  for (const state of ["DRAFT", "FINISHED"] as const) {
    let rejected = false;
    try {
      eventAdmissionStatus({ ...open, state }, 0, before);
    } catch {
      rejected = true;
    }
    assert(rejected, `${state} application rejected`);
    assertEqual(
      eventReservePromotions({ ...open, state }, 0, [
        { id: "a", queuedAt: before },
      ]).length,
      0,
      `${state} promotion blocked`
    );
  }
});

test("event reserves promote FIFO after closure without mutating queue input", () => {
  const reserves = [
    { id: "later", queuedAt: deadline },
    { id: "first", queuedAt: before },
  ];
  assertEqual(
    eventReservePromotions({ ...open, state: "CLOSED" }, 1, reserves).join(","),
    "first",
    "oldest fills vacancy even after closure"
  );
  assertEqual(reserves[0].id, "later", "input order unchanged");
  assertEqual(
    eventReservePromotions(open, 2, reserves).length,
    0,
    "no overbooking"
  );
  assertEqual(
    eventReservePromotions({ ...open, capacity: null }, 2, reserves, before).join(","),
    "first,later",
    "unlimited promotions"
  );
});

test("event reserve promotion uses stable tie ordering", () => {
  const reserves = ["b", "a", "c"].map((id) => ({ id, queuedAt: deadline }));
  assertEqual(
    eventReservePromotions(open, 0, reserves).join(","),
    "a,b",
    "stable tie ordering and available places"
  );
});

test("unlimited closed events keep reserves until a confirmed withdrawal or reopening", () => {
  const reserves = ["a", "b"].map((id) => ({ id, queuedAt: before }));
  const closed = { ...open, capacity: null, state: "CLOSED" as const };
  assertEqual(
    eventReservePromotions(closed, 2, reserves, before).length,
    0,
    "manual close retains reserves"
  );
  assertEqual(
    eventReservePromotions({ ...closed, state: "OPEN" }, 2, reserves, deadline)
      .length,
    0,
    "deadline retains unlimited reserves"
  );
  assertEqual(
    eventReservePromotions(closed, 1, reserves, before, 1).join(","),
    "a",
    "withdrawal fills exactly one place"
  );
  assertEqual(
    eventReservePromotions({ ...closed, state: "OPEN" }, 1, reserves, before)
      .length,
    2,
    "reopening admits all when deadline allows"
  );
});

import {
  EventQuestion,
  validateEventAnswers,
  validateEventQuestions,
} from "../../src/logic/EventService";
import { eventCsvCell, eventPages } from "../../src/commands/EventPresentation";

function rejects(fn: () => void, message: string) {
  let failed = false;
  try {
    fn();
  } catch {
    failed = true;
  }
  assert(failed, message);
}
const questions: EventQuestion[] = [
  { id: "text", label: "Availability", type: "LONG_TEXT", required: true },
  {
    id: "single",
    label: "Region",
    type: "SINGLE_CHOICE",
    required: true,
    options: ["EU", "NA"],
  },
  {
    id: "multi",
    label: "Roles",
    type: "MULTI_CHOICE",
    required: false,
    options: ["Captain", "Player"],
  },
];

test("event form definitions enforce unique stable IDs and valid choice limits", () => {
  validateEventQuestions(questions);
  rejects(
    () => validateEventQuestions([...questions, questions[0]]),
    "duplicate question IDs rejected"
  );
  rejects(
    () => validateEventQuestions([{ ...questions[1], options: ["EU", "EU"] }]),
    "duplicate choices rejected"
  );
  rejects(
    () => validateEventQuestions([{ ...questions[1], options: [] }]),
    "empty choices rejected"
  );
  rejects(
    () =>
      validateEventQuestions([
        {
          ...questions[1],
          options: Array.from({ length: 26 }, (_, n) => String(n)),
        },
      ]),
    "choice limit enforced"
  );
  rejects(
    () =>
      validateEventQuestions(
        Array.from({ length: 21 }, (_, n) => ({
          ...questions[0],
          id: String(n),
        }))
      ),
    "question limit enforced"
  );
});

test("event answers require known fields and configured options", () => {
  validateEventAnswers(questions, {
    text: "Available",
    single: "EU",
    multi: ["Captain", "Player"],
  });
  validateEventAnswers(questions, { text: "Available", single: "NA" });
  rejects(
    () => validateEventAnswers(questions, { text: " ", single: "EU" }),
    "required text cannot be blank"
  );
  rejects(
    () => validateEventAnswers(questions, { text: "ok", single: "AS" }),
    "unknown single choice rejected"
  );
  rejects(
    () =>
      validateEventAnswers(questions, {
        text: "ok",
        single: "EU",
        multi: ["Captain", "Captain"],
      }),
    "duplicate multi choices rejected"
  );
  rejects(
    () =>
      validateEventAnswers(questions, {
        text: "ok",
        single: "EU",
        extra: "injected",
      }),
    "unknown question rejected"
  );
  rejects(
    () =>
      validateEventAnswers(questions, { text: "x".repeat(1001), single: "EU" }),
    "text limit enforced"
  );
});

test("event CSV quotes arbitrary text and neutralises spreadsheet formula prefixes", () => {
  assert(eventCsvCell('a,"b"\nc') === '"a,""b""\nc"', "CSV quoting");
  for (const input of ["=1+1", "+cmd", "-1", "@SUM(A1)", " \t=1"]) {
    assert(eventCsvCell(input).startsWith("\"'"), "formula prefix neutralised");
  }
  assert(eventCsvCell("Player") === '"Player"', "ordinary text unchanged");
});

test("event pagination keeps every character within Discord message limits", () => {
  const text = "long paragraph ".repeat(600);
  const pages = eventPages(text);
  assert(pages.length > 1, "long content paginated");
  assert(
    pages.every((page) => page.length <= 1800),
    "safe message length"
  );
  assert(pages.join("") === text, "no text lost in pagination");
});
