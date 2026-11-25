import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";
import {
  eventResponseGrid,
  eventStatsEmbed,
} from "../../src/commands/EventPresentation";

const event: any = {
  id: "cup",
  title: "Community Cup",
  state: "OPEN",
  capacity: 8,
  questions: [
    { id: "q1", label: "Preferred role?", type: "SHORT_TEXT", required: true },
    { id: "q2", label: "Availability?", type: "LONG_TEXT", required: false },
  ],
};
function entry(n: number, status = "CONFIRMED"): any {
  return {
    discordUserId: String(n),
    minecraftUsername: `Player${n}`,
    status,
    answers: {
      q1: n === 1 ? "@everyone " + "x".repeat(1000) : "Defender",
      q2: n === 2 ? ["Monday", "Tuesday"] : "",
    },
  };
}

test("event response grid pages players and selects a question without exposing full long answers", () => {
  const rows = Array.from({ length: 13 }, (_, n) =>
    entry(n + 1, n === 12 ? "WITHDRAWN" : "CONFIRMED")
  );
  const first = eventResponseGrid(event, rows).toJSON();
  assert(first.description!.includes("Question 1/2"), "question heading shown");
  assertEqual(first.fields!.length, 6, "bounded embed grid size");
  assert(first.fields![0].value.includes("@everyone"), "answer retained");
  assert(
    first.fields![0].value.includes("truncated"),
    "very long answers clearly shortened"
  );
  assert(
    !first.fields!.some((field) => field.name.includes("Player13")),
    "first page excludes later signups"
  );
  const last = eventResponseGrid(event, rows, 2, 3).toJSON();
  assertEqual(last.fields!.length, 1, "final page contains remaining entry");
  assert(last.description!.includes("Question 2/2"), "selected question shown");
  assert(last.fields![0].name.includes("Player13"), "last signup included");
  assert(last.fields![0].name.includes("WITHDRAWN"), "withdrawal marked");
});

test("event response and stats embeds handle no entries and no questions", () => {
  const empty = { ...event, questions: [] };
  const grid = eventResponseGrid(empty, []).toJSON();
  assert(
    grid.description!.includes("No responses yet"),
    "empty state explicit"
  );
  assertEqual(grid.fields?.length ?? 0, 0, "no fabricated rows");
  const stats = eventStatsEmbed(event, [
    entry(1),
    entry(2),
    entry(3, "RESERVE"),
    entry(4, "WITHDRAWN"),
  ]).toJSON();
  const fields = Object.fromEntries(
    stats.fields!.map((field) => [field.name, field.value])
  );
  assertEqual(fields["Total entries"], "4", "withdrawn are included in total");
  assertEqual(fields["Active entries"], "3", "withdrawn not active");
  assertEqual(fields["Confirmed"], "2", "confirmed counted");
  assertEqual(fields["Reserves"], "1", "reserves counted");
  assertEqual(fields["Withdrawn"], "1", "withdrawals counted");
  assert(
    fields["Capacity"].includes("6 places left"),
    "remaining places based on confirmed"
  );
  assertEqual(
    eventStatsEmbed({ ...event, capacity: null }, []).toJSON().fields![5].value,
    "Unlimited",
    "unlimited capacity described"
  );
});

test("event response grid rejects invalid question and page selections", () => {
  for (const [question, page] of [
    [3, 1],
    [1, 2],
    [0, 1],
  ]) {
    let thrown = false;
    try {
      eventResponseGrid(event, [entry(1)], question, page);
    } catch {
      thrown = true;
    }
    assert(thrown, "invalid index rejected");
  }
});
