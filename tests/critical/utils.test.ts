import { test } from "../framework/test";
import { assertEqual } from "../framework/assert";
import { escapeText } from "../../src/util/Utils";

test("escapeText escapes unpaired underscores", () => {
  assertEqual(
    escapeText("Ice_otter"),
    "Ice\\_otter",
    "Single underscore should be escaped"
  );
});

test("escapeText escapes paired delimiters", () => {
  assertEqual(
    escapeText("_test_"),
    "\\_test\\_",
    "Single underscore pairs should be escaped"
  );
  assertEqual(
    escapeText("__test__"),
    "\\_\\_test\\_\\_",
    "Double underscores should be escaped"
  );
  assertEqual(
    escapeText("**bold** and *em*"),
    "\\*\\*bold\\*\\* and \\*em\\*",
    "Asterisks used for formatting should be escaped"
  );
  assertEqual(
    escapeText("~~strike~~"),
    "\\~\\~strike\\~\\~",
    "Strikethrough markers should be escaped"
  );
});

test("escapeText escapes common IGN underscore variants", () => {
  const cases: Array<[string, string]> = [
    ["_Notch", "\\_Notch"],
    ["Notch_", "Notch\\_"],
    ["Not_A_Chill_Guy_", "Not\\_A\\_Chill\\_Guy\\_"],
    ["__Notch__", "\\_\\_Notch\\_\\_"],
    ["A__B", "A\\_\\_B"],
    ["A___B", "A\\_\\_\\_B"],
    ["A____B", "A\\_\\_\\_\\_B"],
    ["A_B__C___D", "A\\_B\\_\\_C\\_\\_\\_D"],
    ["A__B__C_", "A\\_\\_B\\_\\_C\\_"],
    ["__A_B__", "\\_\\_A\\_B\\_\\_"],
  ];

  for (const [input, expected] of cases) {
    assertEqual(escapeText(input), expected, `Unexpected result for ${input}`);
  }
});

test("escapeText still prevents block quotes and inline code", () => {
  assertEqual(
    escapeText("> quoted"),
    "\\> quoted",
    "Leading block quote markers should be escaped"
  );
  assertEqual(
    escapeText("`code`"),
    "\\`code\\`",
    "Inline code markers should be escaped"
  );
});
