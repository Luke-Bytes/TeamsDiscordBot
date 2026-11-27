import { ActionRowBuilder, EmbedBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, MessageFlags, type StringSelectMenuInteraction, type ButtonInteraction } from "discord.js";
import { scenarioRegistry } from "./ScenarioRegistry";
import { upcomingScenarioMetadata } from "./ScenarioMetadata";
import type { ScenarioDefinition } from "./ScenarioTypes";


export const GUIDE_MENU_ID = "fwguide:select";
export const GUIDE_OPEN_ID = "fwguide:open";
const HOME = "home";

export function scenarioInformation(definition: Pick<ScenarioDefinition, "name" | "description" | "information">): EmbedBuilder {
  const info = definition.information;
  const embed = new EmbedBuilder().setColor(0x5865f2)
    .setTitle(definition.name).setDescription(definition.description)
    .setFooter({ text: "Already registered and missed your instructions? Use /game scenario open." });
  if (!info) return embed;
  return embed.addFields(
    { name: "What players do", value: info.players },
    ...(info.captains ? [{ name: "What captains do", value: info.captains }] : []),
    { name: "How it works", value: info.rules },
    { name: "When to act", value: info.deadlines },
    ...(info.organiser ? [{ name: "For organisers", value: info.organiser }] : []),
  );
}

export function scenarioGuide(page = HOME) {
  const available = scenarioRegistry.available();
  const upcoming = Object.entries(upcomingScenarioMetadata)
    .filter(([id]) => !available.some((s) => s.id === id))
    .map(([id, metadata]) => ({ id, ...metadata }));
  const selected = [...available, ...upcoming].find((s) => s.id === page);
  const isUpcoming = upcoming.some((s) => s.id === page);
  if (page !== HOME && !selected) return null;
  const embed = selected ? scenarioInformation(selected) : new EmbedBuilder()
    .setColor(0x5865f2).setTitle("Friendly Wars - Scenario Guide")
    .setDescription("Fancy a Friendly War with a twist? Scenarios change things up with fun quizzes, unusual drafts, special rules and more!")
    .addFields(
      { name: "How to join", value: "Just register as usual! Keep an eye on your DMs and the game feed. The bot will let you know if there’s anything extra to do." },
      { name: "Missed your instructions?", value: "If you’ve registered and have something to do, use /game scenario open to pick up where you left off." },
      { name: "Explore the scenarios", value: "Pick a scenario from the menu below to see how it works." },
    );
  if (isUpcoming && selected) {
    embed.setDescription(`Coming soon! This scenario is still being worked on.\n\n${selected.description}`)
      .setFooter({ text: "Not available to play yet - rules may change." });
  }
  const menu = new StringSelectMenuBuilder().setCustomId(GUIDE_MENU_ID)
    .setPlaceholder("Choose a scenario")
    .addOptions([{ label: "Guide home", value: HOME, default: !selected },
      ...available.map((s) => ({ label: s.name, value: s.id, default: s.id === selected?.id })),
      ...upcoming.map((s) => ({ label: `${s.name} (Coming soon)`, value: s.id, default: s.id === selected?.id }))]);
  return { embeds: [embed], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] };
}

export function scenarioGuideButton(gameToken?: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(gameToken ? `${GUIDE_OPEN_ID}:${gameToken}` : GUIDE_OPEN_ID)
      .setLabel("Learn About Scenarios").setStyle(ButtonStyle.Secondary),
  );
}

export async function handleScenarioGuideMenu(interaction: StringSelectMenuInteraction) {
  const page = interaction.customId === GUIDE_MENU_ID && interaction.values.length === 1
    ? scenarioGuide(interaction.values[0]) : null;
  if (!page) {
    await interaction.reply({ content: "Couldn’t find that scenario. Try /game scenario guide again.", flags: MessageFlags.Ephemeral });
    return;
  }
  // Only edit private guide messages. Shared or old public menus open a new private guide.
  if (interaction.message.flags.has(MessageFlags.Ephemeral)) await interaction.update(page);
  else await interaction.reply({ ...page, flags: MessageFlags.Ephemeral });
}

export async function handleScenarioGuideButton(interaction: ButtonInteraction) {
  if (interaction.customId !== GUIDE_OPEN_ID && !interaction.customId.startsWith(`${GUIDE_OPEN_ID}:`)) return;
  const page = scenarioGuide();
  if (page) await interaction.reply({ ...page, flags: MessageFlags.Ephemeral });
}
