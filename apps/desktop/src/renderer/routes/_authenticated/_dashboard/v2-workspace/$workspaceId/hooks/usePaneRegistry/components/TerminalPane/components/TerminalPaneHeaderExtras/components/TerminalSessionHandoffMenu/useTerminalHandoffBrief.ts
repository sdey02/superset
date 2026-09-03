import { sanitizePromptForPty } from "@superset/shared/agent-prompt-launch";
import {
	buildTerminalHandoffBriefRequestPrompt,
	extractTerminalHandoffBrief,
	TERMINAL_HANDOFF_BRIEF_CAPTURE_CHARS,
} from "@superset/shared/terminal-session-handoff";
import { workspaceTrpc } from "@superset/workspace-client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	HANDOFF_BRIEF_POLL_INTERVAL_MS,
	HANDOFF_BRIEF_SETUP_TIMEOUT_MS,
	type HandoffBriefEvent,
	type HandoffBriefState,
	isBriefAttemptFresh,
	reduceHandoffBrief,
	shouldAttemptBrief,
} from "./handoffBriefMachine";
import { buildWorkspaceSnapshotSection } from "./handoffWorkspaceSnapshot";

interface HandoffBriefAttempt {
	nonce: string;
	startedAt: number;
	/** The identity of the source binding at injection time. A new agent
	 * session in the same terminal gets a new binding, so an old attempt
	 * never resumes for it. */
	bindingStartedAt: number;
	/** True when the attempt reached an end state. A resolved attempt is never
	 * resumed. The next dialog open makes a new request, so the brief cannot
	 * omit work done after the old reply. */
	resolved?: boolean;
}

/**
 * One attempt for each terminal. This map is module-scoped: when the user
 * closes and re-opens the dialog, the same attempt continues. This prevents
 * a second request into the agent session. The budget runs from the first
 * injection, so a resumed attempt does not get new time. Entries expire when
 * the TTL ends.
 */
const attempts = new Map<string, HandoffBriefAttempt>();

function attemptKey(workspaceId: string, terminalId: string): string {
	return `${workspaceId}:${terminalId}`;
}

function mintNonce(): string {
	return crypto.randomUUID().replaceAll("-", "").slice(0, 8);
}

/** Reject if the underlying promise has not settled within the deadline, so a
 * stalled host request cannot hold the dialog in preparing. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("handoff brief setup timed out")),
			timeoutMs,
		);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

export interface TerminalHandoffBrief {
	briefState: HandoffBriefState;
	/** Git state recorded by Superset for the seed prompt. Null when Superset
	 * cannot read the git state. The prompt works without this section. */
	workspaceSnapshot: string | null;
}

export function useTerminalHandoffBrief(input: {
	workspaceId: string;
	terminalId: string;
	/** True while the handoff dialog is open. */
	enabled: boolean;
	/** True when the source agent binding exists and has not ended. */
	bindingLive: boolean;
	/** `binding.startedAt` for the current binding. A new agent session in the
	 * same terminal changes this value, which ends the cached attempt. */
	bindingStartedAt?: number;
}): TerminalHandoffBrief {
	const { workspaceId, terminalId, enabled, bindingLive, bindingStartedAt } =
		input;
	const trpcUtils = workspaceTrpc.useUtils();
	const sendRequest = workspaceTrpc.terminal.send.useMutation();
	const [briefState, setBriefState] = useState<HandoffBriefState>({
		status: "idle",
	});
	const [workspaceSnapshot, setWorkspaceSnapshot] = useState<string | null>(
		null,
	);
	const stateRef = useRef(briefState);

	const dispatch = useCallback((event: HandoffBriefEvent) => {
		stateRef.current = reduceHandoffBrief(stateRef.current, event, Date.now());
		setBriefState(stateRef.current);
	}, []);

	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;
		let pollTimer: ReturnType<typeof setTimeout> | null = null;
		const stop = () => {
			cancelled = true;
			if (pollTimer) clearTimeout(pollTimer);
		};

		const poll = async (attempt: HandoffBriefAttempt) => {
			if (cancelled) return;
			try {
				const result = await trpcUtils.terminal.transcript.fetch({
					workspaceId,
					terminalId,
					maxChars: TERMINAL_HANDOFF_BRIEF_CAPTURE_CHARS,
				});
				if (cancelled) return;
				const brief = result.text
					? extractTerminalHandoffBrief(result.text, attempt.nonce)
					: null;
				if (brief) {
					// A matched reply is accepted even when this poll runs past
					// the budget. The reply is complete and carries the nonce.
					// Dropping it would only lower the quality of the seed.
					attempt.resolved = true;
					dispatch({ type: "brief", brief });
					return;
				}
			} catch {
				// One failed read does not end the attempt. The budget still
				// limits the wait.
			}
			dispatch({ type: "timeout", now: Date.now() });
			if (cancelled || stateRef.current.status !== "waiting") {
				attempt.resolved = true;
				return;
			}
			pollTimer = setTimeout(
				() => void poll(attempt),
				HANDOFF_BRIEF_POLL_INTERVAL_MS,
			);
		};

		const begin = async () => {
			const key = attemptKey(workspaceId, terminalId);
			// Prune expired entries, so the map stays bounded by terminals with
			// an attempt inside the TTL.
			for (const [entryKey, entry] of attempts) {
				if (!isBriefAttemptFresh(entry.startedAt, Date.now())) {
					attempts.delete(entryKey);
				}
			}
			const cached = attempts.get(key);
			const resumable =
				bindingLive &&
				cached &&
				!cached.resolved &&
				cached.bindingStartedAt === (bindingStartedAt ?? 0) &&
				isBriefAttemptFresh(cached.startedAt, Date.now());
			if (resumable) {
				// Continue the same attempt: same nonce, original start time.
				dispatch({ type: "start", nonce: cached.nonce, now: cached.startedAt });
			} else {
				// Clear any finished state now, before the awaits below. A
				// ready brief from a replaced agent session must not stay
				// launchable while the new attempt is set up. Continue stays
				// disabled while the status is preparing.
				dispatch({ type: "prepare" });
				let hasRunningProcess = false;
				if (bindingLive) {
					try {
						hasRunningProcess = await withTimeout(
							trpcUtils.terminal.hasRunningProcess
								.fetch({
									workspaceId,
									terminalId,
								})
								.then((result) => result.running),
							HANDOFF_BRIEF_SETUP_TIMEOUT_MS,
						);
					} catch {
						// A stalled or failed check counts as no process. The gate
						// below then picks the transcript prompt, so the fallback
						// stays reachable.
						hasRunningProcess = false;
					}
				}
				if (cancelled) return;
				if (!shouldAttemptBrief({ bindingLive, hasRunningProcess })) {
					// No agent can answer. End any cached attempt, so a later
					// dialog open makes a new request. Stay idle. The dialog
					// will use the transcript prompt.
					if (cached) cached.resolved = true;
					dispatch({ type: "reset" });
					return;
				}
				const nonce = mintNonce();
				const startedAt = Date.now();
				attempts.set(key, {
					nonce,
					startedAt,
					bindingStartedAt: bindingStartedAt ?? 0,
				});
				dispatch({ type: "start", nonce, now: startedAt });
				try {
					await withTimeout(
						sendRequest.mutateAsync({
							workspaceId,
							terminalId,
							text: sanitizePromptForPty(
								buildTerminalHandoffBriefRequestPrompt({ nonce }),
							),
							submit: true,
						}),
						HANDOFF_BRIEF_SETUP_TIMEOUT_MS,
					);
				} catch {
					// The send did not complete. Remove this attempt, so a later
					// dialog open makes a new request instead of waiting for a
					// reply that was never requested. Keep entries from newer
					// attempts.
					if (attempts.get(key)?.nonce === nonce) {
						attempts.delete(key);
					}
					if (!cancelled) dispatch({ type: "send-failed" });
					return;
				}
			}
			const attempt = attempts.get(key);
			if (cancelled || !attempt) return;
			void poll(attempt);
		};

		void begin();

		// Read the git snapshot now, in parallel with the brief.
		trpcUtils.git.getStatus
			.fetch({ workspaceId })
			.then((status) => {
				if (!cancelled) {
					setWorkspaceSnapshot(buildWorkspaceSnapshotSection(status));
				}
			})
			.catch(() => {
				if (!cancelled) setWorkspaceSnapshot(null);
			});

		return stop;
	}, [
		enabled,
		bindingLive,
		bindingStartedAt,
		terminalId,
		workspaceId,
		trpcUtils,
		sendRequest.mutateAsync,
		dispatch,
	]);

	// A stopped source agent will not send a reply. End the wait now. The
	// dialog will use the transcript prompt.
	useEffect(() => {
		if (enabled && !bindingLive && stateRef.current.status === "waiting") {
			const attempt = attempts.get(attemptKey(workspaceId, terminalId));
			if (attempt) attempt.resolved = true;
			dispatch({ type: "agent-ended" });
		}
	}, [enabled, bindingLive, dispatch, workspaceId, terminalId]);

	return { briefState, workspaceSnapshot };
}
