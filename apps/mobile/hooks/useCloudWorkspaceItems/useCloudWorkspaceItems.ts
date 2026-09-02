import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import {
	type CloudWorkspaceRow,
	useCloudWorkspaces,
} from "@/hooks/useCloudWorkspaces";
import {
	getHostWorkspacesQueryKey,
	type HostWorkspaceItem,
	type HostWorkspaceRow,
	type HostWorkspacesCacheOps,
} from "@/hooks/useHostWorkspaces";
import { type SandboxTarget, useSandboxAccess } from "@/hooks/useSandboxAccess";
import { getSandboxAccess } from "@/lib/sandbox-access";

export type CloudWorkspaceStatus = CloudWorkspaceRow["status"];

export interface CloudWorkspaceItem extends HostWorkspaceItem {
	cloud: { status: CloudWorkspaceStatus };
}

/**
 * A cloud row rendered as a list item. The cloud row is the workspace's
 * identity (it is what created, named and lists it) and carries the branch it
 * was created on; the sandbox's own row is only consulted once the workspace
 * is opened (useWorkspaceHost), never from the list — the provider counts
 * every request as activity, so a list that asked each sandbox for its row
 * kept all of them awake for as long as Home was on screen.
 *
 * Two fields are invented, and both are load bearing only in what they
 * prevent: `worktreeExists: true` keeps the list from filtering the row as a
 * stale shell, and `worktreePath: ""` satisfies the shape — nothing reads a
 * path off a list row (the workspace screen's attachment target uses the
 * served row, which has the real one). `type` is not invented: the sandbox
 * self-seeds its workspace as `main`. `hostReachable` is false because the
 * list never asks; row decoration that needs the host (diff stats) waits for
 * the workspace to be opened.
 */
function itemFromCloudRow(cloud: CloudWorkspaceRow): CloudWorkspaceItem {
	return {
		id: cloud.id,
		organizationId: cloud.organizationId,
		// Cloud workspaces have no project; the row shape still wants one.
		projectId: "",
		hostId: cloud.id,
		name: cloud.name,
		branch: cloud.branch,
		type: "main",
		createdByUserId: cloud.createdByUserId ?? null,
		taskId: null,
		tags: [],
		createdAt: cloud.createdAt,
		updatedAt: cloud.updatedAt,
		worktreePath: "",
		worktreeExists: true,
		projectName: null,
		archivedAt: null,
		archiveReason: null,
		hostReachable: false,
		cloud: { status: cloud.status },
	};
}

export interface CloudWorkspaceItemsValue {
	items: CloudWorkspaceItem[];
	targets: SandboxTarget[];
	cache: HostWorkspacesCacheOps;
	/** True once the cloud list answered and every ready sandbox was addressed. */
	isReady: boolean;
}

/**
 * Cloud workspaces as home-list rows, from the cloud list alone. Addresses
 * are still brokered for every ready sandbox (that talks to the API, not the
 * sandbox) so opening a row resolves its host at once.
 */
export function useCloudWorkspaceItems(): CloudWorkspaceItemsValue {
	const queryClient = useQueryClient();
	const { workspaces: cloudRows, isReady: listReady } = useCloudWorkspaces();
	const { targets, isReady: accessReady } = useSandboxAccess(cloudRows);

	const items = useMemo<CloudWorkspaceItem[]>(
		() => cloudRows.map((cloud) => itemFromCloudRow(cloud)),
		[cloudRows],
	);

	const cache = useMemo<HostWorkspacesCacheOps>(() => {
		const keyFor = (hostId: string) => {
			const access = getSandboxAccess(hostId);
			return access ? getHostWorkspacesQueryKey(hostId, access.url) : null;
		};
		return {
			resolveHostUrl: (hostId) => getSandboxAccess(hostId)?.url ?? null,
			upsertWorkspace: (row) => {
				const key = keyFor(row.hostId);
				if (!key) return;
				queryClient.setQueryData<HostWorkspaceRow[] | undefined>(
					key,
					(rows) => {
						if (!rows) return [row];
						const exists = rows.some((existing) => existing.id === row.id);
						return exists
							? rows.map((existing) =>
									existing.id === row.id ? { ...existing, ...row } : existing,
								)
							: [...rows, row];
					},
				);
			},
			invalidateHost: (hostId) => {
				const key = keyFor(hostId);
				if (key) void queryClient.invalidateQueries({ queryKey: key });
			},
		};
	}, [queryClient]);

	return {
		items,
		targets,
		cache,
		isReady: listReady && accessReady,
	};
}
