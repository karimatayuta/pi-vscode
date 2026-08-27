import * as v from "valibot";
import { ApprovalModeSchema } from "./approval.js";
import { ViewDesignSchema } from "./view-design.js";

export const PROTOCOL_VERSION = 1 as const;

const IdSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(256));
const LabelSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(512));
const MessageTextSchema = v.pipe(v.string(), v.maxLength(1_000_000));
const NonNegativeIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const ClientEnvelopeEntries = {
	protocolVersion: v.literal(PROTOCOL_VERSION),
	requestId: IdSchema,
};
const HostEnvelopeEntries = ClientEnvelopeEntries;

export const ChatPhaseSchema = v.picklist(["idle", "running", "waitingApproval", "error"] as const);
export type ChatPhase = v.InferOutput<typeof ChatPhaseSchema>;

export const ThinkingLevelSchema = v.picklist([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const);
export type ThinkingLevel = v.InferOutput<typeof ThinkingLevelSchema>;

export const ChatTabSchema = v.object({
	id: IdSchema,
	title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
	phase: ChatPhaseSchema,
	progress: v.pipe(v.string(), v.maxLength(512)),
	unread: v.boolean(),
	manualTitle: v.boolean(),
});
export type ChatTab = v.InferOutput<typeof ChatTabSchema>;

export const ContextChipSchema = v.object({
	id: IdSchema,
	label: LabelSchema,
	kind: v.picklist(["file", "folder", "selection"] as const),
});
export type ContextChip = v.InferOutput<typeof ContextChipSchema>;

export const ToolItemSchema = v.object({
	id: IdSchema,
	label: LabelSchema,
	detail: v.optional(v.pipe(v.string(), v.maxLength(100_000))),
	phase: v.picklist(["queued", "running", "success", "error", "cancelled"] as const),
});
export type ToolItem = v.InferOutput<typeof ToolItemSchema>;

export const ProposedEditSchema = v.object({
	id: IdSchema,
	path: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(8_192)),
	patch: MessageTextSchema,
	additions: NonNegativeIntegerSchema,
	deletions: NonNegativeIntegerSchema,
	status: v.literal("applied"),
});
export type ProposedEdit = v.InferOutput<typeof ProposedEditSchema>;

export const ReferenceDescriptorSchema = v.object({
	refId: IdSchema,
	epoch: IdSchema,
	label: LabelSchema,
	kind: v.picklist(["external", "file", "folder"] as const),
	ariaLabel: LabelSchema,
});
export type ReferenceDescriptor = v.InferOutput<typeof ReferenceDescriptorSchema>;

export const ChatMessageSchema = v.object({
	id: IdSchema,
	role: v.picklist(["user", "assistant", "system", "error"] as const),
	text: MessageTextSchema,
	timestamp: v.pipe(v.number(), v.integer(), v.minValue(0)),
	streaming: v.optional(v.boolean()),
	thought: v.optional(v.pipe(v.string(), v.maxLength(512_000))),
	contexts: v.optional(v.pipe(v.array(ContextChipSchema), v.maxLength(256))),
	tools: v.optional(v.pipe(v.array(ToolItemSchema), v.maxLength(10_000))),
	edits: v.optional(v.pipe(v.array(ProposedEditSchema), v.maxLength(1_000))),
	references: v.optional(v.pipe(v.array(ReferenceDescriptorSchema), v.maxLength(2_000))),
	retryable: v.optional(v.boolean()),
});
export type ChatMessage = v.InferOutput<typeof ChatMessageSchema>;

export const UsageStateSchema = v.object({
	contextTokens: v.nullable(NonNegativeIntegerSchema),
	contextWindow: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
	contextPercent: v.nullable(v.pipe(v.number(), v.minValue(0), v.maxValue(100))),
	input: NonNegativeIntegerSchema,
	output: NonNegativeIntegerSchema,
	cacheRead: NonNegativeIntegerSchema,
	cacheWrite: NonNegativeIntegerSchema,
	total: NonNegativeIntegerSchema,
	cost: v.nullable(v.pipe(v.number(), v.minValue(0))),
	costKind: v.picklist(["estimated", "subscription", "unknown"] as const),
});
export type UsageState = v.InferOutput<typeof UsageStateSchema>;

export const ModelOptionSchema = v.object({
	provider: IdSchema,
	id: IdSchema,
	name: LabelSchema,
	contextWindow: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
	supportsImages: v.optional(v.boolean()),
	thinkingLevels: v.array(ThinkingLevelSchema),
});
export type ModelOption = v.InferOutput<typeof ModelOptionSchema>;

export const ModelStateSchema = v.object({
	provider: v.optional(IdSchema),
	id: v.optional(IdSchema),
	name: LabelSchema,
	thinking: ThinkingLevelSchema,
	options: v.pipe(v.array(ModelOptionSchema), v.maxLength(10_000)),
	loading: v.boolean(),
	authError: v.optional(v.pipe(v.string(), v.maxLength(8_192))),
});
export type ModelState = v.InferOutput<typeof ModelStateSchema>;

export const CommandSuggestionSchema = v.object({
	id: IdSchema,
	invocation: LabelSchema,
	kind: v.picklist(["host", "extension", "prompt", "skill"] as const),
	description: v.pipe(v.string(), v.maxLength(2_048)),
	source: v.optional(v.pipe(v.string(), v.maxLength(512))),
	disabledReason: v.optional(v.pipe(v.string(), v.maxLength(2_048))),
});
export type CommandSuggestion = v.InferOutput<typeof CommandSuggestionSchema>;

export const FileSuggestionSchema = v.object({
	id: IdSchema,
	label: LabelSchema,
	description: v.optional(v.pipe(v.string(), v.maxLength(2_048))),
	kind: v.picklist(["file", "folder"] as const),
});
export type FileSuggestion = v.InferOutput<typeof FileSuggestionSchema>;

export const ApprovalRequestSchema = v.object({
	id: IdSchema,
	chatId: IdSchema,
	capability: IdSchema,
	title: LabelSchema,
	detail: v.pipe(v.string(), v.maxLength(100_000)),
	risk: v.picklist(["normal", "sensitive", "dangerous"] as const),
	command: v.optional(v.pipe(v.string(), v.maxLength(100_000))),
	cwd: v.optional(v.pipe(v.string(), v.maxLength(8_192))),
	targets: v.optional(v.pipe(v.array(v.pipe(v.string(), v.maxLength(8_192))), v.maxLength(1_000))),
});
export type ApprovalRequest = v.InferOutput<typeof ApprovalRequestSchema>;

export const AppSnapshotSchema = v.pipe(
	v.object({
		protocolVersion: v.literal(PROTOCOL_VERSION),
		epoch: IdSchema,
		workspace: v.pipe(v.string(), v.maxLength(8_192)),
		trusted: v.boolean(),
		tabs: v.pipe(v.array(ChatTabSchema), v.minLength(1), v.maxLength(1_000)),
		activeChatId: IdSchema,
		// Snapshots carry one history only; tab selection requests the newly active history immediately.
		messages: v.record(v.string(), v.pipe(v.array(ChatMessageSchema), v.maxLength(100_000))),
		context: v.pipe(v.array(ContextChipSchema), v.maxLength(256)),
		approvalMode: ApprovalModeSchema,
		usage: UsageStateSchema,
		model: ModelStateSchema,
		commands: v.pipe(v.array(CommandSuggestionSchema), v.maxLength(10_000)),
		fileSuggestions: v.pipe(v.array(FileSuggestionSchema), v.maxLength(10_000)),
		approvalRequest: v.optional(ApprovalRequestSchema),
		design: ViewDesignSchema,
		designScope: v.picklist(["global", "workspace"] as const),
	}),
	v.check(
		({ tabs, activeChatId }) => tabs.some(({ id }) => id === activeChatId),
		"activeChatId must refer to a tab in this snapshot.",
	),
	v.check(
		({ messages, activeChatId }) =>
			Object.keys(messages).length === 1 && Object.hasOwn(messages, activeChatId),
		"messages must contain only the active chat history.",
	),
);
export type AppSnapshot = v.InferOutput<typeof AppSnapshotSchema>;

/** Canonical Webview -> Extension Host wire protocol used by `postIntent`. */
export const WebviewToHostMessageSchema = v.variant("type", [
	v.object({ ...ClientEnvelopeEntries, type: v.literal("ready") }),
	v.object({ ...ClientEnvelopeEntries, type: v.literal("newChat") }),
	v.object({ ...ClientEnvelopeEntries, type: v.literal("showHistory") }),
	v.object({
		...ClientEnvelopeEntries,
		type: v.literal("selectChat"),
		chatId: IdSchema,
	}),
	v.object({
		...ClientEnvelopeEntries,
		type: v.literal("closeChat"),
		chatId: IdSchema,
	}),
	v.object({
		...ClientEnvelopeEntries,
		type: v.literal("renameChat"),
		chatId: IdSchema,
		title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
	}),
	v.object({
		...ClientEnvelopeEntries,
		type: v.literal("regenerateTitle"),
		chatId: IdSchema,
	}),
	v.object({
		...ClientEnvelopeEntries,
		type: v.literal("sendPrompt"),
		chatId: IdSchema,
		text: v.pipe(MessageTextSchema, v.trim(), v.minLength(1)),
		contextIds: v.pipe(v.array(IdSchema), v.maxLength(256)),
	}),
	v.object({
		...ClientEnvelopeEntries,
		type: v.literal("stop"),
		chatId: IdSchema,
	}),
	v.object({
		...ClientEnvelopeEntries,
		type: v.literal("removeContext"),
		id: IdSchema,
	}),
	v.object({
		...ClientEnvelopeEntries,
		type: v.literal("pickContext"),
		kind: v.picklist(["any", "file", "folder"] as const),
	}),
	v.object({
		...ClientEnvelopeEntries,
		type: v.literal("dropContext"),
		uris: v.pipe(
			v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(8_192))),
			v.minLength(1),
			v.maxLength(256),
		),
	}),
	v.object({ ...ClientEnvelopeEntries, type: v.literal("addCurrentFile") }),
	v.object({
		...ClientEnvelopeEntries,
		type: v.literal("addCurrentSelection"),
	}),
	v.object({
		...ClientEnvelopeEntries,
		type: v.literal("searchFiles"),
		query: v.pipe(v.string(), v.maxLength(1_024)),
	}),
	v.object({
		...ClientEnvelopeEntries,
		type: v.literal("addSuggestedContext"),
		suggestionId: IdSchema,
	}),
	v.object({
		...ClientEnvelopeEntries,
		type: v.literal("invokeCommand"),
		chatId: IdSchema,
		invocation: LabelSchema,
		args: v.pipe(v.string(), v.maxLength(100_000)),
	}),
	v.object({
		...ClientEnvelopeEntries,
		type: v.literal("setApprovalMode"),
		chatId: IdSchema,
		mode: ApprovalModeSchema,
	}),
	v.object({
		...ClientEnvelopeEntries,
		type: v.literal("approvalDecision"),
		permissionRequestId: IdSchema,
		decision: v.picklist(["deny", "allowOnce", "allowSession"] as const),
	}),
	v.object({ ...ClientEnvelopeEntries, type: v.literal("loadModels") }),
	v.object({
		...ClientEnvelopeEntries,
		type: v.literal("setModel"),
		chatId: IdSchema,
		provider: IdSchema,
		modelId: IdSchema,
	}),
	v.object({
		...ClientEnvelopeEntries,
		type: v.literal("setThinking"),
		chatId: IdSchema,
		level: ThinkingLevelSchema,
	}),
	v.object({
		...ClientEnvelopeEntries,
		type: v.literal("saveModelDefault"),
		chatId: IdSchema,
	}),
	v.object({
		...ClientEnvelopeEntries,
		type: v.literal("configureProvider"),
		provider: v.optional(IdSchema),
	}),
	v.object({
		...ClientEnvelopeEntries,
		type: v.literal("compactContext"),
		chatId: IdSchema,
	}),
	v.object({
		...ClientEnvelopeEntries,
		type: v.literal("openReference"),
		refId: IdSchema,
		epoch: IdSchema,
		action: v.picklist(["open", "openBeside", "reveal", "copyPath"] as const),
	}),
	v.object({
		...ClientEnvelopeEntries,
		type: v.literal("reviewEdit"),
		editId: IdSchema,
	}),
	v.object({
		...ClientEnvelopeEntries,
		type: v.literal("retryMessage"),
		messageId: IdSchema,
	}),
	v.object({
		...ClientEnvelopeEntries,
		type: v.literal("saveDesign"),
		design: ViewDesignSchema,
		scope: v.picklist(["global", "workspace"] as const),
	}),
	v.object({
		...ClientEnvelopeEntries,
		type: v.literal("resetDesign"),
		scope: v.picklist(["global", "workspace"] as const),
	}),
	v.object({ ...ClientEnvelopeEntries, type: v.literal("resetPermissions") }),
]);

export type WebviewToHostMessage = v.InferOutput<typeof WebviewToHostMessageSchema>;
type RemoveClientEnvelope<T> = T extends unknown ? Omit<T, "protocolVersion" | "requestId"> : never;
export type WebviewIntent = RemoveClientEnvelope<WebviewToHostMessage>;

/** Canonical Extension Host -> Webview messages consumed by `main.tsx`. */
export const HostToWebviewMessageSchema = v.variant("type", [
	v.object({
		...HostEnvelopeEntries,
		type: v.literal("snapshot"),
		snapshot: AppSnapshotSchema,
	}),
	v.object({ ...HostEnvelopeEntries, type: v.literal("focusComposer") }),
	v.object({
		...HostEnvelopeEntries,
		type: v.literal("notice"),
		level: v.picklist(["info", "warning", "error"] as const),
		message: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(8_192)),
	}),
]);
export type HostToWebviewMessage = v.InferOutput<typeof HostToWebviewMessageSchema>;
export type HostMessage = HostToWebviewMessage;

export type ProtocolValidationResult<T> =
	| { readonly ok: true; readonly message: T }
	| { readonly ok: false; readonly issues: readonly v.BaseIssue<unknown>[] };

function validate<TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
	schema: TSchema,
	input: unknown,
): ProtocolValidationResult<v.InferOutput<TSchema>> {
	const result = v.safeParse(schema, input);
	return result.success
		? { ok: true, message: result.output }
		: { ok: false, issues: result.issues };
}

export function validateWebviewToHostMessage(
	input: unknown,
): ProtocolValidationResult<WebviewToHostMessage> {
	return validate(WebviewToHostMessageSchema, input);
}

export function validateHostToWebviewMessage(
	input: unknown,
): ProtocolValidationResult<HostToWebviewMessage> {
	return validate(HostToWebviewMessageSchema, input);
}

export function validateAppSnapshot(input: unknown): ProtocolValidationResult<AppSnapshot> {
	return validate(AppSnapshotSchema, input);
}

export function isCurrentEpoch(
	message: { readonly epoch: string | number },
	epoch: string | number,
): boolean {
	return message.epoch === epoch;
}
