export interface ToolsetPopoverOpening {
  /** Captured before async work and retained on startup replays for click-away ordering. */
  openedAt?: number;
  /** Originating opener's sequence, so equal timestamps still identify distinct opens. */
  generation?: number;
}

export type ToolsetPopoverOpeningTarget = ToolsetPopoverOpening & { toolsetId: string };

export interface ToolsetPopoverDismissPayload {
  /** Captured synchronously at the originating press, before any asynchronous IPC. */
  requestedAt: number;
  reason?: "escape";
  /** A visibility reply only authorizes dismissal of the openings that were checked. */
  openings?: ToolsetPopoverOpeningTarget[];
}

/** The identity accepted by the popover. Pickers and E/Z have no general keyboard route. */
export interface AcceptedToolsetPopoverOpening extends ToolsetPopoverOpeningTarget {
  openedAt: number;
  flyoutId?: string;
}

export interface ToolsetFlyoutClosedNotice extends AcceptedToolsetPopoverOpening {
  flyoutId: string;
  /** A renderer close with no generation identifies the timestamp-only opening exactly. */
  exactOpening?: true;
}

interface OpeningState {
  latest: ReadonlyMap<string, AcceptedToolsetPopoverOpening>;
  closed: ReadonlyMap<string, ToolsetPopoverOpening>;
  dismissedAt: number;
}

export function newFlyoutOpeningState(): OpeningState {
  return { latest: new Map(), closed: new Map(), dismissedAt: -Infinity };
}

export function compareToolsetPopoverOpenings(a: ToolsetPopoverOpening, b: ToolsetPopoverOpening): number {
  return (a.openedAt ?? 0) - (b.openedAt ?? 0) || (a.generation ?? 0) - (b.generation ?? 0);
}

export function matchesToolsetPopoverOpening(a: ToolsetPopoverOpening, b: ToolsetPopoverOpening): boolean {
  return a.openedAt === b.openedAt && a.generation === b.generation;
}

/** Only the receiving popover supplies a missing timestamp and allocates a generation.
 * Two unstamped pushes in one clock tick still get distinct identities. */
export function resolveFlyoutOpening(state: OpeningState, opening: ToolsetPopoverOpeningTarget, receivedAt: number) {
  const { toolsetId, openedAt, generation } = opening;
  const latest = state.latest.get(toolsetId);
  const closed = state.closed.get(toolsetId);
  return {
    openedAt: openedAt ?? receivedAt,
    generation: openedAt === undefined && generation === undefined
      ? 1 + Math.max(latest?.generation ?? 0, closed?.generation ?? 0)
      : generation
  };
}

export function wasFlyoutOpeningDismissed(state: OpeningState, openedAt: number): boolean {
  return openedAt <= state.dismissedAt;
}

function isClosed(state: OpeningState, opening: AcceptedToolsetPopoverOpening): boolean {
  const closed = state.closed.get(opening.toolsetId);
  return wasFlyoutOpeningDismissed(state, opening.openedAt) ||
    (closed !== undefined && compareToolsetPopoverOpenings(opening, closed) <= 0);
}

export function acceptFlyoutOpening(state: OpeningState, opening: AcceptedToolsetPopoverOpening): OpeningState {
  const previous = state.latest.get(opening.toolsetId);
  if (isClosed(state, opening) || (previous && compareToolsetPopoverOpenings(opening, previous) <= 0)) return state;
  const latest = new Map(state.latest);
  latest.delete(opening.toolsetId);
  latest.set(opening.toolsetId, opening);
  return { ...state, latest };
}

export function currentFlyoutOpening(state: OpeningState, toolsetId: string): AcceptedToolsetPopoverOpening | undefined {
  const opening = state.latest.get(toolsetId);
  return opening && !isClosed(state, opening) ? opening : undefined;
}

export function latestLiveFlyoutOpening(state: OpeningState): AcceptedToolsetPopoverOpening | undefined {
  let latest: AcceptedToolsetPopoverOpening | undefined;
  for (const opening of state.latest.values()) {
    // Generations belong to one toolset. Equal timestamps across toolsets follow delivery order.
    if (!isClosed(state, opening) && (!latest || opening.openedAt >= latest.openedAt)) latest = opening;
  }
  return latest;
}

export function closeFlyoutOpening(state: OpeningState, target: ToolsetPopoverOpeningTarget): OpeningState {
  const previous = state.closed.get(target.toolsetId);
  if (previous && compareToolsetPopoverOpenings(target, previous) <= 0) return state;
  return { ...state, closed: new Map(state.closed).set(target.toolsetId, target) };
}

export function closeFlyoutMenu(state: OpeningState, notice: ToolsetFlyoutClosedNotice): OpeningState {
  const current = currentFlyoutOpening(state, notice.toolsetId);
  // A legacy notice cannot identify a generation, even when the timestamp and menu match.
  if (!notice.exactOpening && notice.generation === undefined && current?.generation !== undefined) return state;
  return closeFlyoutOpening(state, notice);
}

export function dismissFlyoutOpenings(state: OpeningState, payload?: ToolsetPopoverDismissPayload): OpeningState {
  if (payload?.openings) return payload.openings.reduce(closeFlyoutOpening, state);
  if (payload?.requestedAt !== undefined) {
    return { ...state, dismissedAt: Math.max(state.dismissedAt, payload.requestedAt) };
  }
  // Without a press timestamp, only already accepted openings can be closed.
  return [...state.latest.values()].reduce(closeFlyoutOpening, state);
}
