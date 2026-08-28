import type { KeyboardEvent } from "preact/compat";
import { useEffect, useRef, useState } from "preact/hooks";
import { postIntent } from "../bridge.js";
import type { ApprovalMode } from "../types.js";

interface ModeOption {
	readonly mode: ApprovalMode;
	readonly label: string;
	readonly icon: string;
	readonly description: string;
	readonly warning?: boolean;
}

const ASK_MODE: ModeOption = {
	mode: "ask",
	label: "Ask",
	icon: "◆",
	description: "編集やコマンドを実行する前に確認します",
};

const MODES: readonly ModeOption[] = [
	{
		mode: "plan",
		label: "Plan",
		icon: "▤",
		description: "読み取りと計画のみ。編集とコマンド実行はブロックします",
	},
	ASK_MODE,
	{
		mode: "autoEdit",
		label: "Auto Edit",
		icon: "✎",
		description: "ワークスペース内の編集と通常のコマンド実行は自動。削除や高リスク操作は確認します",
	},
	{
		mode: "fullAccess",
		label: "Full Access",
		icon: "⚠",
		description:
			"コマンドを確認なしで実行します。ワークスペース外・ネットワーク・機密情報にも到達し得ます",
		warning: true,
	},
];

interface ComposerModeControlProps {
	readonly chatId: string;
	readonly approvalMode: ApprovalMode;
	readonly trusted: boolean;
	readonly busy: boolean;
}

export function ComposerModeControl({
	chatId,
	approvalMode,
	trusted,
	busy,
}: ComposerModeControlProps) {
	const [menuOpen, setMenuOpen] = useState(false);
	const [confirmFullAccess, setConfirmFullAccess] = useState(false);
	const controlRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const cancelFullAccessRef = useRef<HTMLButtonElement>(null);
	const currentMode = MODES.find((entry) => entry.mode === approvalMode) ?? ASK_MODE;

	useEffect(() => {
		if (busy) setConfirmFullAccess(false);
	}, [busy]);

	useEffect(() => {
		if (!menuOpen) return undefined;
		const frame = window.requestAnimationFrame(() => {
			const menu = menuRef.current;
			const selected = menu?.querySelector<HTMLButtonElement>(
				'[role="menuitemradio"][aria-checked="true"]:not(:disabled)',
			);
			const option =
				selected ?? menu?.querySelector<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)');
			if (option) option.focus();
			else menu?.focus();
		});
		const closeFromPointer = (event: PointerEvent) => {
			if (!controlRef.current?.contains(event.target as Node)) setMenuOpen(false);
		};
		window.addEventListener("pointerdown", closeFromPointer);
		return () => {
			window.cancelAnimationFrame(frame);
			window.removeEventListener("pointerdown", closeFromPointer);
		};
	}, [menuOpen]);

	useEffect(() => {
		if (!confirmFullAccess) return undefined;
		const frame = window.requestAnimationFrame(() => cancelFullAccessRef.current?.focus());
		return () => window.cancelAnimationFrame(frame);
	}, [confirmFullAccess]);

	const restoreButtonFocus = () => {
		window.requestAnimationFrame(() => buttonRef.current?.focus());
	};

	const closeFullAccessConfirmation = () => {
		setConfirmFullAccess(false);
		restoreButtonFocus();
	};

	const chooseMode = (mode: ApprovalMode) => {
		if (busy) return;
		if (mode === "fullAccess") {
			setMenuOpen(false);
			setConfirmFullAccess(true);
			return;
		}
		postIntent({ type: "setApprovalMode", chatId, mode });
		setMenuOpen(false);
		restoreButtonFocus();
	};

	const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			setMenuOpen(false);
			restoreButtonFocus();
			return;
		}
		if (event.key === "Tab") {
			setMenuOpen(false);
			return;
		}
		if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
		const items = [
			...event.currentTarget.querySelectorAll<HTMLButtonElement>(
				'[role="menuitemradio"]:not(:disabled)',
			),
		];
		if (items.length === 0) return;
		event.preventDefault();
		const current = items.indexOf(document.activeElement as HTMLButtonElement);
		const next =
			event.key === "Home"
				? 0
				: event.key === "End"
					? items.length - 1
					: event.key === "ArrowDown"
						? current < 0
							? 0
							: (current + 1) % items.length
						: current <= 0
							? items.length - 1
							: current - 1;
		items[next]?.focus();
	};

	const handleConfirmationKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			closeFullAccessConfirmation();
			return;
		}
		if (event.key !== "Tab") return;
		const buttons = [
			...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
		];
		if (buttons.length === 0) return;
		const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
		const next = event.shiftKey
			? current <= 0
				? buttons.length - 1
				: current - 1
			: current < 0 || current >= buttons.length - 1
				? 0
				: current + 1;
		event.preventDefault();
		buttons[next]?.focus();
	};

	return (
		<div ref={controlRef} class="mode-control">
			<button
				ref={buttonRef}
				class={`mode-pill ${approvalMode}`}
				type="button"
				aria-haspopup="menu"
				aria-expanded={menuOpen}
				aria-label={`現在の操作モード: ${currentMode.label}。クリックして選択`}
				aria-describedby={busy ? "pi-mode-locked" : undefined}
				title={busy ? "操作モードを表示（変更はPiの実行中ロックされています）" : "操作モードを変更"}
				onClick={() => {
					setConfirmFullAccess(false);
					setMenuOpen(!menuOpen);
				}}
			>
				<span aria-hidden="true">{currentMode.icon}</span>
				<span class="mode-label">{currentMode.label}</span>
				<span class="mode-chevron" aria-hidden="true">
					▾
				</span>
			</button>
			{menuOpen ? (
				<div
					ref={menuRef}
					class="popover mode-popover"
					role="menu"
					tabIndex={-1}
					aria-label="操作モードを選択"
					onKeyDown={handleMenuKeyDown}
				>
					<div class="popover-heading">
						<span>
							<strong>操作モード</strong>
							<small class="scope-badge">このチャット</small>
						</span>
					</div>
					<p class="mode-help">Piにどこまで操作を任せるか選択できます。</p>
					{busy ? (
						<p class="inline-warning mode-lock-message">
							実行中は変更できません。完了を待つか、停止してから選択してください。
						</p>
					) : null}
					{MODES.map((entry) => (
						<button
							type="button"
							role="menuitemradio"
							aria-checked={entry.mode === approvalMode}
							tabIndex={-1}
							class={`mode-option ${entry.mode === approvalMode ? "selected" : ""} ${entry.warning ? "warning" : ""}`}
							key={entry.mode}
							disabled={busy || (!trusted && entry.mode !== "plan")}
							onClick={() => chooseMode(entry.mode)}
						>
							<span class="mode-icon" aria-hidden="true">
								{entry.icon}
							</span>
							<span>
								<strong>{entry.label}</strong>
								<small>
									{!trusted && entry.mode !== "plan"
										? "ワークスペースを信頼すると選択できます"
										: entry.description}
								</small>
							</span>
							{entry.mode === approvalMode ? <span aria-hidden="true">✓</span> : null}
						</button>
					))}
				</div>
			) : null}
			{confirmFullAccess ? (
				<div
					class="popover full-confirm"
					role="alertdialog"
					aria-modal="true"
					aria-labelledby="pi-full-access-title"
					aria-describedby="pi-full-access-description"
					onKeyDown={handleConfirmationKeyDown}
				>
					<strong id="pi-full-access-title">このセッションでFull Accessを有効にしますか？</strong>
					<p id="pi-full-access-description">
						PiはVS Codeプロセスと同じ権限で、コマンドを個別確認なしで実行します。
						コマンド内部の影響範囲は完全には判定できず、ワークスペース外、ネットワーク、
						機密情報へ到達し得ます。
					</p>
					<div class="popover-actions">
						<button ref={cancelFullAccessRef} type="button" onClick={closeFullAccessConfirmation}>
							キャンセル
						</button>
						<button
							class="full-access-button"
							type="button"
							onClick={() => {
								postIntent({ type: "setApprovalMode", chatId, mode: "fullAccess" });
								setConfirmFullAccess(false);
								restoreButtonFocus();
							}}
						>
							このセッションで有効化
						</button>
					</div>
				</div>
			) : null}
		</div>
	);
}
