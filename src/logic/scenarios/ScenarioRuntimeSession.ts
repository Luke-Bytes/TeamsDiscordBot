import type { ScenarioPrivatePrompt, ScenarioValue } from "./ScenarioTypes";

/** Optional capability: preparation remains completed; live/post-game actions have their own guards. */
export interface ScenarioRuntimeSession {
  readonly token: string;
  prepare(): void;
  startBlock(): string | null;
  beforeStart(): Promise<void>;
  startFailed(): Promise<void>;
  started(): Promise<void>;
  winnerReported(): Promise<void>;
  end(continueOrdinaryEnd: () => Promise<void>): Promise<void>;
  open(actorId: string): ScenarioPrivatePrompt | null;
  apply(customId: string, actorId: string, value: ScenarioValue): ScenarioPrivatePrompt;
  delivered(actorId: string): void;
  rosterChanged(): Promise<void>;
  invalidate(): void;
  abort(): Promise<void>;
  preserveModeration?(memberId: string): Promise<void>;
  confirmManualCleanup(): void;
  shutdownBlock(): string | null;
  summary(): string;
  publicResult(): ScenarioValue | null;
}
