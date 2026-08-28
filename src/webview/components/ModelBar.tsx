import { useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import { formatEstimatedCost } from "../../shared/usage.js";
import { postIntent } from "../bridge.js";
import {
	draftForCurrentModel,
	draftForModelOption,
	type ModelSettingsDraft,
	modelOptionMatchesDraft,
	modelSettingsChanged,
	thinkingLevelLabel,
} from "../model-settings.js";
import type { ModelOption, ModelState, UsageState } from "../types.js";

interface ComposerSessionControlsProps {
	readonly chatId: string;
	readonly phase: "idle" | "running" | "waitingApproval" | "error";
	readonly model: ModelState;
	readonly usage: UsageState;
}

const compactNumberFormatter = new Intl.NumberFormat(undefined, {
	notation: "compact",
	maximumFractionDigits: 1,
});
const fullNumberFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

function compactNumber(value: number): string {
	return compactNumberFormatter.format(value);
}

function fullNumber(value: number): string {
	return fullNumberFormatter.format(value);
}

function costText(usage: UsageState): string | null {
	if (usage.cost === null || usage.costKind === "unknown") return null;
	const formatted = formatEstimatedCost(usage.cost);
	const estimate = formatted.startsWith("<") ? formatted : `≈${formatted}`;
	return usage.costKind === "subscription" ? `${estimate} · Sub` : estimate;
}

function costHelpText(usage: UsageState): string {
	if (usage.costKind === "subscription") {
		return "Reference token cost only; your provider subscription may cover it.";
	}
	if (usage.costKind === "unknown") return "Pricing is not available for the selected model.";
	return "Estimated from catalog pricing; provider billing may differ.";
}

function usageSeverity(percent: number | null): "unknown" | "normal" | "warning" | "critical" {
	if (percent === null) return "unknown";
	if (percent >= 90) return "critical";
	if (percent >= 70) return "warning";
	return "normal";
}

function TokenStat({ label, value }: { readonly label: string; readonly value: number }) {
	const exact = fullNumber(value);
	return (
		<div>
			<dt>{label}</dt>
			<dd title={`${exact} tokens`}>{exact}</dd>
		</div>
	);
}

export function UsagePill({
	chatId,
	phase,
	usage,
}: {
	readonly chatId: string;
	readonly phase: ComposerSessionControlsProps["phase"];
	readonly usage: UsageState;
}) {
	const [open, setOpen] = useState(false);
	const controlRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const popoverRef = useRef<HTMLElement>(null);
	const instanceId = useId();
	const popoverId = `usage-popover-${instanceId}`;
	const headingId = `usage-heading-${instanceId}`;
	const compactHelpId = `usage-compact-help-${instanceId}`;
	const percent = usage.contextPercent;
	const cost = costText(usage);
	const severity = usageSeverity(percent);
	const live = phase === "running";
	const busy = phase === "running" || phase === "waitingApproval";
	const contextTokens = usage.contextTokens;
	const contextWindow = usage.contextWindow;
	const hasContextTotals = contextTokens !== null && contextWindow !== null;
	const remainingTokens = hasContextTotals ? Math.max(0, contextWindow - contextTokens) : null;
	const contextSummary = hasContextTotals
		? `${compactNumber(contextTokens)} / ${compactNumber(contextWindow)} tokens · ${compactNumber(remainingTokens ?? 0)} left`
		: "Token totals are not available";
	const contextTitle = hasContextTotals
		? `${fullNumber(contextTokens)} of ${fullNumber(contextWindow)} tokens used; ${fullNumber(remainingTokens ?? 0)} remaining`
		: undefined;

	useEffect(() => {
		if (!open) return undefined;
		window.requestAnimationFrame(() =>
			popoverRef.current?.querySelector<HTMLButtonElement>(".popover-heading button")?.focus(),
		);
		const closeFromPointer = (event: PointerEvent) => {
			if (!controlRef.current?.contains(event.target as Node)) setOpen(false);
		};
		const closeFromKeyboard = (event: globalThis.KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			setOpen(false);
			buttonRef.current?.focus();
		};
		window.addEventListener("pointerdown", closeFromPointer);
		window.addEventListener("keydown", closeFromKeyboard);
		return () => {
			window.removeEventListener("pointerdown", closeFromPointer);
			window.removeEventListener("keydown", closeFromKeyboard);
		};
	}, [open]);

	const closeAndRestoreFocus = () => {
		setOpen(false);
		buttonRef.current?.focus();
	};
	const runAndClose = (
		intent:
			| { readonly type: "compactContext"; readonly chatId: string }
			| { readonly type: "newChat" },
	) => {
		postIntent(intent);
		closeAndRestoreFocus();
	};

	return (
		<div ref={controlRef} class="usage-control">
			<button
				ref={buttonRef}
				class={`usage-pill ${severity} ${live ? "live" : ""}`}
				type="button"
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-controls={open ? popoverId : undefined}
				aria-label={
					percent === null
						? `Context usage unavailable; cost ${cost ?? "unavailable"}${live ? "; updating live" : ""}`
						: `Context window, ${Math.round(percent)} percent used; cost ${cost ?? "unavailable"}${live ? "; updating live" : ""}`
				}
				title={live ? "Session usage · updating live" : "Session usage"}
				onClick={() => setOpen(!open)}
			>
				<svg class="usage-glyph" viewBox="0 0 18 18" aria-hidden="true">
					<circle class="usage-glyph-track" cx="9" cy="9" r="6.5" pathLength="100" />
					<circle
						class="usage-glyph-value"
						cx="9"
						cy="9"
						r="6.5"
						pathLength="100"
						stroke-dasharray={`${Math.min(100, Math.max(0, percent ?? 0))} 100`}
					/>
				</svg>
				<span class="usage-value">{percent === null ? "—" : `${Math.round(percent)}%`}</span>
				{cost ? <span class="usage-cost wide-only">{cost}</span> : null}
			</button>
			{open ? (
				<section
					id={popoverId}
					ref={popoverRef}
					class="popover usage-popover"
					role="dialog"
					aria-labelledby={headingId}
				>
					<div class="popover-heading">
						<span>
							<strong id={headingId}>Session usage</strong>
							{live ? <small class="live-badge">Live</small> : null}
						</span>
						<button
							type="button"
							class="icon-button"
							aria-label="Close session usage"
							onClick={closeAndRestoreFocus}
						>
							×
						</button>
					</div>
					<div class="usage-overview">
						<div class="usage-label">
							<span>Current context</span>
							<strong>{percent === null ? "Unavailable" : `${Math.round(percent)}%`}</strong>
						</div>
						<small title={contextTitle}>{contextSummary}</small>
					</div>
					<div
						class={`usage-meter ${severity}`}
						role="progressbar"
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={percent ?? undefined}
						aria-valuetext={
							percent === null
								? "Context usage unavailable"
								: `${Math.round(percent)} percent used${remainingTokens === null ? "" : `, ${fullNumber(remainingTokens)} tokens remaining`}`
						}
						aria-label="Current context window usage"
					>
						<span style={{ width: `${Math.min(100, Math.max(0, percent ?? 0))}%` }} />
					</div>
					{severity === "warning" ? (
						<p class="usage-advice warning">Context is filling up. Compact before a large task.</p>
					) : severity === "critical" ? (
						<p class="usage-advice critical">
							Context is almost full. Compact or start a new chat.
						</p>
					) : null}
					<div class="usage-section-heading">
						<span>Session tokens</span>
						<strong title={`${fullNumber(usage.total)} tokens`}>{fullNumber(usage.total)}</strong>
					</div>
					<dl class="usage-grid">
						<TokenStat label="Input" value={usage.input} />
						<TokenStat label="Output" value={usage.output} />
						<TokenStat label="Cache read" value={usage.cacheRead} />
						<TokenStat label="Cache write" value={usage.cacheWrite} />
					</dl>
					<div class="usage-total">
						<span>
							{usage.costKind === "subscription"
								? "Reference token cost"
								: usage.costKind === "estimated"
									? "Estimated cost"
									: "Session cost"}
						</span>
						<strong>{cost ?? "Unavailable"}</strong>
					</div>
					<p class="help-text">{costHelpText(usage)}</p>
					{busy ? (
						<p id={compactHelpId} class="inline-warning usage-action-help" role="status">
							Stop the current response to compact this chat.
						</p>
					) : null}
					<div class="popover-actions usage-actions">
						<button
							type="button"
							disabled={busy}
							aria-describedby={busy ? compactHelpId : undefined}
							title="Summarize older conversation context to free space"
							onClick={() => runAndClose({ type: "compactContext", chatId })}
						>
							Compact this chat
						</button>
						<button type="button" onClick={() => runAndClose({ type: "newChat" })}>
							Start new chat
						</button>
					</div>
				</section>
			) : null}
		</div>
	);
}

function modelIdentity(provider: string | undefined, id: string | undefined): string {
	return provider && id ? `${provider} · ${id}` : "No model selected";
}

function supportsReasoning(option: ModelOption): boolean {
	return option.thinkingLevels.some((level) => level !== "off");
}

export function ComposerSessionControls({
	chatId,
	phase,
	model,
	usage,
}: ComposerSessionControlsProps) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [draft, setDraft] = useState<ModelSettingsDraft | undefined>(() =>
		draftForCurrentModel(model),
	);
	const controlRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const popoverRef = useRef<HTMLElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const instanceId = useId();
	const popoverId = `model-popover-${instanceId}`;
	const headingId = `model-heading-${instanceId}`;
	const searchId = `model-search-${instanceId}`;
	const thinkingId = `thinking-level-${instanceId}`;
	const busy = phase === "running" || phase === "waitingApproval";
	const options = useMemo(() => {
		const normalized = query.trim().toLocaleLowerCase();
		if (!normalized) return model.options;
		return model.options.filter((option) =>
			`${option.provider} ${option.name} ${option.id}`.toLocaleLowerCase().includes(normalized),
		);
	}, [model.options, query]);
	const draftOption = model.options.find((option) => modelOptionMatchesDraft(option, draft));
	const thinkingOptions = draftOption
		? draftOption.thinkingLevels.length > 0
			? draftOption.thinkingLevels
			: (["off"] as const)
		: draft
			? ([draft.thinking] as const)
			: [];
	const draftChanged = modelSettingsChanged(model, draft);
	const draftName =
		draftOption?.name ??
		(draft && draft.provider === model.provider && draft.modelId === model.id
			? model.name
			: draft?.modelId);
	const selectedVisible = options.some((option) => modelOptionMatchesDraft(option, draft));

	useEffect(() => {
		if (!open) return undefined;
		window.requestAnimationFrame(() => {
			if (!busy) searchRef.current?.focus();
			else popoverRef.current?.querySelector<HTMLButtonElement>(".popover-heading button")?.focus();
		});
		const closeFromPointer = (event: PointerEvent) => {
			if (!controlRef.current?.contains(event.target as Node)) setOpen(false);
		};
		const closeFromKeyboard = (event: globalThis.KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			setOpen(false);
			buttonRef.current?.focus();
		};
		window.addEventListener("pointerdown", closeFromPointer);
		window.addEventListener("keydown", closeFromKeyboard);
		return () => {
			window.removeEventListener("pointerdown", closeFromPointer);
			window.removeEventListener("keydown", closeFromKeyboard);
		};
	}, [busy, open]);

	const focusModelOption = (requestedIndex: number) => {
		const optionButtons = popoverRef.current?.querySelectorAll<HTMLButtonElement>(
			".model-option:not(:disabled)",
		);
		if (!optionButtons || optionButtons.length === 0) return;
		const index = Math.min(optionButtons.length - 1, Math.max(0, requestedIndex));
		optionButtons.item(index).focus();
	};
	const closeAndRestoreFocus = () => {
		setOpen(false);
		buttonRef.current?.focus();
	};
	const applyDraft = (saveAsDefault: boolean) => {
		if (!draft) return;
		postIntent({
			type: "applyModelSettings",
			chatId,
			provider: draft.provider,
			modelId: draft.modelId,
			thinking: draft.thinking,
			saveAsDefault,
		});
		closeAndRestoreFocus();
	};

	return (
		<fieldset class="composer-session-controls">
			<legend class="sr-only">Model and session settings</legend>
			<div ref={controlRef} class="model-control">
				<button
					ref={buttonRef}
					class="model-pill"
					type="button"
					aria-haspopup="dialog"
					aria-expanded={open}
					aria-controls={open ? popoverId : undefined}
					aria-label={`Model settings: ${model.name}, reasoning ${thinkingLevelLabel(model.thinking)}`}
					title={`${modelIdentity(model.provider, model.id)} · ${thinkingLevelLabel(model.thinking)} reasoning`}
					onClick={() => {
						const nextOpen = !open;
						setOpen(nextOpen);
						if (nextOpen) {
							setQuery("");
							setDraft(draftForCurrentModel(model));
							postIntent({ type: "loadModels" });
						}
					}}
				>
					<svg class="model-glyph" viewBox="0 0 18 18" aria-hidden="true">
						<path d="M3 5.25h7.5M13.5 5.25H15M3 12.75h1.5M7.5 12.75H15" />
						<circle cx="12" cy="5.25" r="1.5" />
						<circle cx="6" cy="12.75" r="1.5" />
					</svg>
					<span class="model-name">{model.name}</span>
					<span class="model-reasoning wide-only">{thinkingLevelLabel(model.thinking)}</span>
					<span class="model-chevron" aria-hidden="true">
						▾
					</span>
				</button>
				{open ? (
					<section
						id={popoverId}
						ref={popoverRef}
						class="popover model-popover"
						role="dialog"
						aria-labelledby={headingId}
					>
						<div class="popover-heading">
							<span>
								<strong id={headingId}>Model settings</strong>
								<small class="scope-badge">This chat</small>
							</span>
							<button
								type="button"
								class="icon-button"
								aria-label="Close model settings"
								onClick={closeAndRestoreFocus}
							>
								×
							</button>
						</div>
						<div class="model-popover-body">
							<div class="current-model-summary">
								<span>Current</span>
								<strong title={model.name}>{model.name}</strong>
								<small title={modelIdentity(model.provider, model.id)}>
									{model.provider && model.id
										? `${model.provider} · ${model.id} · ${thinkingLevelLabel(model.thinking)} reasoning`
										: "Choose a model before sending your first request"}
								</small>
							</div>
							{busy ? (
								<p class="inline-warning">Stop the current response to change model settings.</p>
							) : null}
							{model.authError ? <p class="inline-error">{model.authError}</p> : null}
							<div class="model-field-heading">
								<label class="field-label" for={searchId}>
									Provider &amp; model
								</label>
								<small aria-live="polite">
									{model.loading ? "Refreshing…" : `${options.length} shown`}
								</small>
							</div>
							<input
								id={searchId}
								ref={searchRef}
								type="search"
								value={query}
								placeholder="Search by model, provider, or ID"
								disabled={busy}
								onKeyDown={(event) => {
									if (event.key === "ArrowDown") {
										event.preventDefault();
										focusModelOption(0);
									} else if (event.key === "ArrowUp") {
										event.preventDefault();
										focusModelOption(options.length - 1);
									} else if (event.key === "Enter") event.preventDefault();
								}}
								onInput={(event) => setQuery(event.currentTarget.value)}
							/>
							{model.loading ? (
								<div class="model-catalog-status" role="status">
									{model.options.length > 0
										? "Refreshing model catalog…"
										: "Loading available models…"}
								</div>
							) : null}
							{options.length > 0 ? (
								<div
									class="model-list"
									role="listbox"
									aria-label="Available models"
									aria-busy={model.loading}
								>
									{options.map((option, optionIndex) => {
										const isSelected = modelOptionMatchesDraft(option, draft);
										const isCurrent = model.provider === option.provider && model.id === option.id;
										const isTabStop = isSelected || (!selectedVisible && optionIndex === 0);
										return (
											<button
												type="button"
												role="option"
												aria-selected={isSelected}
												tabIndex={isTabStop ? 0 : -1}
												class={`model-option ${isSelected ? "selected" : ""}`}
												key={`${option.provider}\0${option.id}`}
												disabled={busy}
												onClick={() =>
													setDraft(draftForModelOption(option, draft?.thinking ?? model.thinking))
												}
												onKeyDown={(event) => {
													if (event.key === "ArrowDown") {
														event.preventDefault();
														focusModelOption(optionIndex + 1);
													} else if (event.key === "ArrowUp") {
														event.preventDefault();
														focusModelOption(optionIndex - 1);
													} else if (event.key === "Home") {
														event.preventDefault();
														focusModelOption(0);
													} else if (event.key === "End") {
														event.preventDefault();
														focusModelOption(options.length - 1);
													} else if (event.key === "Enter") {
														event.preventDefault();
														setDraft(
															draftForModelOption(option, draft?.thinking ?? model.thinking),
														);
													}
												}}
											>
												<span class="model-option-copy">
													<span class="model-option-heading">
														<strong>{option.name}</strong>
														{isCurrent ? <small class="model-current-badge">Current</small> : null}
													</span>
													<small class="model-identity" title={`${option.provider} · ${option.id}`}>
														{option.provider} · {option.id}
													</small>
													<span class="model-capabilities">
														{option.contextWindow ? (
															<small>{compactNumber(option.contextWindow)} context</small>
														) : null}
														{option.supportsImages ? <small>Images</small> : null}
														{supportsReasoning(option) ? <small>Reasoning</small> : null}
													</span>
												</span>
												<span class="model-meta">
													{isSelected ? (
														<span class="model-selected-mark" aria-hidden="true">
															✓
														</span>
													) : null}
												</span>
											</button>
										);
									})}
								</div>
							) : (
								<div class="model-list model-list-empty" role="status">
									<div class={model.loading ? "loading-row" : "empty-row"}>
										{model.loading
											? "Updating model results…"
											: query.trim() && model.options.length > 0
												? `No models match “${query.trim()}”.`
												: "No authenticated models available. Configure a provider below."}
									</div>
								</div>
							)}
							<label class="field-label" for={thinkingId}>
								Reasoning effort
							</label>
							<select
								id={thinkingId}
								value={draft?.thinking ?? "off"}
								disabled={busy || !draft}
								onChange={(event) => {
									const thinking = event.currentTarget.value as ModelSettingsDraft["thinking"];
									setDraft((current) => (current ? { ...current, thinking } : current));
								}}
							>
								{thinkingOptions.length > 0 ? (
									thinkingOptions.map((level) => (
										<option key={level} value={level}>
											{thinkingLevelLabel(level)}
										</option>
									))
								) : (
									<option value="off">Select a model first</option>
								)}
							</select>
							<p class="help-text model-thinking-help">
								Higher effort can improve complex work, but may increase latency and token use.
							</p>
						</div>
						<div class="model-popover-footer">
							<div
								class={`model-change-summary ${draftChanged ? "changed" : ""}`}
								role="status"
								aria-live="polite"
							>
								<span>{draftChanged ? "Pending changes" : "Selected settings"}</span>
								<strong>{draftName ?? "Select a model"}</strong>
								{draft ? <small>{thinkingLevelLabel(draft.thinking)} reasoning</small> : null}
							</div>
							<div class="popover-actions model-actions">
								<button
									class="primary-button"
									type="button"
									disabled={busy || !draft || !draftChanged}
									onClick={() => applyDraft(false)}
								>
									Apply
								</button>
								<button
									type="button"
									disabled={busy || !draft}
									title="Apply these settings here and use them for future chats"
									onClick={() => applyDraft(true)}
								>
									Set default
								</button>
							</div>
							<small class="model-default-help">
								Set default also applies the selected settings to this chat.
							</small>
							<button
								class="link-button"
								type="button"
								onClick={() => {
									postIntent(
										draft?.provider
											? { type: "configureProvider", provider: draft.provider }
											: { type: "configureProvider" },
									);
									closeAndRestoreFocus();
								}}
							>
								Configure provider…
							</button>
						</div>
					</section>
				) : null}
			</div>
			<UsagePill chatId={chatId} phase={phase} usage={usage} />
		</fieldset>
	);
}
