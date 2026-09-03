import { describe, expect, it } from "bun:test";
import {
	briefContinueDeadline,
	HANDOFF_ATTEMPT_TTL_MS,
	HANDOFF_BRIEF_BUDGET_MS,
	HANDOFF_CONTINUE_GRACE_MS,
	isBriefAttemptFresh,
	reduceHandoffBrief,
	shouldAttemptBrief,
} from "./handoffBriefMachine";

describe("shouldAttemptBrief", () => {
	it("attempts only for a live agent with a running process", () => {
		expect(
			shouldAttemptBrief({ bindingLive: true, hasRunningProcess: true }),
		).toBe(true);
		expect(
			shouldAttemptBrief({ bindingLive: false, hasRunningProcess: true }),
		).toBe(false);
		expect(
			shouldAttemptBrief({ bindingLive: true, hasRunningProcess: false }),
		).toBe(false);
	});
});

describe("reduceHandoffBrief", () => {
	const start = { type: "start", nonce: "abcd1234", now: 1_000 } as const;

	it("moves idle → waiting on start and records the injection time", () => {
		expect(reduceHandoffBrief({ status: "idle" }, start, 1_000)).toEqual({
			status: "waiting",
			nonce: "abcd1234",
			startedAt: 1_000,
		});
	});

	it("transitions to failed when the send fails or the agent ends", () => {
		const waiting = reduceHandoffBrief({ status: "idle" }, start, 1_000);
		expect(
			reduceHandoffBrief(waiting, { type: "send-failed" }, 2_000).status,
		).toBe("failed");
		expect(
			reduceHandoffBrief(waiting, { type: "agent-ended" }, 2_000).status,
		).toBe("failed");
	});

	it("times out only after the budget measured from injection", () => {
		const waiting = reduceHandoffBrief({ status: "idle" }, start, 1_000);
		expect(
			reduceHandoffBrief(
				waiting,
				{ type: "timeout", now: 1_000 + HANDOFF_BRIEF_BUDGET_MS - 1 },
				1_000 + HANDOFF_BRIEF_BUDGET_MS - 1,
			).status,
		).toBe("waiting");
		expect(
			reduceHandoffBrief(
				waiting,
				{ type: "timeout", now: 1_000 + HANDOFF_BRIEF_BUDGET_MS },
				1_000 + HANDOFF_BRIEF_BUDGET_MS,
			).status,
		).toBe("failed");
	});

	it("accepts the first brief and keeps the attempt's identity", () => {
		const waiting = reduceHandoffBrief({ status: "idle" }, start, 1_000);
		expect(
			reduceHandoffBrief(waiting, { type: "brief", brief: "the brief" }, 2_000),
		).toEqual({
			status: "ready",
			nonce: "abcd1234",
			startedAt: 1_000,
			brief: "the brief",
		});
	});

	it("ignores blank and late briefs", () => {
		const waiting = reduceHandoffBrief({ status: "idle" }, start, 1_000);
		expect(
			reduceHandoffBrief(waiting, { type: "brief", brief: "  \n" }, 2_000)
				.status,
		).toBe("waiting");
		const ready = reduceHandoffBrief(
			waiting,
			{ type: "brief", brief: "one" },
			2_000,
		);
		expect(
			reduceHandoffBrief(ready, { type: "brief", brief: "two" }, 3_000).brief,
		).toBe("one");
		const failed = reduceHandoffBrief(waiting, { type: "agent-ended" }, 2_000);
		expect(
			reduceHandoffBrief(failed, { type: "brief", brief: "late" }, 3_000)
				.status,
		).toBe("failed");
	});

	it("resets to idle from any state", () => {
		for (const status of ["waiting", "ready", "failed"] as const) {
			expect(reduceHandoffBrief({ status }, { type: "reset" }, 0).status).toBe(
				"idle",
			);
		}
	});
});

describe("isBriefAttemptFresh", () => {
	it("expires attempts past the TTL", () => {
		expect(isBriefAttemptFresh(1_000, 1_000 + HANDOFF_ATTEMPT_TTL_MS - 1)).toBe(
			true,
		);
		expect(isBriefAttemptFresh(1_000, 1_000 + HANDOFF_ATTEMPT_TTL_MS)).toBe(
			false,
		);
		expect(isBriefAttemptFresh(undefined, 1_000)).toBe(false);
	});
});

describe("briefContinueDeadline", () => {
	it("caps the wait at the earlier of budget and grace", () => {
		const waiting = {
			status: "waiting",
			nonce: "abcd1234",
			startedAt: 1_000,
		} as const;
		// Budget still far out: the user's grace wins.
		expect(briefContinueDeadline(waiting, 2_000)).toBe(
			2_000 + HANDOFF_CONTINUE_GRACE_MS,
		);
		// Budget about to expire: it wins over a full grace window.
		const late = briefContinueDeadline(
			waiting,
			1_000 + HANDOFF_BRIEF_BUDGET_MS - 5_000,
		);
		expect(late).toBe(1_000 + HANDOFF_BRIEF_BUDGET_MS);
		expect(late).toBeLessThan(
			1_000 + HANDOFF_BRIEF_BUDGET_MS - 5_000 + HANDOFF_CONTINUE_GRACE_MS,
		);
	});

	it("is null outside waiting", () => {
		expect(
			briefContinueDeadline({ status: "ready", brief: "x" }, 0),
		).toBeNull();
		expect(briefContinueDeadline({ status: "idle" }, 0)).toBeNull();
	});
});
