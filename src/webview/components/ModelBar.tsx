import { useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import { formatEstimatedCost } from "../../shared/usage.js";
import { postIntent } from "../bridge.js";
import type { ModelOption, ModelState, ThinkingLevel, UsageState } from "../types.js";

interface ComposerSessionControlsProps {
	readonly chatId: string;
	readonly phase: "idle" | "running" | "waitingApproval" | "error";
	readonly model: ModelState;
	readonly usage: UsageState;
}

function compactNumber(value: number): string {
	return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
		value,
	);
}

function costText(usage: UsageState): string | null {
	if (usage.cost === null || usage.costKind === "unknown") return null;
	const formatted = formatEstimatedCost(usage.cost);
	const estimate = formatted.startsWith("<") ? formatted : `≈${formatted}`;
	return usage.costKind === "subscription" ? `${estimate} · Sub` : estimate;
}

function costHelpText(usage: UsageState): string {
	if (usage.costKind === "subscription") {
		return "Token cost shown for reference; your provider subscription may cover it.";
	}
	if (usage.costKind === "unknown") return "Pricing is unavailable for this session.";
	return "Estimated from model pricing. Provider billing may differ.";
}

export function UsagePill({
	chatId,
	live,
	usage,
}: {
	readonly chatId: string;
	readonly live: boolean;
	readonly usage: UsageState;
}) {
	const [open, setOpen] = useState(false);
	const controlRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const popoverRef = useRef<HTMLElement>(null);
	const popoverId = `usage-popover-${useId()}`;
	const percent = usage.contextPercent;
	const cost = costText(usage);
	const severity =
		percent === null
			? "unknown"
			: percent >= 90
				? "critical"
				: percent >= 70
					? "warning"
					: "normal";
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
					aria-label="Session usage"
				>
					<div class="popover-heading">
						<span>
							<strong>Session usage</strong>
							{live ? <small class="live-badge">Live</small> : null}
						</span>
						<button
							type="button"
							class="icon-button"
							aria-label="Close"
							onClick={() => {
								setOpen(false);
								buttonRef.current?.focus();
							}}
						>
							×
						</button>
					</div>
					<div class="usage-overview">
						<div class="usage-label">
							<span>Context window</span>
							<strong>{percent === null ? "Unavailable" : `${Math.round(percent)}%`}</strong>
						</div>
						<small>
							{usage.contextTokens === null || usage.contextWindow === null
								? "Token totals are not available"
								: `${compactNumber(usage.contextTokens)} of ${compactNumber(usage.contextWindow)} tokens`}
						</small>
					</div>
					<div
						class={`usage-meter ${severity}`}
						role="progressbar"
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={percent ?? undefined}
						aria-label={
							percent === null
								? "Context usage unavailable"
								: `Context window, ${Math.round(percent)} percent used`
						}
					>
						<span style={{ width: `${Math.min(100, Math.max(0, percent ?? 0))}%` }} />
					</div>
					<dl class="usage-grid">
						<div>
							<dt>Input</dt>
							<dd>{compactNumber(usage.input)}</dd>
						</div>
						<div>
							<dt>Output</dt>
							<dd>{compactNumber(usage.output)}</dd>
						</div>
						<div>
							<dt>Cache read</dt>
							<dd>{compactNumber(usage.cacheRead)}</dd>
						</div>
						<div>
							<dt>Cache write</dt>
							<dd>{compactNumber(usage.cacheWrite)}</dd>
						</div>
					</dl>
					{cost ? (
						<div class="usage-total">
							<span>Session cost</span>
							<strong>{cost}</strong>
						</div>
					) : null}
					<p class="help-text">{costHelpText(usage)}</p>
					<div class="popover-actions">
						<button type="button" onClick={() => postIntent({ type: "compactContext", chatId })}>
							Compact context
						</button>
						<button type="button" onClick={() => postIntent({ type: "newChat" })}>
							New chat
						</button>
					</div>
				</section>
			) : null}
		</div>
	);
}

export function ComposerSessionControls({
	chatId,
	phase,
	model,
	usage,
}: ComposerSessionControlsProps) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<ModelOption | undefined>();
	const controlRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const popoverRef = useRef<HTMLElement>(null);
	const popoverId = `model-popover-${useId()}`;
	const busy = phase === "running" || phase === "waitingApproval";
	const options = useMemo(() => {
		const normalized = query.trim().toLocaleLowerCase();
		if (!normalized) return model.options;
		return model.options.filter((option) =>
			`${option.provider} ${option.name} ${option.id}`.toLocaleLowerCase().includes(normalized),
		);
	}, [model.options, query]);
	const effective =
		selected ??
		model.options.find((option) => option.provider === model.provider && option.id === model.id);
	const thinkingOptions =
		effective?.thinkingLevels ??
		(["off", "low", "medium", "high"] satisfies readonly ThinkingLevel[]);
	useEffect(() => {
		if (!open) return undefined;
		window.requestAnimationFrame(() =>
			popoverRef.current?.querySelector<HTMLInputElement>("#model-search")?.focus(),
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
	const focusModelOption = (requestedIndex: number) => {
		const optionButtons = popoverRef.current?.querySelectorAll<HTMLButtonElement>(
			".model-option:not(:disabled)",
		);
		if (!optionButtons || optionButtons.length === 0) return;
		const index = Math.min(optionButtons.length - 1, Math.max(0, requestedIndex));
		optionButtons.item(index).focus();
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
					aria-label={`Model settings: ${model.name}, reasoning ${model.thinking}`}
					title={`Model settings · ${model.name} · ${model.thinking} reasoning`}
					onClick={() => {
						setOpen(!open);
						if (!open) postIntent({ type: "loadModels" });
					}}
				>
					<svg class="model-glyph" viewBox="0 0 18 18" aria-hidden="true">
						<path d="M3 5.25h7.5M13.5 5.25H15M3 12.75h1.5M7.5 12.75H15" />
						<circle cx="12" cy="5.25" r="1.5" />
						<circle cx="6" cy="12.75" r="1.5" />
					</svg>
					<span class="model-name">{model.name}</span>
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
						aria-label="Model settings"
					>
						<div class="popover-heading">
							<span>
								<strong>Model settings</strong>
								<small class="scope-badge">This chat</small>
							</span>
							<button
								type="button"
								class="icon-button"
								aria-label="Close"
								onClick={() => {
									setOpen(false);
									buttonRef.current?.focus();
								}}
							>
								×
							</button>
						</div>
						{busy ? (
							<p class="inline-warning">Stop the current response to change models.</p>
						) : null}
						{model.authError ? <p class="inline-error">{model.authError}</p> : null}
						<label class="field-label" for="model-search">
							Provider &amp; model
						</label>
						<input
							id="model-search"
							type="search"
							value={query}
							placeholder="Search available models"
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
						<div class="model-list" role="listbox" aria-label="Available models">
							{model.loading ? <div class="loading-row">Loading available models…</div> : null}
							{!model.loading && options.length === 0 ? (
								<div class="empty-row">No authenticated models available.</div>
							) : null}
							{options.map((option, optionIndex) => {
								const isSelected =
									(selected?.provider ?? model.provider) === option.provider &&
									(selected?.id ?? model.id) === option.id;
								return (
									<button
										type="button"
										role="option"
										aria-selected={isSelected}
										tabIndex={isSelected ? 0 : -1}
										class={`model-option ${isSelected ? "selected" : ""}`}
										key={`${option.provider}\0${option.id}`}
										disabled={busy}
										onClick={() => setSelected(option)}
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
												setSelected(option);
											}
										}}
									>
										<span>
											<strong>{option.name}</strong>
											<small>
												{option.provider} · {option.id}
											</small>
										</span>
										<span class="model-meta">
											{option.contextWindow ? `${compactNumber(option.contextWindow)} ctx` : ""}
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
						<label class="field-label" for="thinking-level">
							Reasoning effort
						</label>
						<select
							id="thinking-level"
							value={model.thinking}
							disabled={busy}
							onChange={(event) =>
								postIntent({
									type: "setThinking",
									chatId,
									level: event.currentTarget.value as ThinkingLevel,
								})
							}
						>
							{thinkingOptions.map((level) => (
								<option key={level} value={level}>
									{level[0]?.toUpperCase()}
									{level.slice(1)}
								</option>
							))}
						</select>
						<div class="popover-actions">
							<button
								class="primary-button"
								type="button"
								disabled={busy || !selected}
								onClick={() => {
									if (selected)
										postIntent({
											type: "setModel",
											chatId,
											provider: selected.provider,
											modelId: selected.id,
										});
									setOpen(false);
									buttonRef.current?.focus();
								}}
							>
								Apply to this chat
							</button>
							<button
								type="button"
								disabled={busy}
								onClick={() => postIntent({ type: "saveModelDefault", chatId })}
							>
								Save as default
							</button>
						</div>
						<button
							class="link-button"
							type="button"
							onClick={() =>
								postIntent(
									selected?.provider
										? { type: "configureProvider", provider: selected.provider }
										: { type: "configureProvider" },
								)
							}
						>
							Configure provider…
						</button>
					</section>
				) : null}
			</div>
			<UsagePill chatId={chatId} live={phase === "running"} usage={usage} />
		</fieldset>
	);
}
