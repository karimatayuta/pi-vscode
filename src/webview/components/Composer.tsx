import type { DragEvent, KeyboardEvent, PointerEvent as PreactPointerEvent } from "preact/compat";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { classifyContextResourceDrag, readDroppedUris } from "../../shared/drop-data.js";
import { postIntent } from "../bridge.js";
import { ComposerDropTracker } from "../composer-drop-tracker.js";
import { promptSignal } from "../store.js";
import type {
	ApprovalMode,
	CommandSuggestion,
	ContextChip,
	FileSuggestion,
	ModelState,
	UsageState,
} from "../types.js";
import { ComposerModeControl } from "./ComposerModeControl.js";
import { ComposerSuggestions } from "./ComposerSuggestions.js";
import { ComposerSessionControls } from "./ModelBar.js";

const COMPOSER_INPUT_MIN_HEIGHT = 70;
const COMPOSER_INPUT_DEFAULT_HEIGHT = 76;
const COMPOSER_INPUT_MAX_HEIGHT = 320;
const COMPOSER_MIN_TIMELINE_HEIGHT = 140;
const COMPOSER_TOP_CHROME_HEIGHT = 36;
const COMPOSER_FIXED_CHROME_FALLBACK = 112;

function availableComposerInputHeight(fixedChrome = COMPOSER_FIXED_CHROME_FALLBACK): number {
	return Math.max(
		COMPOSER_INPUT_MIN_HEIGHT,
		Math.min(
			COMPOSER_INPUT_MAX_HEIGHT,
			Math.floor(window.innerHeight * 0.46),
			Math.floor(
				window.innerHeight -
					COMPOSER_TOP_CHROME_HEIGHT -
					COMPOSER_MIN_TIMELINE_HEIGHT -
					fixedChrome,
			),
		),
	);
}

function clampComposerInputHeight(value: number, maximum: number): number {
	return Math.min(maximum, Math.max(COMPOSER_INPUT_MIN_HEIGHT, Math.round(value)));
}

function commandQuery(value: string): string | undefined {
	const trimmed = value.trimStart();
	if (!trimmed.startsWith("/") || /\s/u.test(trimmed.slice(1))) {
		return undefined;
	}
	return trimmed.slice(1).toLocaleLowerCase();
}

function fileQuery(value: string, cursor: number): string | undefined {
	const before = value.slice(0, cursor);
	const match = before.match(/(?:^|\s)@([^\s]*)$/u);
	return match?.[1];
}

interface ComposerProps {
	readonly chatId: string;
	readonly phase: "idle" | "running" | "waitingApproval" | "error";
	readonly context: readonly ContextChip[];
	readonly commands: readonly CommandSuggestion[];
	readonly fileSuggestions: readonly FileSuggestion[];
	readonly approvalMode: ApprovalMode;
	readonly trusted: boolean;
	readonly model: ModelState;
	readonly usage: UsageState;
}

export function Composer({
	chatId,
	phase,
	context,
	commands,
	fileSuggestions,
	approvalMode,
	trusted,
	model,
	usage,
}: ComposerProps) {
	const [dragging, setDragging] = useState(false);
	const [activeSuggestion, setActiveSuggestion] = useState(0);
	const [cursor, setCursor] = useState(0);
	const [inputHeight, setInputHeight] = useState(() =>
		clampComposerInputHeight(COMPOSER_INPUT_DEFAULT_HEIGHT, availableComposerInputHeight()),
	);
	const [maximumInputHeight, setMaximumInputHeight] = useState(availableComposerInputHeight);
	const composerDockRef = useRef<HTMLElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const dropTrackerRef = useRef(new ComposerDropTracker());
	const resizeGestureRef = useRef<{
		readonly pointerId: number;
		readonly startY: number;
		readonly startHeight: number;
	} | null>(null);
	const prompt = promptSignal.value;
	const slash = commandQuery(prompt);
	const atQuery = fileQuery(prompt, cursor);
	const filteredCommands = useMemo(() => {
		if (slash === undefined) return [];
		const result = commands.filter((command) =>
			`${command.invocation} ${command.description} ${command.kind}`
				.toLocaleLowerCase()
				.includes(slash),
		);
		return result.slice(0, 12);
	}, [commands, slash]);
	const showSlash = slash !== undefined;
	const showFiles = !showSlash && atQuery !== undefined;
	const activeListLength = showSlash
		? filteredCommands.length
		: showFiles
			? fileSuggestions.length
			: 0;
	const isBusy = phase === "running" || phase === "waitingApproval";
	const suggestionListId = showSlash
		? "pi-command-suggestions"
		: showFiles
			? "pi-file-suggestions"
			: undefined;
	const activeOptionId =
		activeListLength > 0 && suggestionListId
			? `${suggestionListId}-${Math.min(activeSuggestion, activeListLength - 1)}`
			: undefined;

	useEffect(() => {
		setActiveSuggestion(0);
		if (atQuery !== undefined) {
			const timer = window.setTimeout(
				() => postIntent({ type: "searchFiles", query: atQuery }),
				100,
			);
			return () => window.clearTimeout(timer);
		}
		return undefined;
	}, [slash, atQuery]);

	useEffect(() => {
		if (activeSuggestion >= activeListLength)
			setActiveSuggestion(Math.max(0, activeListLength - 1));
	}, [activeListLength, activeSuggestion]);

	useEffect(() => {
		const clampToViewport = () => {
			const dockHeight = composerDockRef.current?.getBoundingClientRect().height;
			const textareaHeight = inputRef.current?.getBoundingClientRect().height;
			const fixedChrome =
				dockHeight === undefined || textareaHeight === undefined
					? COMPOSER_FIXED_CHROME_FALLBACK
					: Math.max(0, dockHeight - textareaHeight);
			const maximum = availableComposerInputHeight(fixedChrome);
			setMaximumInputHeight(maximum);
			setInputHeight((current) => clampComposerInputHeight(current, maximum));
		};
		const observer = new ResizeObserver(clampToViewport);
		if (composerDockRef.current) observer.observe(composerDockRef.current);
		clampToViewport();
		window.addEventListener("resize", clampToViewport);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", clampToViewport);
		};
	}, []);

	useEffect(() => {
		const resetDrag = () => setDragging(dropTrackerRef.current.reset());
		window.addEventListener("dragend", resetDrag);
		window.addEventListener("drop", resetDrag);
		window.addEventListener("blur", resetDrag);
		return () => {
			window.removeEventListener("dragend", resetDrag);
			window.removeEventListener("drop", resetDrag);
			window.removeEventListener("blur", resetDrag);
		};
	}, []);

	const submit = () => {
		const value = prompt.trim();
		if (!value || isBusy) return;
		const [invocation, ...args] = value.split(/\s+/u);
		const command = commands.find((candidate) => candidate.invocation === invocation);
		if (command) {
			if (command.disabledReason) {
				window.dispatchEvent(
					new CustomEvent("pi-notice", {
						detail: { level: "warning", message: command.disabledReason },
					}),
				);
				return;
			}
			postIntent({
				type: "invokeCommand",
				chatId,
				invocation: command.invocation,
				args: args.join(" "),
			});
		} else {
			postIntent({
				type: "sendPrompt",
				chatId,
				text: value,
				contextIds: context.map((item) => item.id),
			});
		}
		promptSignal.value = "";
		setCursor(0);
	};

	const selectCommand = (command: CommandSuggestion) => {
		if (command.disabledReason) return;
		promptSignal.value = `${command.invocation} `;
		requestAnimationFrame(() => {
			inputRef.current?.focus();
			inputRef.current?.setSelectionRange(promptSignal.value.length, promptSignal.value.length);
		});
	};

	const selectFile = (suggestion: FileSuggestion) => {
		postIntent({ type: "addSuggestedContext", suggestionId: suggestion.id });
		const before = prompt.slice(0, cursor).replace(/@[^\s]*$/u, "");
		const after = prompt.slice(cursor);
		promptSignal.value = `${before}${after}`;
		requestAnimationFrame(() => inputRef.current?.focus());
	};

	const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if ((showSlash || showFiles) && event.key === "Escape") {
			if (showSlash) promptSignal.value = prompt.replace(/^\s*\//u, "");
			else
				promptSignal.value =
					prompt.slice(0, cursor).replace(/@[^\s]*$/u, "") + prompt.slice(cursor);
			event.preventDefault();
			return;
		}
		if (activeListLength > 0 && ["ArrowDown", "ArrowUp", "Enter", "Tab"].includes(event.key)) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				setActiveSuggestion((current) =>
					event.key === "ArrowDown"
						? (current + 1) % activeListLength
						: (current - 1 + activeListLength) % activeListLength,
				);
				return;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				event.preventDefault();
				if (showSlash) {
					const selected = filteredCommands[activeSuggestion];
					if (selected) selectCommand(selected);
				} else {
					const selected = fileSuggestions[activeSuggestion];
					if (selected) selectFile(selected);
				}
				return;
			}
		}
		if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			submit();
		}
	};

	const handleDrop = (event: DragEvent<HTMLElement>) => {
		const transfer = event.dataTransfer;
		if (!transfer) return;
		const kind = classifyContextResourceDrag(transfer.types, transfer.items);
		if (kind !== "resource" && !dropTrackerRef.current.active) return;
		event.preventDefault();
		event.stopPropagation();
		setDragging(dropTrackerRef.current.reset());
		const uris = readDroppedUris(transfer);
		if (uris.length > 0) {
			postIntent({ type: "dropContext", uris: [...uris] });
			return;
		}
		window.dispatchEvent(
			new CustomEvent("pi-notice", {
				detail: {
					level: "warning",
					message:
						"ドロップしたファイルの場所を取得できませんでした。Explorerから「Ask Pi…」へもう一度ドロップするか、添付ボタンから選択してください。",
				},
			}),
		);
	};

	const handleResizePointerDown = (event: PreactPointerEvent<HTMLHRElement>) => {
		if (event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		event.currentTarget.focus();
		event.currentTarget.setPointerCapture(event.pointerId);
		resizeGestureRef.current = {
			pointerId: event.pointerId,
			startY: event.clientY,
			startHeight: inputHeight,
		};
	};

	const handleResizePointerMove = (event: PreactPointerEvent<HTMLHRElement>) => {
		const gesture = resizeGestureRef.current;
		if (!gesture || gesture.pointerId !== event.pointerId) return;
		event.preventDefault();
		const nextHeight = gesture.startHeight + gesture.startY - event.clientY;
		setInputHeight(clampComposerInputHeight(nextHeight, maximumInputHeight));
	};

	const finishResizePointer = (event: PreactPointerEvent<HTMLHRElement>) => {
		const gesture = resizeGestureRef.current;
		if (!gesture || gesture.pointerId !== event.pointerId) return;
		event.preventDefault();
		resizeGestureRef.current = null;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
	};

	const handleResizeKeyDown = (event: KeyboardEvent<HTMLHRElement>) => {
		const step = event.altKey ? 2 : event.shiftKey ? 24 : 8;
		let nextHeight: number | undefined;
		switch (event.key) {
			case "ArrowUp":
				nextHeight = inputHeight + step;
				break;
			case "ArrowDown":
				nextHeight = inputHeight - step;
				break;
			case "Home":
				nextHeight = COMPOSER_INPUT_MIN_HEIGHT;
				break;
			case "End":
				nextHeight = maximumInputHeight;
				break;
			case "Enter":
				nextHeight = COMPOSER_INPUT_DEFAULT_HEIGHT;
				break;
			default:
				return;
		}
		event.preventDefault();
		event.stopPropagation();
		setInputHeight(clampComposerInputHeight(nextHeight, maximumInputHeight));
	};

	return (
		<section ref={composerDockRef} class="composer-dock" aria-label="Message composer">
			{approvalMode === "fullAccess" ? (
				<div class="full-access-banner" role="status">
					<span aria-hidden="true">⚠</span>
					<span>
						<strong>Full Access</strong> Commands run without individual confirmation and may reach
						files, secrets, network, or locations outside this workspace. Their internal effects
						cannot be fully detected.
					</span>
				</div>
			) : null}
			<form
				class={`prompt-shell ${dragging ? "composer-drop-active" : ""}`}
				aria-label="Prompt and attached files"
				aria-describedby="pi-context-drop-help"
				data-context-drop-target="composer"
				onSubmit={(event) => {
					event.preventDefault();
					submit();
				}}
				onDragEnter={(event) => {
					const transfer = event.dataTransfer;
					if (!transfer) return;
					const kind = classifyContextResourceDrag(transfer.types, transfer.items);
					if (kind !== "resource") return;
					event.preventDefault();
					event.stopPropagation();
					transfer.dropEffect = "copy";
					setDragging(dropTrackerRef.current.enter(kind));
				}}
				onDragOver={(event) => {
					const transfer = event.dataTransfer;
					if (!transfer) return;
					const kind = classifyContextResourceDrag(transfer.types, transfer.items);
					if (kind !== "resource" && !dropTrackerRef.current.active) return;
					event.preventDefault();
					event.stopPropagation();
					transfer.dropEffect = "copy";
					setDragging(dropTrackerRef.current.over(kind));
				}}
				onDragLeave={(event) => {
					if (!dropTrackerRef.current.active) return;
					event.stopPropagation();
					const relatedTarget = event.relatedTarget;
					const insideByTarget =
						relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget);
					const bounds = event.currentTarget.getBoundingClientRect();
					const insideByPoint =
						event.clientX >= bounds.left &&
						event.clientX <= bounds.right &&
						event.clientY >= bounds.top &&
						event.clientY <= bounds.bottom;
					setDragging(dropTrackerRef.current.leave(insideByTarget || insideByPoint));
				}}
				onDragEnd={(event) => {
					event.stopPropagation();
					setDragging(dropTrackerRef.current.reset());
				}}
				onDrop={handleDrop}
			>
				<hr
					class="composer-resize-handle"
					tabIndex={0}
					aria-label="メッセージ入力欄の高さを変更"
					aria-controls="pi-prompt"
					aria-orientation="horizontal"
					aria-valuemin={COMPOSER_INPUT_MIN_HEIGHT}
					aria-valuemax={maximumInputHeight}
					aria-valuenow={inputHeight}
					aria-valuetext={`${inputHeight}ピクセル`}
					title="上下にドラッグ、または上下矢印キーで入力欄の高さを変更"
					onPointerDown={handleResizePointerDown}
					onPointerMove={handleResizePointerMove}
					onPointerUp={finishResizePointer}
					onPointerCancel={finishResizePointer}
					onLostPointerCapture={() => {
						resizeGestureRef.current = null;
					}}
					onDblClick={() =>
						setInputHeight(
							clampComposerInputHeight(COMPOSER_INPUT_DEFAULT_HEIGHT, maximumInputHeight),
						)
					}
					onKeyDown={handleResizeKeyDown}
				/>
				{dragging ? (
					<div class="composer-drop-overlay" role="status" aria-live="polite" aria-atomic="true">
						<span aria-hidden="true">＋</span>
						<span>
							<strong>ここにドロップして添付</strong>
							<small>ファイルやフォルダーを会話に追加します</small>
						</span>
					</div>
				) : null}
				{context.length > 0 ? (
					<fieldset class="chip-row composer-chips">
						<legend class="sr-only">Attached context</legend>
						{context.map((chip) => (
							<span class="context-chip" key={chip.id}>
								<span aria-hidden="true">
									{chip.kind === "selection" ? "⌗" : chip.kind === "folder" ? "▣" : "▤"}
								</span>
								<span class="chip-label" title={chip.label}>
									{chip.label}
								</span>
								<button
									type="button"
									aria-label={`Remove ${chip.label}`}
									onClick={() => postIntent({ type: "removeContext", id: chip.id })}
								>
									×
								</button>
							</span>
						))}
					</fieldset>
				) : null}
				<ComposerSuggestions
					commandQuery={slash}
					showFiles={showFiles}
					commands={filteredCommands}
					files={fileSuggestions}
					activeIndex={activeSuggestion}
					onActiveIndexChange={setActiveSuggestion}
					onCommand={selectCommand}
					onFile={selectFile}
				/>
				<textarea
					ref={inputRef}
					id="pi-prompt"
					value={prompt}
					rows={3}
					role="combobox"
					aria-label="Ask Pi"
					aria-describedby="pi-context-drop-help"
					aria-autocomplete="list"
					aria-expanded={Boolean(suggestionListId)}
					aria-controls={suggestionListId}
					aria-activedescendant={activeOptionId}
					placeholder="Ask Pi…"
					disabled={false}
					style={{ height: `${inputHeight}px` }}
					onInput={(event) => {
						promptSignal.value = event.currentTarget.value;
						setCursor(event.currentTarget.selectionStart ?? event.currentTarget.value.length);
					}}
					onClick={(event) => setCursor(event.currentTarget.selectionStart ?? prompt.length)}
					onKeyUp={(event) => setCursor(event.currentTarget.selectionStart ?? prompt.length)}
					onKeyDown={handleKeyDown}
				/>
				<p id="pi-context-drop-help" class="sr-only">
					ファイルやフォルダーは、この入力フォームへドロップして会話に添付できます。
				</p>
				<div class="input-hint">
					<kbd>/</kbd> commands · <kbd>@</kbd> files · drag files here
				</div>
				{isBusy ? (
					<div class="sr-only" id="pi-mode-locked" role="status">
						Piの実行中は操作モードを変更できません。
					</div>
				) : null}
				<div class="composer-actions">
					<div class="composer-left-actions">
						<button
							class="icon-button"
							type="button"
							title="Add context"
							aria-label="Add context"
							onClick={() => postIntent({ type: "pickContext", kind: "any" })}
						>
							⌕
						</button>
						<ComposerModeControl
							chatId={chatId}
							approvalMode={approvalMode}
							trusted={trusted}
							busy={isBusy}
						/>
					</div>
					<div class="composer-right-actions">
						<ComposerSessionControls
							key={chatId}
							chatId={chatId}
							phase={phase}
							model={model}
							usage={usage}
						/>
						{isBusy ? (
							<button
								type="button"
								class="stop-button"
								title="Stop current response"
								aria-label="Stop current response"
								onClick={() => postIntent({ type: "stop", chatId })}
							>
								<span aria-hidden="true">■</span>
								<span class="stop-label">Stop</span>
							</button>
						) : (
							<button
								class="send-button"
								type="button"
								disabled={!prompt.trim()}
								aria-label="Send message"
								onClick={submit}
							>
								<span aria-hidden="true">➤</span>
							</button>
						)}
					</div>
				</div>
			</form>
		</section>
	);
}
