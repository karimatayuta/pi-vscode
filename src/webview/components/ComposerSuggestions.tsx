import type { CommandSuggestion, FileSuggestion } from "../types.js";

interface ComposerSuggestionsProps {
	readonly commandQuery: string | undefined;
	readonly showFiles: boolean;
	readonly commands: readonly CommandSuggestion[];
	readonly files: readonly FileSuggestion[];
	readonly activeIndex: number;
	readonly onActiveIndexChange: (index: number) => void;
	readonly onCommand: (command: CommandSuggestion) => void;
	readonly onFile: (file: FileSuggestion) => void;
}

export function ComposerSuggestions({
	commandQuery,
	showFiles,
	commands,
	files,
	activeIndex,
	onActiveIndexChange,
	onCommand,
	onFile,
}: ComposerSuggestionsProps) {
	if (commandQuery !== undefined) {
		return (
			<div
				id="pi-command-suggestions"
				class="suggestion-popover"
				role="listbox"
				aria-label="Commands and agent skills"
			>
				<header>
					<strong>Commands &amp; agent skills</strong>
					<span>Esc to close</span>
				</header>
				<div class="suggestion-list">
					{commands.length === 0 ? (
						<div class="empty-row">No available command matches “{commandQuery}”.</div>
					) : null}
					{commands.map((command, index) => (
						<button
							type="button"
							role="option"
							aria-selected={index === activeIndex}
							class={index === activeIndex ? "selected" : ""}
							id={`pi-command-suggestions-${index}`}
							key={command.id}
							disabled={Boolean(command.disabledReason)}
							onMouseEnter={() => onActiveIndexChange(index)}
							onClick={() => onCommand(command)}
						>
							<span class="command-name">{command.invocation}</span>
							<span class="command-description">
								{command.disabledReason ?? command.description}
							</span>
							<span class={`kind-badge ${command.kind}`}>{command.kind}</span>
							{index === activeIndex ? <kbd>Enter</kbd> : null}
						</button>
					))}
				</div>
				<footer>
					↑↓ Navigate <span>Enter Select</span>
				</footer>
			</div>
		);
	}

	if (!showFiles) return null;
	return (
		<div
			id="pi-file-suggestions"
			class="suggestion-popover"
			role="listbox"
			aria-label="Workspace files"
		>
			<header>
				<strong>Add context</strong>
				<span>Esc to close</span>
			</header>
			<div class="suggestion-list">
				{files.length === 0 ? <div class="empty-row">Searching workspace…</div> : null}
				{files.map((file, index) => (
					<button
						type="button"
						role="option"
						aria-selected={index === activeIndex}
						class={index === activeIndex ? "selected" : ""}
						id={`pi-file-suggestions-${index}`}
						key={file.id}
						onMouseEnter={() => onActiveIndexChange(index)}
						onClick={() => onFile(file)}
					>
						<span class="command-name">
							{file.kind === "folder" ? "▣" : "▤"} {file.label}
						</span>
						<span class="command-description">{file.description}</span>
					</button>
				))}
			</div>
		</div>
	);
}
