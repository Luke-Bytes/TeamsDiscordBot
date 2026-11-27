import type { BallotTally } from "../shared/PrivateBallot";

export type AssignmentResult = "pass" | "fail" | "inconclusive";
export type CoverResult = "hidden" | "exposed" | "inconclusive";
export type VoiceCredit = "fulfilled" | "void";

export function assignmentResult(claimed: number, voice: VoiceCredit): AssignmentResult {
  if (claimed < 4) return "fail";
  return voice === "fulfilled" ? "pass" : "inconclusive";
}

export function coverResult(id: string, tally: BallotTally): CoverResult {
  if (tally.quorum && tally.definite.includes(id)) return "exposed";
  return tally.complete ? "hidden" : "inconclusive";
}

export function teamDeduction(impostors: readonly string[], tally: BallotTally) {
  const exposed = impostors.filter((id) => tally.definite.includes(id)).length;
  return {
    exposed,
    result: !tally.complete ? "inconclusive" :
      exposed === impostors.length ? "full" : exposed > 0 ? "partial" : "none",
  };
}

export function impostorOutcome(won: boolean | null, assignment: AssignmentResult, cover: CoverResult): string {
  if (won === null || assignment === "inconclusive" || cover === "inconclusive")
    return "Outcome inconclusive";
  if (won) {
    if (assignment === "pass")
      return cover === "hidden" ? "Perfect Impostor Victory" : "Won the War, Cover Blown";
    return cover === "hidden" ? "Won the War, Assignment Incomplete" : "Won the War, Exposed";
  }
  if (assignment === "pass")
    return cover === "hidden" ? "Successful Deception (match lost)" : "Missions Complete, Cover Blown";
  return cover === "hidden" ? "Stayed Hidden, Assignment Incomplete" : "Assignment Incomplete, Exposed";
}
