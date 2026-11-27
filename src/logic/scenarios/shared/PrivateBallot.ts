/** Frozen electorate, private replaceable ballots, deterministic cutoff ties. */
export interface BallotTally {
  quorum: boolean;
  positiveBallots: number;
  definite: string[];
  unresolvedSeats: number;
  complete: boolean;
  counts: ReadonlyMap<string, number>;
}

export class PrivateBallot {
  private readonly voters: Set<string>;
  private readonly candidates: Set<string>;
  private readonly responses = new Map<string, string[]>();
  private locked = false;

  constructor(
    voters: readonly string[],
    candidates: readonly string[],
    readonly seats: number,
    private readonly allowSelf = false
  ) {
    this.voters = new Set(voters);
    this.candidates = new Set(candidates);
    if (this.voters.size !== voters.length || this.candidates.size !== candidates.length ||
        !Number.isSafeInteger(seats) || seats < 1 || seats > candidates.length)
      throw new Error("Invalid ballot configuration.");
  }

  choicesFor(voter: string): string[] {
    if (!this.voters.has(voter)) throw new Error("Ballot unavailable.");
    return [...this.candidates].filter((id) => this.allowSelf || id !== voter);
  }

  submit(voter: string, choices: readonly string[]): void {
    if (this.locked || !this.voters.has(voter) || choices.length > this.seats ||
        new Set(choices).size !== choices.length ||
        choices.some((id) => !this.candidates.has(id) || (!this.allowSelf && id === voter)))
      throw new Error("Ballot unavailable or invalid.");
    this.responses.set(voter, [...choices]);
  }

  ownResponse(voter: string): string[] | undefined {
    if (!this.voters.has(voter)) throw new Error("Ballot unavailable.");
    const response = this.responses.get(voter);
    return response && [...response];
  }

  lock(): BallotTally {
    this.locked = true;
    const counts = new Map<string, number>();
    let positiveBallots = 0;
    for (const choices of this.responses.values()) {
      if (choices.length) positiveBallots++;
      for (const id of choices) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const quorum = positiveBallots > this.voters.size / 2;
    const definite: string[] = [];
    if (quorum) {
      const ranked = [...counts].sort((a, b) => b[1] - a[1]);
      for (let i = 0; i < ranked.length && definite.length < this.seats;) {
        const score = ranked[i][1];
        const tied: string[] = [];
        while (i < ranked.length && ranked[i][1] === score) tied.push(ranked[i++][0]);
        if (tied.length > this.seats - definite.length) break;
        definite.push(...tied.sort());
      }
    }
    return {
      quorum, positiveBallots, definite, unresolvedSeats: this.seats - definite.length,
      complete: quorum && definite.length === this.seats, counts,
    };
  }

  /** Clear private data after awards have been computed. */
  discardResponses(): void {
    this.locked = true;
    this.responses.clear();
  }
}
