import type { ScenarioInformation } from "./ScenarioTypes";

type Metadata = { name: string; description: string; information: ScenarioInformation };
/** Player-facing rules, not the historical design proposals in docs/scenarios. */
export const scenarioMetadata = {
  "mystery-dungeon": {
    name: "Mystery Dungeon - Personality Test",
    description: "Take a fun personality quiz and see what kind of teammate you are! Your result helps the bot put the teams together.",
    information: {
      players: "After registering, answer five questions and submit your quiz if you fancy it. You can change your answers or keep your personality type private.",
      rules: "The bot tries to balance skill, team sizes and personality types. Your answers stay private. You can choose whether your type is shown when teams are revealed.",
      deadlines: "Finish your quiz at least 15 minutes before the game. Didn't finish? No worries, you can still play.",
      organiser: "Confirm the teams, then choose captains as usual.",
    },
  },
  "peoples-captains": {
    name: "The People's Captains",
    description: "Let the players decide who leads their teams! Everyone who registers can be elected captain.",
    information: {
      players: "Everyone who registers can be elected captain! When voting opens, pick one of the three names in your private ballot. You can't vote for yourself.",
      rules: "Everyone appears on exactly three ballots. The two players with the most votes win; ties are decided by a fixed draw. You can change your private vote until voting closes.",
      deadlines: "Voting usually opens 35 minutes before the game and closes 20 minutes before. We need at least four registered players. If too few people vote, the organiser will need to step in.",
      captains: "If you're elected and confirmed, you'll pick your team as usual.",
      organiser: "Confirm the winning captains. If someone can't captain, review the result and offer the next supported candidate.",
    },
  },
  "partners-in-crime": {
    name: "Partners in Crime",
    description: "Got a favourite teammate? Pick each other and the bot will try to put you on the same team.",
    information: {
      players: "After registering, privately pick one other registered player or choose No preference. You can change your mind before teams are picked.",
      rules: "You'll only form a pair if you both pick each other. The bot tries to keep you together while making balanced teams, but can't promise it. Your choice stays private unless you both agree to reveal a successful pairing.",
      deadlines: "Choose at least 15 minutes before the game. No partner? You'll still be placed on a team.",
      organiser: "Check and confirm the teams.",
    },
  },
  "masked-draft": {
    name: "The Masked Draft",
    description: "Build your team from mystery cards with clues from past matches. Weigh up the evidence before the big reveal!",
    information: {
      players: "Register as usual and wait for the team reveal. Don't give away who's behind the cards!",
      captains: "Pick a mystery card in the team-picking channel when it's your turn. Look for win rates with today's captains, results on particular maps, captain experience, MVP records or recent form. Some cards are a complete mystery.",
      rules: "It's a normal snake draft, except player names are hidden. Clues come from recorded matches in the past year, not self-reported playstyles or Elo. Clues give broad results from sufficient match history, not exact rankings. Partner clues refer to today's known captains, not historical team colours. You'll find out who's on each team once the organiser confirms the picks.",
      deadlines: "You have two minutes for the first pick and one minute for each later pick. Run out of time and the bot picks a card for you.",
      organiser: "Confirm the draft to reveal the teams.",
    },
  },
  "draft-roulette": {
    name: "Draft Roulette",
    description: "A draft with a little luck thrown in! Captains can only pick from a small selection of players each turn.",
    information: {
      players: "Register as usual and wait to see which team you land on.",
      captains: "Pick from up to three players offered on your turn in the team-picking channel. Don't like your options? You get one reroll for the whole draft, if other players are available.",
      rules: "The bot deals a fresh selection each turn. Apart from the limited choices, it's a normal snake draft.",
      deadlines: "You have two minutes for the first pick and one minute for each later pick. If time runs out, the bot picks from your current options.",
      organiser: "Confirm the draft to reveal the teams.",
    },
  },
  "captains-wildcards": {
    name: "Captain's Wildcards",
    description: "A normal draft with a twist: each captain gets one special power to shake things up.",
    information: {
      players: "Register as usual. Don't get too comfortable with the draft picks - a wildcard might change things!",
      captains: "Choose one power during the draft:\n**Veto:** Stop the other captain picking a certain player on their next turn.\n**Switcheroo:** Trade one of your drafted teammates for someone who hasn't been picked yet.\nUse your private prompt to confirm your choice.",
      rules: "You can only use a power when the bot offers it. You can back out before confirming without losing your wildcard.",
      deadlines: "Your pick timer keeps ticking! If you don't use your wildcard, just carry on drafting as usual.",
    },
  },
  "class-hex": {
    name: "Cursed Classes",
    description: "Make life a little harder for the other team by giving three of their players a class they have to stick with!",
    information: {
      players: "Register as usual. If you're cursed, stick with your assigned class for the whole game, including after respawning whenever you can select a class. Don't own it? Use /game scenario report-class before the game starts.",
      captains: "Once teams are picked, you'll both get the same three randomly drawn classes. Privately assign each class to a different enemy player and submit your choices.",
      rules: "The organiser chooses which classes can be drawn. Once both captains submit, all six curses are revealed. It's an honour rule, so please stick to your class!",
      deadlines: "Captains must submit at least three minutes before the game. If anything is missing or someone can't use their class, the organiser will sort it out before starting.",
      organiser: "Choose at least three eligible classes with /game scenario pool and check any class access reports.",
    },
  },
} satisfies Record<string, Metadata>;

/** Guide previews only; never used as selectable scenarios or live Navi rules. */
export const upcomingScenarioMetadata = {
  "the-impostors": {
    name: "The Impostors",
    description: "Someone on your team is up to no good! Play to win, spot the impostors and see who gets away with their secret missions.",
    information: {
      players: "Once teams are picked, check your private role. If you're innocent, play as usual and keep an eye on your teammates. You can make an early guess at who's an impostor before the game starts!",
      rules: "Impostors get five secret missions and aim to complete any four without getting caught. Expect a few suspicious goings-on and temporary voice chat sabotages. Everyone still tries to win. Only assigned sabotage is allowed, and no sharing role cards or screensharing in team voice chat.",
      deadlines: "After the game, you'll have four minutes to discuss your suspicions, then one minute to vote privately. You get one vote per impostor on your team. Impostors submit their mission proof after voting closes, then it's time for the big reveal!",
      organiser: "Teams are picked as usual. The bot will handle the secret roles, sabotage windows, votes and mission checks. An impostor's perfect victory means winning the game, completing their missions and escaping detection.",
    },
  },
} satisfies Record<string, Metadata>;
