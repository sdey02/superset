/**
 * State machine for the agent-written handoff brief. No timers and no I/O
 * live here. `useTerminalHandoffBrief` sends the events and owns the
 * polling. Tests can check every transition without a host.
 */

/** A CLI can hold a new prompt until its current turn finishes. The reply can
 * come much later than the request. This budget gives the reply time. */
export const HANDOFF_BRIEF_BUDGET_MS = 90_000;
export const HANDOFF_BRIEF_POLL_INTERVAL_MS = 2_000;
/** Continue does not wait a long time for a slow brief. This is the most time
 * Continue waits. After this time, Continue uses the transcript prompt. */
export const HANDOFF_CONTINUE_GRACE_MS = 20_000;
/** After this time, a cached attempt is too old. The next dialog open makes a
 * new attempt. */
export const HANDOFF_ATTEMPT_TTL_MS = 5 * 60_000;

export type HandoffBriefStatus =
	| "idle"
	| "preparing"
	| "waiting"
	| "ready"
	| "failed";

export interface HandoffBriefState {
	status: HandoffBriefStatus;
	nonce?: string;
	brief?: string;
	/** The time of the request injection. The budget runs from this time. A
	 * resumed attempt does not get new time. */
	startedAt?: number;
}

export type HandoffBriefEvent =
	| { type: "prepare" }
	| { type: "start"; nonce: string; now: number }
	| { type: "send-failed" }
	| { type: "brief"; brief: string }
	| { type: "timeout"; now: number }
	/** The source agent stopped. No reply will come. */
	| { type: "agent-ended" }
	| { type: "reset" };

/**
 * Ask for a brief only when an agent can answer: the terminal has a live
 * agent binding and a running process. For a bare shell or a stopped agent,
 * use the transcript prompt. Do not write into a terminal that no agent
 * reads.
 */
export function shouldAttemptBrief(input: {
	bindingLive: boolean;
	hasRunningProcess: boolean;
}): boolean {
	return input.bindingLive && input.hasRunningProcess;
}

export function reduceHandoffBrief(
	state: HandoffBriefState,
	event: HandoffBriefEvent,
	now: number,
): HandoffBriefState {
	switch (event.type) {
		case "prepare":
			// Setup runs awaits before the request goes out. No seed is usable
			// in this state, and the dialog keeps Continue disabled.
			return { status: "preparing" };
		case "start":
			return { status: "waiting", nonce: event.nonce, startedAt: event.now };
		case "send-failed":
		case "agent-ended":
			return state.status === "waiting" || state.status === "preparing"
				? { status: "failed" }
				: state;
		case "brief":
			// The first complete reply sets the result. A late reply cannot
			// change a failed or reset attempt.
			if (state.status !== "waiting" || !event.brief.trim()) return state;
			return { ...state, status: "ready", brief: event.brief };
		case "timeout":
			if (state.status !== "waiting") return state;
			return now - (state.startedAt ?? now) >= HANDOFF_BRIEF_BUDGET_MS
				? { status: "failed" }
				: state;
		case "reset":
			return { status: "idle" };
	}
}

export function isBriefAttemptFresh(
	startedAt: number | undefined,
	now: number,
): boolean {
	return startedAt !== undefined && now - startedAt < HANDOFF_ATTEMPT_TTL_MS;
}

/**
 * The user can click Continue during the wait. This gives the deadline: the
 * earlier of the attempt budget and the grace time.
 */
export function briefContinueDeadline(
	state: HandoffBriefState,
	now: number,
): number | null {
	if (state.status !== "waiting" || state.startedAt === undefined) return null;
	return Math.min(
		state.startedAt + HANDOFF_BRIEF_BUDGET_MS,
		now + HANDOFF_CONTINUE_GRACE_MS,
	);
}
