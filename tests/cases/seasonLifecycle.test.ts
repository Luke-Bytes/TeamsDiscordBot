import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { SeasonService } from "../../src/database/SeasonService";
import SeasonCommand from "../../src/commands/SeasonCommand";
import ScriptsCommand from "../../src/commands/ScriptsCommand";

test("season calendar deadlines preserve calendar dates and clamp month ends", () => {
  const leap = SeasonService.calculateDeadline(
    new Date("2024-01-31T19:30:00.000Z"),
    1
  );
  assert(
    leap?.toISOString() === "2024-02-29T19:30:00.000Z",
    "January 31 clamps to leap-day in a leap year"
  );

  const multiMonth = SeasonService.calculateDeadline(
    new Date("2025-11-30T19:30:00.000Z"),
    3
  );
  assert(
    multiMonth?.toISOString() === "2026-02-28T19:30:00.000Z",
    "Whole calendar month addition clamps at the destination month end"
  );
  assert(
    SeasonService.calculateDeadline(new Date(), null) === null,
    "A cleared month limit disables its deadline"
  );
});

test("season command exposes the organiser lifecycle surface", () => {
  const json = new SeasonCommand().data.toJSON();
  const names = (json.options ?? []).map((option) => option.name).sort();
  assert(
    JSON.stringify(names) ===
      JSON.stringify(["configure", "end", "start", "status", "view"]),
    "Season command has view, status, configure, end, and start"
  );
});

test("scripts command no longer exposes season-update", () => {
  const json = new ScriptsCommand().data.toJSON();
  const names = (json.options ?? []).map((option) => option.name);
  assert(
    names.length === 1 && names[0] === "titles-update",
    "Only the title reconciliation repair remains"
  );
});
