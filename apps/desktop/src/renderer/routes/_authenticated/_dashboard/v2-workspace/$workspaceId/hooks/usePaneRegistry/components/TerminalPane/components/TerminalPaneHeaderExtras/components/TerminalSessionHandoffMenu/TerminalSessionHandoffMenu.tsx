import { Trans, useLingui } from "@lingui/react/macro";
import { formatNumber } from "@superset/i18n/format";
import {
	buildTerminalSessionHandoffBriefPrompt,
	buildTerminalSessionHandoffPrompt,
} from "@superset/shared/terminal-session-handoff";
import { Button } from "@superset/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { Label } from "@superset/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { workspaceTrpc } from "@superset/workspace-client";
import { Bot, GitFork, PanelRight, SquareStack } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AgentSelect } from "renderer/components/AgentSelect";
import { useTerminalAgentBinding } from "renderer/hooks/host-service/useTerminalAgentBindings";
import { useWorkspaceHostUrl } from "renderer/hooks/host-service/useWorkspaceHostUrl";
import { useV2AgentConfigs } from "renderer/hooks/useV2AgentConfigs";
import { AGENT_STORAGE_KEY } from "renderer/routes/_authenticated/components/DashboardNewWorkspaceModal/components/DashboardNewWorkspaceForm/PromptGroup/types";
import { briefContinueDeadline } from "./handoffBriefMachine";
import { resolveDefaultTargetConfigId } from "./resolveDefaultTargetConfigId";
import { useTerminalHandoffBrief } from "./useTerminalHandoffBrief";

type Placement = "split-pane" | "new-tab";

/** Rough enough to size a decision: agents bill by token, not character. */
const CHARS_PER_TOKEN = 3.5;

function estimateTokens(characters: number): number {
	return Math.round(characters / CHARS_PER_TOKEN);
}

type SessionAction = "handoff" | "fork";

interface TerminalSessionHandoffMenuProps {
	workspaceId: string;
	terminalId: string;
	onCreateNewAgentSession: (input: {
		configId: string;
		placement: Placement;
		prompt: string;
		forkSessionId?: string;
	}) => Promise<{ terminalId: string } | null>;
}

export function TerminalSessionHandoffMenu({
	workspaceId,
	terminalId,
	onCreateNewAgentSession,
}: TerminalSessionHandoffMenuProps) {
	const { t } = useLingui();
	const binding = useTerminalAgentBinding(workspaceId, terminalId);
	const hostUrl = useWorkspaceHostUrl(workspaceId);
	const { data: configs = [] } = useV2AgentConfigs(hostUrl);
	const trpcUtils = workspaceTrpc.useUtils();
	const [menuOpen, setMenuOpen] = useState(false);
	const [action, setAction] = useState<SessionAction | null>(null);
	const [targetConfigId, setTargetConfigId] = useState("");
	const [placement, setPlacement] = useState<Placement>("split-pane");
	const [isStarting, setIsStarting] = useState(false);
	const [transcript, setTranscript] = useState<string | null>(null);
	const [transcriptFailed, setTranscriptFailed] = useState(false);
	const { briefState, workspaceSnapshot } = useTerminalHandoffBrief({
		workspaceId,
		terminalId,
		enabled: action === "handoff",
		bindingLive: Boolean(binding && !binding.endedAt),
		bindingStartedAt: binding?.startedAt,
	});
	const [graceDeadline, setGraceDeadline] = useState<number | null>(null);

	const sourceConfig = useMemo(() => {
		const sourceId = binding?.definitionId ?? binding?.agentId;
		if (!sourceId) return undefined;
		return configs.find(
			(config) => config.id === sourceId || config.presetId === sourceId,
		);
	}, [binding?.agentId, binding?.definitionId, configs]);
	const selectedConfig = configs.find((config) => config.id === targetConfigId);
	// `forkArgs` is absent when the host service predates it, so an older
	// remote host degrades to "cannot fork" instead of throwing in render.
	const canFork = Boolean(
		binding?.agentSessionId && sourceConfig?.forkArgs?.length,
	);
	const defaultTargetConfigId = resolveDefaultTargetConfigId(
		configs.map((config) => config.id),
		typeof window === "undefined"
			? null
			: window.localStorage.getItem(AGENT_STORAGE_KEY),
		sourceConfig?.id,
	);

	// Fetched when the dialog opens rather than on Continue, so the size of
	// what is about to be sent is on screen before the decision.
	useEffect(() => {
		if (action !== "handoff") {
			setTranscript(null);
			setTranscriptFailed(false);
			return;
		}
		let cancelled = false;
		setTranscriptFailed(false);
		trpcUtils.terminal.transcript
			.fetch({ workspaceId, terminalId })
			.then((result) => {
				if (!cancelled) setTranscript(result.text ?? "");
			})
			.catch(() => {
				// Distinct from an empty terminal: reporting "0 characters" and
				// leaving Continue armed would fail only after the click.
				if (!cancelled) setTranscriptFailed(true);
			});
		return () => {
			cancelled = true;
		};
	}, [action, terminalId, trpcUtils, workspaceId]);

	useEffect(() => {
		if (action !== "handoff" || targetConfigId) return;
		if (defaultTargetConfigId) setTargetConfigId(defaultTargetConfigId);
	}, [action, defaultTargetConfigId, targetConfigId]);

	// Remove the grace deadline when the dialog closes. An old deadline can
	// start a session after the user re-opens the dialog, with no click.
	useEffect(() => {
		if (action !== "handoff") setGraceDeadline(null);
	}, [action]);

	const launch = useCallback(async () => {
		if (!action) return;
		setIsStarting(true);
		try {
			if (action === "fork") {
				if (!sourceConfig || !binding?.agentSessionId || !canFork) return;
				const result = await onCreateNewAgentSession({
					configId: sourceConfig.id,
					placement,
					prompt: "",
					forkSessionId: binding.agentSessionId,
				});
				if (result) setAction(null);
				return;
			}

			if (!selectedConfig) return;
			const brief =
				briefState.status === "ready" ? briefState.brief : undefined;
			if (brief) {
				const result = await onCreateNewAgentSession({
					configId: selectedConfig.id,
					placement,
					prompt: buildTerminalSessionHandoffBriefPrompt({
						brief,
						workspaceSnapshot: workspaceSnapshot ?? undefined,
						sourceAgentLabel: sourceConfig?.label ?? binding?.agentId,
						sourceTerminalId: terminalId,
					}),
				});
				if (result) setAction(null);
				return;
			}
			// Continue stays disabled without a transcript, and the dialog says
			// why inline; this only guards the impossible.
			if (!transcript) return;
			const result = await onCreateNewAgentSession({
				configId: selectedConfig.id,
				placement,
				prompt: buildTerminalSessionHandoffPrompt({
					transcript,
					sourceAgentLabel: sourceConfig?.label ?? binding?.agentId,
					sourceTerminalId: terminalId,
				}),
			});
			if (result) setAction(null);
		} finally {
			setIsStarting(false);
		}
	}, [
		action,
		sourceConfig,
		binding,
		canFork,
		onCreateNewAgentSession,
		placement,
		selectedConfig,
		transcript,
		briefState,
		workspaceSnapshot,
		terminalId,
	]);

	const start = useCallback(async () => {
		if (!action) return;
		if (action === "handoff" && briefState.status === "waiting") {
			// The brief can arrive soon. Give it a short grace time. After the
			// grace time, use the transcript prompt.
			setGraceDeadline(briefContinueDeadline(briefState, Date.now()));
			return;
		}
		await launch();
	}, [action, briefState, launch]);

	// During the grace time: the arrival or failure of the brief ends the
	// wait now. At the deadline, continue without the brief.
	useEffect(() => {
		if (graceDeadline === null) return;
		if (briefState.status !== "waiting") {
			setGraceDeadline(null);
			void launch();
			return;
		}
		const remaining = graceDeadline - Date.now();
		const finishWithoutBrief = () => {
			setGraceDeadline(null);
			void launch();
		};
		if (remaining <= 0) {
			finishWithoutBrief();
			return;
		}
		const timer = setTimeout(finishWithoutBrief, remaining);
		return () => clearTimeout(timer);
	}, [graceDeadline, briefState.status, launch]);

	if (!binding) return null;

	const openAction = (nextAction: SessionAction) => {
		setMenuOpen(false);
		setAction(nextAction);
		setPlacement("split-pane");
		if (nextAction === "handoff") {
			setTargetConfigId(defaultTargetConfigId);
		}
	};

	const title =
		action === "fork" ? (
			<Trans id="workspace.terminalPane.forkSessionTitle">Fork session</Trans>
		) : (
			<Trans id="workspace.terminalPane.continueWithAgentTitle">
				Continue with another agent
			</Trans>
		);

	const sourceAgentLabel = sourceConfig?.label ?? binding.agentId;

	// The transcript size text. Shown when no brief attempt runs (bare shell,
	// stopped agent) and after a brief failure. It shows what the fallback
	// sends.
	const transcriptDisclosure = transcriptFailed ? (
		<Trans id="workspace.terminalPane.contextUnavailable">
			Couldn't read this terminal's context.
		</Trans>
	) : transcript === null ? (
		<Trans id="workspace.terminalPane.contextMeasuring">
			Measuring the context to send to {selectedConfig?.label}…
		</Trans>
	) : transcript.length === 0 ? (
		<Trans id="workspace.terminalPane.contextEmpty">
			This terminal has no output to hand over yet.
		</Trans>
	) : (
		<Trans id="workspace.terminalPane.contextDisclosureSized">
			Sends {formatNumber(transcript.length)} characters of terminal context
			(about {formatNumber(estimateTokens(transcript.length))} tokens) to{" "}
			{selectedConfig?.label}.
		</Trans>
	);

	return (
		<>
			<DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
				<Tooltip>
					<TooltipTrigger asChild>
						<DropdownMenuTrigger asChild>
							<button
								type="button"
								aria-label={t({
									id: "workspace.terminalPane.sessionActions",
									message: "Continue or fork session",
								})}
								className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-muted-foreground"
							>
								<GitFork className="size-3.5" />
							</button>
						</DropdownMenuTrigger>
					</TooltipTrigger>
					<TooltipContent side="bottom">
						<Trans id="workspace.terminalPane.sessionActions">
							Continue or fork session
						</Trans>
					</TooltipContent>
				</Tooltip>
				<DropdownMenuContent align="end" className="w-64">
					<DropdownMenuItem onSelect={() => openAction("handoff")}>
						<Bot />
						<Trans id="workspace.terminalPane.continueWithAgent">
							Continue with another agent…
						</Trans>
					</DropdownMenuItem>
					<DropdownMenuItem
						disabled={!canFork}
						onSelect={() => openAction("fork")}
					>
						<GitFork />
						<Trans id="workspace.terminalPane.forkSession">Fork session…</Trans>
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>

			<Dialog
				open={action !== null}
				onOpenChange={(open) => {
					if (!open && !isStarting) setAction(null);
				}}
			>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription>
							{action === "fork" ? (
								<Trans id="workspace.terminalPane.forkSessionDescription">
									Create a native provider fork with the same conversation
									context. The original session stays unchanged.
								</Trans>
							) : (
								<Trans id="workspace.terminalPane.continueWithAgentDescription">
									Start a fresh agent session seeded with this terminal's recent
									context. Workspace files remain the source of truth.
								</Trans>
							)}
						</DialogDescription>
					</DialogHeader>

					<div className="flex flex-col gap-4 py-1">
						{action === "handoff" ? (
							<div className="flex flex-col gap-2">
								<Label>
									<Trans id="workspace.terminalPane.targetAgent">
										Target agent
									</Trans>
								</Label>
								<AgentSelect
									agents={configs.map((config) => ({
										id: config.id,
										label: config.label,
										iconId: config.presetId,
										presetId: config.presetId,
									}))}
									value={targetConfigId}
									placeholder={t({
										id: "workspace.terminalPane.selectAgent",
										message: "Select an agent",
									})}
									onValueChange={setTargetConfigId}
									disabled={isStarting || configs.length === 0}
									triggerClassName="w-full"
									onBeforeConfigureAgents={() => setAction(null)}
								/>
								{selectedConfig &&
									(briefState.status === "idle" ? (
										<p className="text-muted-foreground text-xs">
											{transcriptDisclosure}
										</p>
									) : briefState.status === "waiting" ? (
										<p className="text-muted-foreground text-xs">
											<Trans id="workspace.terminalPane.briefWaiting">
												Asking {sourceAgentLabel} in this terminal to write a
												handoff brief…
											</Trans>{" "}
											<Trans id="workspace.terminalPane.briefWaitingFallbackNote">
												Superset will send the terminal transcript instead if it
												doesn't finish.
											</Trans>
										</p>
									) : briefState.status === "ready" && briefState.brief ? (
										<p className="text-muted-foreground text-xs">
											<Trans id="workspace.terminalPane.briefReadyDisclosure">
												Sends {formatNumber(briefState.brief.length)} characters
												of the agent's handoff brief (about{" "}
												{formatNumber(estimateTokens(briefState.brief.length))}{" "}
												tokens) to {selectedConfig.label}.
											</Trans>
										</p>
									) : (
										<p className="text-muted-foreground text-xs">
											<Trans id="workspace.terminalPane.briefUnavailable">
												{sourceAgentLabel} didn't answer in time — Superset will
												send the terminal transcript instead.
											</Trans>{" "}
											{transcriptDisclosure}
										</p>
									))}
							</div>
						) : (
							<div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
								<Trans id="workspace.terminalPane.forkProvider">
									Provider: {sourceConfig?.label ?? binding.agentId}
								</Trans>
							</div>
						)}

						<div className="flex flex-col gap-2">
							<Label>
								<Trans id="workspace.terminalPane.openSessionIn">
									Open session in
								</Trans>
							</Label>
							<div className="grid grid-cols-2 gap-2" role="radiogroup">
								<Button
									type="button"
									variant={placement === "split-pane" ? "secondary" : "outline"}
									onClick={() => setPlacement("split-pane")}
									aria-pressed={placement === "split-pane"}
									disabled={isStarting}
								>
									<PanelRight />
									<Trans id="workspace.terminalPane.splitPane">
										Split pane
									</Trans>
								</Button>
								<Button
									type="button"
									variant={placement === "new-tab" ? "secondary" : "outline"}
									onClick={() => setPlacement("new-tab")}
									aria-pressed={placement === "new-tab"}
									disabled={isStarting}
								>
									<SquareStack />
									<Trans id="workspace.terminalPane.newTab">New tab</Trans>
								</Button>
							</div>
						</div>
					</div>

					<DialogFooter>
						<Button
							variant="ghost"
							onClick={() => setAction(null)}
							disabled={isStarting}
						>
							<Trans id="workspace.terminalPane.sessionActionCancel">
								Cancel
							</Trans>
						</Button>
						<Button
							onClick={start}
							disabled={
								isStarting ||
								graceDeadline !== null ||
								(action === "fork"
									? !canFork
									: // Continue needs one usable seed: the transcript or a
										// finished brief. Refuse before the click, not after it.
										!selectedConfig ||
										(!transcript && briefState.status !== "ready"))
							}
						>
							{isStarting ? (
								<Trans id="workspace.terminalPane.startingSession">
									Starting…
								</Trans>
							) : graceDeadline !== null ? (
								<Trans id="workspace.terminalPane.briefStillWriting">
									Still writing the brief…
								</Trans>
							) : action === "fork" ? (
								<Trans id="workspace.terminalPane.forkSessionConfirm">
									Fork session
								</Trans>
							) : (
								<Trans id="workspace.terminalPane.continueWithAgentConfirm">
									Continue
								</Trans>
							)}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
