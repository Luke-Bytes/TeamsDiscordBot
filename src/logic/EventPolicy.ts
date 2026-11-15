/** Standalone event rules; deliberately independent of game and season state. */
export type EventLifecycle = "DRAFT" | "OPEN" | "CLOSED" | "FINISHED";
export type EventSignupStatus = "CONFIRMED" | "RESERVE" | "WITHDRAWN";

export interface EventAdmissionPolicy {
  state: EventLifecycle;
  capacity: number | null;
  signupDeadline: Date | null;
}

export function regularEventSignupOpen(
  event: EventAdmissionPolicy,
  confirmedCount: number,
  now: Date
): boolean {
  return (
    event.state === "OPEN" &&
    (!event.signupDeadline || now < event.signupDeadline) &&
    (event.capacity === null || confirmedCount < event.capacity)
  );
}

export function eventAdmissionStatus(
  event: EventAdmissionPolicy,
  confirmedCount: number,
  now: Date
): Exclude<EventSignupStatus, "WITHDRAWN"> {
  if (event.state === "DRAFT" || event.state === "FINISHED") {
    throw new Error("This event is not accepting applications.");
  }
  return regularEventSignupOpen(event, confirmedCount, now)
    ? "CONFIRMED"
    : "RESERVE";
}

export interface EventReserve {
  id: string;
  queuedAt: Date;
}

/** Existing reserves take priority over any newly submitted application. */
export function eventReservePromotions(
  event: EventAdmissionPolicy,
  confirmedCount: number,
  reserves: readonly EventReserve[],
  now = new Date(),
  withdrawalPlaces = 0
): string[] {
  if (event.state === "DRAFT" || event.state === "FINISHED") return [];
  const places =
    event.capacity === null
      ? regularEventSignupOpen(event, confirmedCount, now)
        ? reserves.length
        : withdrawalPlaces
      : Math.max(0, event.capacity - confirmedCount);
  return [...reserves]
    .sort(
      (a, b) =>
        a.queuedAt.getTime() - b.queuedAt.getTime() || a.id.localeCompare(b.id)
    )
    .slice(0, places)
    .map((reserve) => reserve.id);
}
