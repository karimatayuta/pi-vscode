import type {
	PiSessionPhase,
	PiSessionSnapshotDto,
	PiStreamDeltaDto,
	PiToolEventDto,
} from "../pi/types.js";

const MAX_ACTIVITY_LENGTH = 96;
const MAX_LABEL_LENGTH = 44;

export type ToolActivityPhase = "start" | "update" | "end";

function truncate(value: string, maxLength: number): string {
	const characters = [...value];
	if (characters.length <= maxLength) return value;
	return `${characters
		.slice(0, Math.max(1, maxLength - 1))
		.join("")
		.trimEnd()}…`;
}

function stripUnsafeText(value: string): string {
	const withoutControls = [...value.normalize("NFKC")]
		.map((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			const unsafe =
				codePoint <= 0x1f ||
				(codePoint >= 0x7f && codePoint <= 0x9f) ||
				(codePoint >= 0x200b && codePoint <= 0x200f) ||
				(codePoint >= 0x202a && codePoint <= 0x202e) ||
				(codePoint >= 0x2066 && codePoint <= 0x2069) ||
				codePoint === 0xfeff;
			return unsafe ? " " : character;
		})
		.join("");
	return withoutControls
		.replace(
			/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/giu,
			"[機密情報]",
		)
		.replace(/\b(?:sk|pk|token|secret)[-_][A-Za-z0-9_-]{8,}\b/giu, "[機密情報]")
		.replace(/\s+/gu, " ")
		.trim();
}

function boundedActivity(value: string): string {
	const safe = stripUnsafeText(value);
	return truncate(safe || "ご依頼の内容を確認しています", MAX_ACTIVITY_LENGTH);
}

function safeFocus(value: string): string {
	return taskFocusFromUserText(value);
}

function stringArgument(args: PiToolEventDto["args"], key: string): string | undefined {
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
	const value = (args as { readonly [key: string]: PiToolEventDto["args"] })[key];
	return typeof value === "string" ? value : undefined;
}

function safePathLabel(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const normalized = stripUnsafeText(value)
		.replace(/[?#].*$/u, "")
		.replace(/^["'`]+|["'`]+$/gu, "")
		.replace(/\\/gu, "/")
		.replace(/\/{2,}/gu, "/")
		.replace(/\/$/u, "");
	if (!normalized) return undefined;
	const parts = normalized.split("/").filter(Boolean);
	const label = parts.slice(-2).join("/") || normalized;
	return truncate(label, MAX_LABEL_LENGTH);
}

function normalizedToolName(value: string): string {
	return stripUnsafeText(value)
		.toLocaleLowerCase("en-US")
		.replace(/^.*[.:/]/u, "");
}

function commandActivity(
	command: string | undefined,
	focus: string,
	phase: ToolActivityPhase,
): string {
	if (!command) {
		return phase === "end"
			? `${focus}の実行結果を確認しています`
			: `${focus}に必要な処理を実行しています`;
	}
	const normalized = stripUnsafeText(command).toLocaleLowerCase("en-US");
	if (/\b(?:bun|npm|pnpm|yarn|deno)?\s*(?:run\s+)?(?:test|vitest|jest)\b/u.test(normalized)) {
		return phase === "end"
			? `${focus}のテスト結果を確認しています`
			: `${focus}のテストを実行しています`;
	}
	if (/\b(?:biome|eslint|stylelint|lint)\b/u.test(normalized)) {
		return "コード品質を確認しています";
	}
	if (/\b(?:tsc|typecheck|type-check)\b/u.test(normalized)) {
		return "型の整合性を確認しています";
	}
	if (/\b(?:build|compile|vite|webpack|esbuild)\b/u.test(normalized)) {
		return phase === "end" ? "ビルド結果を確認しています" : "変更後のビルドを確認しています";
	}
	if (/\bgit\s+(?:diff|status|show)\b/u.test(normalized)) {
		return "変更内容を確認しています";
	}
	if (/\b(?:rg|grep|find|fd)\b/u.test(normalized)) {
		return `${focus}に関連するコードを検索しています`;
	}
	if (/\b(?:cat|sed|head|tail|less)\b/u.test(normalized)) {
		return `${focus}に関連するファイルを確認しています`;
	}
	return phase === "end"
		? `${focus}の実行結果を確認しています`
		: `${focus}に必要な処理を実行しています`;
}

/**
 * Converts a user request into a deliberately small, non-sensitive topic label.
 * This is a rule-based classifier, not a transcript or chain-of-thought summary.
 */
export function taskFocusFromUserText(value: string): string {
	const text = stripUnsafeText(value).toLocaleLowerCase();
	if (!text) return "ご依頼";
	if (/(?:認証|ログイン|サインイン|oauth|authentication|auth\b|login|token)/u.test(text)) {
		return "認証処理";
	}
	if (/(?:ドラッグ|ドロップ|添付|コンテキスト|drag|drop|attachment|context)/u.test(text)) {
		return "ファイル添付";
	}
	if (/(?:ui|ux|画面|表示|デザイン|レイアウト|チャット|webview|cursor|claude)/u.test(text)) {
		return "チャット画面";
	}
	if (/(?:テスト|検証|test|spec|vitest|jest)/u.test(text)) return "テスト";
	if (/(?:エラー|不具合|バグ|修正|直して|error|bug|fix)/u.test(text)) return "問題箇所";
	if (/(?:api|通信|リクエスト|endpoint|fetch)/u.test(text)) return "API連携";
	if (/(?:速度|性能|軽量|パフォーマンス|performance|latency)/u.test(text)) return "性能";
	if (/(?:設定|config|configuration|settings)/u.test(text)) return "設定";
	if (/(?:readme|文書|ドキュメント|documentation|docs)/u.test(text)) return "ドキュメント";
	return "ご依頼";
}

export function summarizeToolActivity(
	tool: Pick<PiToolEventDto, "toolName" | "args" | "isError">,
	focus: string,
	phase: ToolActivityPhase,
): string {
	const subject = safeFocus(focus);
	const name = normalizedToolName(tool.toolName);
	const path = safePathLabel(stringArgument(tool.args, "path"));
	const command = stringArgument(tool.args, "command");

	if (phase === "end" && tool.isError) {
		return boundedActivity(
			path ? `${path} で発生した問題を確認しています` : `${subject}の問題を確認しています`,
		);
	}

	let summary: string;
	if (["read", "read_file", "open", "view"].includes(name)) {
		summary =
			phase === "end"
				? path
					? `${path} の確認結果を整理しています`
					: `${subject}に関連するファイルの確認結果を整理しています`
				: path
					? `${path} を確認しています`
					: `${subject}に関連するファイルを確認しています`;
	} else if (["grep", "search", "find", "glob", "ripgrep"].includes(name)) {
		summary =
			phase === "end"
				? `${subject}に関する検索結果を整理しています`
				: path
					? `${path} から関連コードを検索しています`
					: `${subject}に関連するコードを検索しています`;
	} else if (["ls", "list", "tree"].includes(name)) {
		summary =
			phase === "end"
				? "プロジェクト構成の確認結果を整理しています"
				: path
					? `${path} の構成を確認しています`
					: "プロジェクトの構成を確認しています";
	} else if (["edit", "write", "apply_patch", "patch", "create_file"].includes(name)) {
		summary =
			phase === "end"
				? path
					? `${path} の変更内容を確認しています`
					: `${subject}に関連する変更内容を確認しています`
				: path
					? `${path} を修正しています`
					: `${subject}に関連するコードを修正しています`;
	} else if (["bash", "shell", "powershell", "exec", "exec_command"].includes(name)) {
		summary = commandActivity(command, subject, phase);
	} else if (["test", "run_tests"].includes(name)) {
		summary = `${subject}のテストを実行しています`;
	} else if (["web", "fetch", "browse", "search_web"].includes(name)) {
		summary = `${subject}に必要な情報を確認しています`;
	} else {
		summary =
			phase === "end" ? `${subject}の処理結果を確認しています` : `${subject}の作業を進めています`;
	}
	return boundedActivity(summary);
}

export function summarizeStreamActivity(
	delta: Pick<PiStreamDeltaDto, "kind" | "toolName">,
	focus: string,
): string {
	const subject = safeFocus(focus);
	if (delta.kind === "text") return boundedActivity(`${subject}について回答をまとめています`);
	if (delta.kind === "tool" && delta.toolName) {
		return summarizeToolActivity({ toolName: delta.toolName }, subject, "start");
	}
	if (delta.kind === "tool") return boundedActivity(`${subject}に必要な操作を準備しています`);
	if (delta.kind === "status") return boundedActivity(`${subject}の作業状況を確認しています`);
	// Intentionally ignore delta.text. It can contain private chain-of-thought.
	return boundedActivity(`${subject}の進め方を整理しています`);
}

export function summarizeSessionActivity(phase: PiSessionPhase, focus: string): string {
	const subject = safeFocus(focus);
	if (phase === "compacting") return "会話のコンテキストを整理しています";
	if (phase === "retrying") return "一時的な問題から処理を再開しています";
	if (phase === "streaming") return boundedActivity(`${subject}について回答をまとめています`);
	if (phase === "running") return boundedActivity(`${subject}の進め方を整理しています`);
	if (phase === "tool") return boundedActivity(`${subject}に必要な操作を進めています`);
	if (phase === "closing") return "セッションを終了しています";
	return "待機中";
}

export function summarizeSnapshotActivity(snapshot: PiSessionSnapshotDto, focus: string): string {
	if (snapshot.phase === "tool" && snapshot.activeTools[0]) {
		return summarizeToolActivity({ toolName: snapshot.activeTools[0] }, focus, "update");
	}
	return summarizeSessionActivity(snapshot.phase, focus);
}
