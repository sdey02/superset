import { db } from "@superset/db/client";
import {
	githubInstallations,
	githubPullRequests,
	githubRepositories,
} from "@superset/db/schema";
import type { TRPCRouterRecord } from "@trpc/server";
import { Client } from "@upstash/qstash";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { env } from "../../../env";
import { protectedProcedure, userError } from "../../../trpc";
import { verifyOrgAdmin, verifyOrgMembership } from "../utils";
import { listGithubRepositories } from "./trigger-options";

const qstash = new Client({ token: env.QSTASH_TOKEN });

export const githubRouter = {
	getInstallation: protectedProcedure
		.input(z.object({ organizationId: z.string().uuid() }))
		.query(async ({ ctx, input }) => {
			await verifyOrgMembership(ctx.session.user.id, input.organizationId);

			const installation = await db.query.githubInstallations.findFirst({
				where: eq(githubInstallations.organizationId, input.organizationId),
				columns: {
					id: true,
					accountLogin: true,
					accountType: true,
					suspended: true,
					lastSyncedAt: true,
					createdAt: true,
				},
			});

			return installation ?? null;
		}),

	disconnect: protectedProcedure
		.input(z.object({ organizationId: z.string().uuid() }))
		.mutation(async ({ ctx, input }) => {
			await verifyOrgAdmin(ctx.session.user.id, input.organizationId);

			const result = await db
				.delete(githubInstallations)
				.where(eq(githubInstallations.organizationId, input.organizationId))
				.returning({ id: githubInstallations.id });

			if (result.length === 0) {
				return { success: false, error: "No installation found" };
			}

			return { success: true };
		}),

	triggerSync: protectedProcedure
		.input(z.object({ organizationId: z.string().uuid() }))
		.mutation(async ({ ctx, input }) => {
			await verifyOrgMembership(ctx.session.user.id, input.organizationId);

			const installation = await db.query.githubInstallations.findFirst({
				where: eq(githubInstallations.organizationId, input.organizationId),
				columns: { id: true },
			});

			if (!installation) {
				throw userError({
					code: "NOT_FOUND",
					message: "GitHub installation not found",
					i18nKey: "serverError.integration.githubInstallationNotFound",
				});
			}

			const syncUrl = `${env.NEXT_PUBLIC_API_URL}/api/github/jobs/initial-sync`;
			const syncBody = {
				installationDbId: installation.id,
				organizationId: input.organizationId,
			};

			// In development, call the sync endpoint directly (QStash can't reach localhost)
			if (env.NODE_ENV === "development") {
				fetch(syncUrl, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(syncBody),
				}).catch((error) => {
					console.error("[github/triggerSync] Dev sync failed:", error);
				});
			} else {
				await qstash.publishJSON({
					url: syncUrl,
					body: syncBody,
					retries: 3,
				});
			}

			return { success: true };
		}),

	listRepositories: protectedProcedure
		.input(z.object({ organizationId: z.string().uuid() }))
		.query(async ({ ctx, input }) => {
			await verifyOrgMembership(ctx.session.user.id, input.organizationId);
			return listGithubRepositories(input.organizationId);
		}),

	listPullRequests: protectedProcedure
		.input(
			z.object({
				organizationId: z.string().uuid(),
				repositoryId: z.string().uuid().optional(),
				state: z.enum(["open", "closed", "all"]).optional().default("open"),
			}),
		)
		.query(async ({ ctx, input }) => {
			await verifyOrgMembership(ctx.session.user.id, input.organizationId);

			const installation = await db.query.githubInstallations.findFirst({
				where: eq(githubInstallations.organizationId, input.organizationId),
				columns: { id: true },
			});

			if (!installation) {
				return [];
			}

			// Get repository IDs for this installation
			const repos = await db.query.githubRepositories.findMany({
				where: input.repositoryId
					? and(
							eq(githubRepositories.installationId, installation.id),
							eq(githubRepositories.id, input.repositoryId),
						)
					: eq(githubRepositories.installationId, installation.id),
				columns: { id: true },
			});

			if (repos.length === 0) {
				return [];
			}

			const repoIds = repos.map((r) => r.id);

			// Build query conditions
			const conditions = [];
			if (repoIds.length > 0) {
				conditions.push(inArray(githubPullRequests.repositoryId, repoIds));
			}

			if (input.state !== "all") {
				conditions.push(eq(githubPullRequests.state, input.state));
			}

			return db.query.githubPullRequests.findMany({
				where: conditions.length > 0 ? and(...conditions) : undefined,
				with: {
					repository: {
						columns: {
							id: true,
							fullName: true,
							owner: true,
							name: true,
						},
					},
				},
				orderBy: [desc(githubPullRequests.updatedAt)],
				limit: 100,
			});
		}),

	listOrganizationPullRequests: protectedProcedure
		.input(z.object({ organizationId: z.string().uuid() }))
		.query(async ({ ctx, input }) => {
			await verifyOrgMembership(ctx.session.user.id, input.organizationId);

			return db.query.githubPullRequests.findMany({
				where: eq(githubPullRequests.organizationId, input.organizationId),
				orderBy: [desc(githubPullRequests.updatedAt)],
				limit: 100,
			});
		}),

	/**
	 * The pull request to show for each (repository, head branch) pair — what
	 * a sidebar row needs and nothing more. One PR per ref: an open one wins,
	 * otherwise the most recently updated. Repositories are matched by full
	 * name within the organization's installation, so a ref for a repository
	 * the App is not installed on simply has no entry.
	 *
	 * `hasInstallation` lets a client that has its own PR source (a host it
	 * can reach) decide whether to fall back to it.
	 */
	getByBranches: protectedProcedure
		.input(
			z.object({
				organizationId: z.string().uuid(),
				refs: z
					.array(
						z.object({
							repoFullName: z.string().min(1),
							headBranch: z.string().min(1),
						}),
					)
					.max(500),
			}),
		)
		.query(async ({ ctx, input }) => {
			await verifyOrgMembership(ctx.session.user.id, input.organizationId);

			const installation = await db.query.githubInstallations.findFirst({
				where: eq(githubInstallations.organizationId, input.organizationId),
				columns: { id: true },
			});
			if (!installation) {
				return { hasInstallation: false, pullRequests: [] };
			}
			if (input.refs.length === 0) {
				return { hasInstallation: true, pullRequests: [] };
			}

			const repos = await db.query.githubRepositories.findMany({
				where: eq(githubRepositories.installationId, installation.id),
				columns: { id: true, fullName: true, defaultBranch: true },
			});
			const repoByFullName = new Map(
				repos.map((repo) => [repo.fullName.toLowerCase(), repo]),
			);
			const fullNameByRepoId = new Map(
				repos.map((repo) => [repo.id, repo.fullName]),
			);

			const wanted = new Set<string>();
			const repoIds = new Set<string>();
			const branches = new Set<string>();
			for (const ref of input.refs) {
				const repo = repoByFullName.get(ref.repoFullName.toLowerCase());
				if (!repo) continue;
				// The table records a PR's head branch but not the repository it
				// lives in, so a fork's `main` is indistinguishable from this one's.
				// A checkout of the default branch has no PR of its own, and would
				// otherwise pick up whichever fork last opened one from theirs.
				if (ref.headBranch === repo.defaultBranch) continue;
				wanted.add(`${repo.id}\n${ref.headBranch}`);
				repoIds.add(repo.id);
				branches.add(ref.headBranch);
			}
			if (wanted.size === 0) {
				return { hasInstallation: true, pullRequests: [] };
			}

			const rows = await db
				.select({
					repositoryId: githubPullRequests.repositoryId,
					headBranch: githubPullRequests.headBranch,
					number: githubPullRequests.prNumber,
					url: githubPullRequests.url,
					title: githubPullRequests.title,
					state: githubPullRequests.state,
					isDraft: githubPullRequests.isDraft,
					reviewDecision: githubPullRequests.reviewDecision,
					checksStatus: githubPullRequests.checksStatus,
					checks: githubPullRequests.checks,
					mergedAt: githubPullRequests.mergedAt,
					updatedAt: githubPullRequests.updatedAt,
				})
				.from(githubPullRequests)
				.where(
					and(
						eq(githubPullRequests.organizationId, input.organizationId),
						inArray(githubPullRequests.repositoryId, [...repoIds]),
						inArray(githubPullRequests.headBranch, [...branches]),
					),
				)
				.orderBy(desc(githubPullRequests.updatedAt))
				.limit(2_000);

			// Rows arrive newest first, so the first open PR per ref is the newest
			// open one, and the first row of any state is the newest overall.
			const bestByRef = new Map<string, (typeof rows)[number]>();
			for (const row of rows) {
				const key = `${row.repositoryId}\n${row.headBranch}`;
				if (!wanted.has(key)) continue;
				const existing = bestByRef.get(key);
				if (!existing || (existing.state !== "open" && row.state === "open")) {
					bestByRef.set(key, row);
				}
			}

			return {
				hasInstallation: true,
				pullRequests: [...bestByRef.values()].map((row) => ({
					repoFullName: fullNameByRepoId.get(row.repositoryId) ?? "",
					headBranch: row.headBranch,
					number: row.number,
					url: row.url,
					title: row.title,
					state: row.state,
					isDraft: row.isDraft,
					reviewDecision: row.reviewDecision,
					checksStatus: row.checksStatus,
					checks: row.checks ?? [],
					mergedAt: row.mergedAt,
					updatedAt: row.updatedAt,
				})),
			};
		}),

	getStats: protectedProcedure
		.input(z.object({ organizationId: z.string().uuid() }))
		.query(async ({ ctx, input }) => {
			await verifyOrgMembership(ctx.session.user.id, input.organizationId);

			const installation = await db.query.githubInstallations.findFirst({
				where: eq(githubInstallations.organizationId, input.organizationId),
				columns: { id: true },
			});

			if (!installation) {
				return {
					repositoryCount: 0,
					openPullRequestCount: 0,
					pendingChecksCount: 0,
					failedChecksCount: 0,
				};
			}

			const repos = await db.query.githubRepositories.findMany({
				where: eq(githubRepositories.installationId, installation.id),
				columns: { id: true },
			});

			if (repos.length === 0) {
				return {
					repositoryCount: 0,
					openPullRequestCount: 0,
					pendingChecksCount: 0,
					failedChecksCount: 0,
				};
			}

			const repoIds = repos.map((r) => r.id);

			// Get open PRs
			const openPrs = await db.query.githubPullRequests.findMany({
				where: and(
					eq(githubPullRequests.state, "open"),
					inArray(githubPullRequests.repositoryId, repoIds),
				),
				columns: {
					id: true,
					checksStatus: true,
				},
			});

			const pendingChecksCount = openPrs.filter(
				(pr) => pr.checksStatus === "pending",
			).length;
			const failedChecksCount = openPrs.filter(
				(pr) => pr.checksStatus === "failure",
			).length;

			return {
				repositoryCount: repos.length,
				openPullRequestCount: openPrs.length,
				pendingChecksCount,
				failedChecksCount,
			};
		}),
} satisfies TRPCRouterRecord;
