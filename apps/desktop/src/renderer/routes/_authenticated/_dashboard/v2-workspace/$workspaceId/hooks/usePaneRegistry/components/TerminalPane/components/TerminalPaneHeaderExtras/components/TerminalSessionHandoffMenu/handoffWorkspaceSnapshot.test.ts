import { describe, expect, it } from "bun:test";
import { buildWorkspaceSnapshotSection } from "./handoffWorkspaceSnapshot";

describe("buildWorkspaceSnapshotSection", () => {
	it("renders branch, head, and changed files", () => {
		const section = buildWorkspaceSnapshotSection({
			currentBranch: { name: "main", lastCommitHash: "abcdef1234567890" },
			againstBase: [
				{ path: "src/a.ts", status: "modified", additions: 10, deletions: 2 },
			],
		});
		expect(section).toContain("Branch: main (HEAD abcdef1)");
		expect(section).toContain("Uncommitted changes: 1 file (+10 / -2)");
		expect(section).toContain("- M src/a.ts (+10 / -2)");
	});

	it("escapes control characters in path names", () => {
		const section = buildWorkspaceSnapshotSection({
			currentBranch: { name: "main" },
			unstaged: [
				{
					path: "we\nird\tpath.ts",
					status: "added",
					additions: 1,
					deletions: 0,
				},
			],
		});
		expect(section).toContain("- A we\\nird\\tpath.ts (+1 / -0)");
		// The escaped path stays on one line, so it cannot forge snapshot rows.
		expect(section?.split("\n")).toHaveLength(3);
	});

	it("returns null without branch or head", () => {
		expect(buildWorkspaceSnapshotSection({})).toBeNull();
	});
});
