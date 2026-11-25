import { randomInt } from "node:crypto";

const MAX_FLIPS = 10_000;
const MAX_SEQUENCE = 20;

/** Only explicit simulation requests; ordinary questions about /coinflip go to Navi. */
export function requestedCoinFlips(question: string): number | null {
  const q = question.trim().replace(/[.!?]+$/, "");
  const match =
    /^(?:(?:can you|please)\s+)?(?:do |simulate |perform |give me |run )?(\d{1,12})\s+(?:random\s+)?coin flips?$/i.exec(
      q
    ) ??
    /^(?:(?:can you|please)\s+)?flip (?:a|the) coin\s+(\d{1,12})\s+times?$/i.exec(
      q
    ) ??
    /^(?:(?:can you|please)\s+)?(?:flip (?:a|the) coin|coinflip|coin flip)$/i.exec(
      q
    );
  if (!match) return null;
  return match[1] === undefined ? 1 : Number(match[1]);
}

/** Explicit two-candidate simulations; never resolve or publish Discord IDs. */
export function requestedCoinPair(question: string): {
  count: number;
  labels: [string, string];
} | null {
  const q = question.trim().replace(/[.!?]+$/, "");
  const match =
    /^(.*? coin flips?|(?:please |can you )?flip (?:a|the) coin) between (<@!?\d{17,20}>|[a-zA-Z0-9_]{3,16}) and (<@!?\d{17,20}>|[a-zA-Z0-9_]{3,16})(?: (\d{1,12}) times?)?$/i.exec(
      q
    );
  if (!match) return null;
  const first = match[2];
  const second = match[3];
  if (
    first.replace("!", "").toLowerCase() ===
    second.replace("!", "").toLowerCase()
  )
    return null;
  const count = requestedCoinFlips(
    match[4] ? `flip a coin ${match[4]} times` : match[1]
  );
  if (count === null) return null;
  return {
    count,
    labels: [
      first.startsWith("<@") ? "first mentioned user" : first,
      second.startsWith("<@") ? "second mentioned user" : second,
    ],
  };
}

/** Use actual independent random draws, never model-generated outcomes. */
export function simulateCoinFlips(
  count: number,
  draw: () => number = () => randomInt(2),
  labels?: [string, string]
): string {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_FLIPS)
    return "Choose between 1 and 10,000 coin flips.";
  let heads = 0;
  const sequence: string[] = [];
  for (let index = 0; index < count; index++) {
    const head = draw() === 0;
    if (head) heads++;
    if (count <= MAX_SEQUENCE) sequence.push(head ? "H" : "T");
  }
  const tails = count - heads;
  if (labels) {
    if (count === 1) return `🪙 Winner: ${heads ? labels[0] : labels[1]}!`;
    return `🪙 ${count} coin flips: **${labels[0]} won ${heads}, ${labels[1]} won ${tails}**.`;
  }
  if (count === 1) return heads ? "🪙 Heads!" : "🪙 Tails!";
  return `🪙 ${count} coin flips: **${heads} heads, ${tails} tails**.${
    sequence.length ? `\nOrder (H/T): ${sequence.join(" ")}` : ""
  }`;
}
