/**
 * The Superset-recorded part of the handoff brief: current git state. This
 * section has priority over statements from the source agent. The input is
 * structural, so the tRPC result satisfies it. Renderer code imports no
 * host-service types.
 */

export interface HandoffSnapshotFile {
	path: string;
	status: string;
	additions: number;
	deletions: number;
}

export interface HandoffWorkspaceGitStatus {
	currentBranch?: { name?: string; lastCommitHash?: string } | null;
	againstBase?: HandoffSnapshotFile[];
	staged?: HandoffSnapshotFile[];
	unstaged?: HandoffSnapshotFile[];
}

/** Staged and unstaged entries replace the against-base entry for the same
 * path. The list then matches the Changes tab. */
function mergeChangedFiles(
	status: HandoffWorkspaceGitStatus,
): HandoffSnapshotFile[] {
	const byPath = new Map<string, HandoffSnapshotFile>();
	for (const file of status.againstBase ?? []) byPath.set(file.path, file);
	for (const file of status.staged ?? []) byPath.set(file.path, file);
	for (const file of status.unstaged ?? []) byPath.set(file.path, file);
	return [...byPath.values()];
}

const MAX_LISTED_FILES = 50;

/**
 * Git path names can contain newlines and other control characters. This
 * section is line-based, so a raw control character can forge extra lines
 * that look like Superset wrote them. Show control characters in escaped
 * form instead.
 */
function renderPath(path: string): string {
	return path
		.replaceAll("\\", "\\\\")
		.replaceAll("\n", "\\n")
		.replaceAll("\r", "\\r")
		.replaceAll("\t", "\\t");
}

export function buildWorkspaceSnapshotSection(
	status: HandoffWorkspaceGitStatus,
): string | null {
	const files = mergeChangedFiles(status);
	const branch = status.currentBranch?.name?.trim() || null;
	const fullHash = status.currentBranch?.lastCommitHash?.trim() || null;
	const head = fullHash ? fullHash.slice(0, 7) : null;
	if (!branch && !head) return null;

	const additions = files.reduce((sum, file) => sum + file.additions, 0);
	const deletions = files.reduce((sum, file) => sum + file.deletions, 0);

	const lines: string[] = [];
	lines.push(
		branch
			? `Branch: ${branch}${head ? ` (HEAD ${head})` : ""}`
			: `HEAD: ${head}`,
	);
	lines.push(
		files.length > 0
			? `Uncommitted changes: ${files.length} ${files.length === 1 ? "file" : "files"} (+${additions} / -${deletions})`
			: "Uncommitted changes: none (clean tree)",
	);
	for (const file of files.slice(0, MAX_LISTED_FILES)) {
		const marker = file.status ? `${file.status[0].toUpperCase()} ` : "";
		lines.push(
			`- ${marker}${renderPath(file.path)} (+${file.additions} / -${file.deletions})`,
		);
	}
	if (files.length > MAX_LISTED_FILES) {
		lines.push(`- …and ${files.length - MAX_LISTED_FILES} more changed files`);
	}
	return lines.join("\n");
}
