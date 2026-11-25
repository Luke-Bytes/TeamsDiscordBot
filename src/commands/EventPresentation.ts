import { EmbedBuilder } from "discord.js";
import { EventSignup, StandaloneEvent } from "@prisma/client";
import { eventQuestions } from "../logic/EventService";
import { escapeText } from "../util/Utils";

export function eventCsvCell(value: unknown): string {
  let text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function eventPages(text: string, limit = 1800): string[] {
  const pages: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const newline = remaining.lastIndexOf("\n", limit);
    const split = newline > limit / 2 ? newline : limit;
    pages.push(remaining.slice(0, split));
    remaining = remaining.slice(split);
  }
  pages.push(remaining || "(empty)");
  return pages;
}

export function eventDisplay(value: string): string {
  return escapeText(value);
}

const RESPONSE_PAGE_SIZE = 6;

function answerPreview(value: unknown): string {
  const answer = Array.isArray(value) ? value.join(", ") : String(value ?? "");
  const compact = answer.replace(/\s+/g, " ").trim();
  if (!compact) return "*(no answer)*";
  const preview = eventDisplay(compact);
  return preview.length > 650
    ? `${preview.slice(0, 650)}… *(truncated; see /event response)*`
    : preview;
}

/** A question-at-a-time grid keeps long answers readable inside Discord's embed limits. */
export function eventResponseGrid(
  event: StandaloneEvent,
  rows: EventSignup[],
  questionNumber = 1,
  page = 1
): EmbedBuilder {
  const questions = eventQuestions(event);
  if (
    !Number.isInteger(questionNumber) ||
    questionNumber < 1 ||
    (questions.length && questionNumber > questions.length) ||
    (!questions.length && questionNumber !== 1)
  )
    throw new Error(
      `Question must be between 1 and ${Math.max(1, questions.length)}.`
    );
  const pages = Math.max(1, Math.ceil(rows.length / RESPONSE_PAGE_SIZE));
  if (!Number.isInteger(page) || page < 1 || page > pages)
    throw new Error(`Page must be between 1 and ${pages}.`);

  const question = questions[questionNumber - 1];
  const shown = rows.slice(
    (page - 1) * RESPONSE_PAGE_SIZE,
    page * RESPONSE_PAGE_SIZE
  );
  const embed = new EmbedBuilder()
    .setTitle("Event responses")
    .setDescription(
      `**${eventDisplay(event.title.slice(0, 100))}**\n${question ? `Question ${questionNumber}/${questions.length}: ${eventDisplay(question.label)}` : "No questionnaire questions."}\n\n${rows.length} total entries (including withdrawn). ${rows.length ? "Use `question` and `page` to browse; long answers may be shortened." : "No responses yet."}`
    )
    .setFooter({
      text: `Page ${page}/${pages} · /event response for full answers · /event export for CSV`,
    });
  for (const row of shown) {
    const answers = row.answers as Record<string, unknown>;
    embed.addFields({
      name: `${eventDisplay(row.minecraftUsername.slice(0, 64))} — ${row.status}`.slice(
        0,
        256
      ),
      value: question ? answerPreview(answers[question.id]) : "Registered",
      inline: true,
    });
  }
  return embed;
}

export function eventStatsEmbed(
  event: StandaloneEvent,
  rows: EventSignup[]
): EmbedBuilder {
  const confirmed = rows.filter((row) => row.status === "CONFIRMED").length;
  const reserves = rows.filter((row) => row.status === "RESERVE").length;
  const withdrawn = rows.filter((row) => row.status === "WITHDRAWN").length;
  const active = confirmed + reserves;
  const capacity = event.capacity;
  const remaining =
    capacity === null ? null : Math.max(0, capacity - confirmed);
  return new EmbedBuilder()
    .setTitle("Event statistics")
    .setDescription(
      `**${eventDisplay(event.title.slice(0, 150))}** — ${event.state}`
    )
    .addFields(
      { name: "Total entries", value: String(rows.length), inline: true },
      { name: "Active entries", value: String(active), inline: true },
      { name: "Withdrawn", value: String(withdrawn), inline: true },
      { name: "Confirmed", value: String(confirmed), inline: true },
      { name: "Reserves", value: String(reserves), inline: true },
      {
        name: "Capacity",
        value:
          capacity === null
            ? "Unlimited"
            : `${confirmed}/${capacity} confirmed · ${remaining} places left`,
        inline: true,
      },
      {
        name: "Form questions",
        value: String(eventQuestions(event).length),
        inline: true,
      }
    )
    .setFooter({
      text: "Entries are unique applicants; withdrawn submissions are retained in the total.",
    });
}
