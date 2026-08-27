import { PiHostError } from "./errors.js";
import { redactString } from "./sanitize.js";
import type { PiCommandDto, PiCommandKind } from "./types.js";

const VALID_INVOCATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_ARGUMENT_LENGTH = 64 * 1024;
const MAX_COMMAND_CATALOG = 4_096;

export interface ExtensionCommandSource {
	readonly invocationName: string;
	readonly description?: string;
	readonly getArgumentCompletions?: unknown;
}

export interface PromptCommandSource {
	readonly name: string;
	readonly description?: string;
}

export interface SkillCommandSource {
	readonly name: string;
	readonly description?: string;
}

export interface PiCommandSources {
	readonly extensions?: readonly ExtensionCommandSource[];
	readonly prompts?: readonly PromptCommandSource[];
	readonly skills?: readonly SkillCommandSource[];
}

function addCommands(
	output: PiCommandDto[],
	seen: Set<string>,
	kind: PiCommandKind,
	commands: readonly {
		readonly invocation: string;
		readonly description?: string;
		readonly completions?: boolean;
	}[],
): void {
	for (const command of commands) {
		if (output.length >= MAX_COMMAND_CATALOG) return;
		if (!VALID_INVOCATION.test(command.invocation) || seen.has(command.invocation)) {
			continue;
		}
		seen.add(command.invocation);
		output.push({
			invocation: command.invocation,
			kind,
			...(command.description ? { description: redactString(command.description, 2_048) } : {}),
			hasArgumentCompletions: command.completions === true,
		});
	}
}

/** Matches Pi's dispatch priority: extension command, prompt template, then /skill:name. */
export function buildCommandCatalog(sources: PiCommandSources): PiCommandDto[] {
	const output: PiCommandDto[] = [];
	const seen = new Set<string>();
	addCommands(
		output,
		seen,
		"extension",
		(sources.extensions ?? []).slice(0, MAX_COMMAND_CATALOG).map((command) => ({
			invocation: command.invocationName,
			...(command.description === undefined ? {} : { description: command.description }),
			completions: typeof command.getArgumentCompletions === "function",
		})),
	);
	addCommands(
		output,
		seen,
		"prompt",
		(sources.prompts ?? []).slice(0, MAX_COMMAND_CATALOG).map((command) => ({
			invocation: command.name,
			...(command.description === undefined ? {} : { description: command.description }),
		})),
	);
	addCommands(
		output,
		seen,
		"skill",
		(sources.skills ?? []).slice(0, MAX_COMMAND_CATALOG).map((command) => ({
			invocation: `skill:${command.name}`,
			...(command.description === undefined ? {} : { description: command.description }),
		})),
	);
	return output;
}

export function buildCommandPrompt(
	catalog: readonly PiCommandDto[],
	invocation: string,
	args?: string,
): string {
	if (
		!VALID_INVOCATION.test(invocation) ||
		!catalog.some((command) => command.invocation === invocation)
	) {
		throw new PiHostError(
			"unknown_command",
			`Unknown Pi command: ${redactString(invocation, 256)}`,
		);
	}
	const normalizedArgs = args?.trim();
	if (normalizedArgs && normalizedArgs.length > MAX_ARGUMENT_LENGTH) {
		throw new PiHostError("command_arguments_too_large", "Pi command arguments are too large.");
	}
	return `/${invocation}${normalizedArgs ? ` ${normalizedArgs}` : ""}`;
}
