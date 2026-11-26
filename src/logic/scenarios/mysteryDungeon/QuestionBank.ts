import { randomInt } from "node:crypto";

export const archetypes = ["Guardian", "Pathfinder", "Strategist", "Vanguard"] as const;
export type Archetype = typeof archetypes[number] | "Unclassified";
type ScoredAnswer = readonly [label: string, archetype: typeof archetypes[number]];
export interface Question {
  title: string;
  answers: readonly ScoredAnswer[];
}
const G = "Guardian", P = "Pathfinder", S = "Strategist", V = "Vanguard";

export const questions = {
  bucket: { title: "How much water would you put in an empty bucket?", answers: [["Right to the brim", V], ["Halfway", S], ["Just a splash", G]] },
  present: { title: "You've received a mysterious present. What do you do?", answers: [["Open it immediately!", P], ["Shake it and try to guess what's inside", S], ["Save it for later", G], ["Ask everyone to guess with me", V]] },
  exam: { title: "How do you prepare for an upcoming exam?", answers: [["Make a revision timetable", S], ["Study with friends", V], ["Cram the night before", P], ["Get a good night's sleep", G]] },
  balloon: { title: "How much would you inflate a balloon?", answers: [["Until it's about to pop", P], ["Just enough to look round", S], ["Only a little - I hate loud bangs", G]] },
  fortune: { title: "A fortune teller predicts bad luck for you. What do you do?", answers: [["Carry on as normal", P], ["Take extra precautions", G], ["Ask for more details", S], ["Tell my friends and laugh about it", V]] },
  switch: { title: "You see an unexplained switch. Do you want to activate it?", answers: [["Yes!", P], ["No, leave it alone", G]] },
  karaoke: { title: "Do you enjoy karaoke?", answers: [["Yes - give me the microphone!", V], ["No - I'll cheer everyone else on", G]] },
  trail: { title: "A mountain trail splits into two paths. Which do you take?", answers: [["The narrow, mysterious path", P], ["The wide, well-marked path", S]] },
  pizza: { title: "What pizza would you choose?", answers: [["Margherita", G], ["Pepperoni", V], ["Hawaiian", P], ["Build my own", S]] },
  season: { title: "What's your favourite season?", answers: [["Spring", P], ["Summer", V], ["Autumn", S], ["Winter", G]] },
  ocean: { title: "What colour would you paint the ocean?", answers: [["Turquoise", P], ["Deep blue", G], ["Sunset orange", V], ["Emerald green", S]] },
  wizard: { title: "A mysterious wizard offers you a completely useless superpower. Which do you choose?", answers: [["Always know when food is ready", G], ["Communicate with chickens", P], ["Teleport exactly one centimetre", S], ["Dramatic music whenever I enter a room", V]] },
  button: { title: 'You find a button labelled "DO NOT PRESS". What do you do?', answers: [["Press it immediately", P], ["Convince someone else to press it", V], ["Investigate what it's connected to", S], ['Add a sign saying "SERIOUSLY"', G]] },
  wingstop: { title: "You're ordering Wingstop, which wings do you choose?", answers: [["Lemon Pepper", G], ["Louisiana Rub", S], ["Mango Habanero", V], ["A flavour I've never tried", P]] },
  beer: { title: "How much beer is appropriate to have when playing Anni?", answers: [["None - soft drinks for me", G], ["Just a little one", S], ["10", P]] },
  fluffiest: { title: "Who is the fluffiest of them all?", answers: [["Pawda!", V], ["Baby llama", G], ["Boris", S], ["Me, obviously", P]] },
  voidSwap: { title: "You just got void swapped when you were just about to go rush, what do you do?", answers: [["Go boss", V], ["Leave game", G], ["Re-gear", S], ["Leather Scout", P]] },
  voting: { title: "You join a voting that's about to start, what do you plan to do?", answers: [["Invis Handy", P], ["Gear up and minerush", V], ["Get fortune", S], ["Scout spam", G]] },
  mid: { title: "You're prot12 with fortune going mid, which loadout do you take?", answers: [["Speed 2 and regen", P], ["Gap", G]] },
  rushClass: { title: "What class you rushing with as p12 dia, no gap?", answers: [["Thor", V], ["Farmer", S], ["Vampire", G], ["Scout", P]] },
  midClass: { title: "What class you going to mid with as p12 iron with fortune?", answers: [["TP", S], ["Das", V], ["Suc", G], ["Wizard", P]] },
  shortVideos: { title: "TikTok, Shorts or Reels?", answers: [["TikTok", P], ["Shorts", S], ["Reels", V]] },
  stairs: { title: "You're defending on stairs, what do you do?", answers: [["Doomscroll your phone", P], ["Actively defend", G]] },
  pingu: { title: "You're about to invis rush a team then see Pingu returning to the base, what do you do?", answers: [["Go to a different team", P], ["Walk by him, he's blind", V], ["Wait patiently, he probably won't find me", S]] },
  starter: { title: "What starter type do you pick?", answers: [["Fire", V], ["Water", S], ["Grass", G]] },
} as const satisfies Record<string, Question>;

export type QuestionId = keyof typeof questions;
export const QUESTION_COUNT = 5;

// Sample without replacement. Persist the selected IDs, not the shuffled array index.
export function selectQuestions(rng: (max: number) => number = randomInt): QuestionId[] {
  const pool = Object.keys(questions) as QuestionId[];
  const selected: QuestionId[] = [];
  for (let i = 0; i < QUESTION_COUNT; i++) {
    selected.push(pool.splice(rng(pool.length), 1)[0]);
  }
  return selected;
}

// Old recovery snapshots have answer indices but no question IDs. Preserve their
// original questions and scoring rather than interpreting them as new answers.
export const legacyQuestions: readonly Question[] = [
  { title: "Your Nexus is under attack, but diamonds have appeared. What do you do?", answers: [["Return and defend", G], ["Scout a flanking route", P], ["Check whether defence can hold", S], ["Rally a counter-push", V]] },
  { title: "Five minutes before the first big fight…", answers: [["Reinforce our defences", G], ["Explore overlooked routes", P], ["Prepare efficient gear", S], ["Organise an attack plan", V]] },
  { title: "The first rush fails. You…", answers: [["Cover the retreat", G], ["Find a new way in", P], ["Analyse what went wrong", S], ["Regroup the team", V]] },
  { title: "Your favourite match moment?", answers: [["Saving the Nexus", G], ["Pulling off a surprise", P], ["A plan coming together", S], ["A coordinated team win", V]] },
  { title: "A new player asks for help. You…", answers: [["Keep them safe", G], ["Show useful shortcuts", P], ["Explain a gear plan", S], ["Invite them on an objective", V]] },
];
