import { test } from "../framework/test";
import { assertEqual } from "../framework/assert";
import { escapeText } from "../../src/util/Utils";

test("escapeText leaves single underscores untouched", () => {
  assertEqual(
    escapeText("Ice_otter"),
    "Ice_otter",
    "Single underscore should remain"
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
