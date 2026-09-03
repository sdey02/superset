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
}): TerminalHandoffBrief {
	const { workspaceId, terminalId, enabled, bindingLive } = input;
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
			const cached = attempts.get(key);
			if (
				bindingLive &&
				cached &&
				!cached.resolved &&
				isBriefAttemptFresh(cached.startedAt, Date.now())
			) {
				// Continue the same attempt: same nonce, original start time.
				dispatch({ type: "start", nonce: cached.nonce, now: cached.startedAt });
			} else {
				let hasRunningProcess = false;
				if (bindingLive) {
					try {
						hasRunningProcess = (
							await trpcUtils.terminal.hasRunningProcess.fetch({
								workspaceId,
								terminalId,
							})
						).running;
					} catch {
						hasRunningProcess = false;
					}
				}
				if (cancelled) return;
				if (!shouldAttemptBrief({ bindingLive, hasRunningProcess })) {
					// No agent can answer. Stay idle. The dialog will use the
					// transcript prompt.
					dispatch({ type: "reset" });
					return;
				}
				const nonce = mintNonce();
				const startedAt = Date.now();
				attempts.set(key, { nonce, startedAt });
				dispatch({ type: "start", nonce, now: startedAt });
				try {
					await sendRequest.mutateAsync({
						workspaceId,
						terminalId,
						text: sanitizePromptForPty(
							buildTerminalHandoffBriefRequestPrompt({ nonce }),
						),
						submit: true,
					});
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
