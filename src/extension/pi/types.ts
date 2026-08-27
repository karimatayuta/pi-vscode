export type PiHostSessionId = string;

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type PiSessionPhase =
	| "idle"
	| "running"
	| "streaming"
	| "tool"
	| "retrying"
	| "compacting"
	| "closing";

export type PiPromptDelivery = "steer" | "followUp";

export type PiToolCapability = "read" | "search" | "mutate" | "execute" | "extension";
export type PiToolRisk = "safe" | "sensitive" | "dangerous";

export interface PiToolAuthorizationRequest {
	readonly sessionId: PiHostSessionId;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly capability: PiToolCapability;
	readonly target?: string;
	readonly command?: string;
	readonly cwd: string;
	readonly risk: PiToolRisk;
}

export interface PiToolAuthorizationDecision {
	readonly allow: boolean;
	readonly reason?: string;
}

export type PiSessionOpenTarget =
	| { readonly kind: "new" }
	| { readonly kind: "continue" }
	| { readonly kind: "memory" }
	| { readonly kind: "file"; readonly path: string };

export type PiSessionReplaceTarget =
	| { readonly kind: "new" }
	| { readonly kind: "file"; readonly path: string }
	| {
			readonly kind: "fork";
			readonly entryId: string;
			readonly position?: "before" | "at";
	  };

export interface PiImageInput {
	readonly mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
	/** Base64 without a data URL prefix. This value never appears in an output DTO. */
	readonly data: string;
}

export interface PiPromptInput {
	readonly text: string;
	readonly images?: readonly PiImageInput[];
	readonly delivery?: PiPromptDelivery;
}

export interface PiModelRefDto {
	readonly provider: string;
	readonly id: string;
	readonly name: string;
}

export interface PiModelCostDto {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	/** Pi uses zero values when pricing is unavailable, so zero alone is not presented as "free". */
	readonly known: boolean;
}

export interface PiModelDto extends PiModelRefDto {
	readonly reasoning: boolean;
	readonly input: readonly string[];
	readonly contextWindow?: number;
	readonly maxTokens?: number;
	readonly thinkingLevels: readonly PiThinkingLevel[];
	readonly cost: PiModelCostDto;
}

export interface PiModelCatalogDto {
	readonly models: readonly PiModelDto[];
	/** True when a timed-out refresh fell back to Pi's last locally consistent snapshot. */
	readonly stale: boolean;
}

export interface PiContextUsageDto {
	readonly tokens: number | null;
	readonly contextWindow: number;
	readonly percent: number | null;
}

export interface PiSessionStatsDto {
	readonly userMessages: number;
	readonly assistantMessages: number;
	readonly toolCalls: number;
	readonly toolResults: number;
	readonly totalMessages: number;
	readonly tokens: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly total: number;
	};
	readonly cost: number;
	readonly costKind: "estimated" | "subscription" | "unknown";
	readonly context?: PiContextUsageDto;
}

export interface PiSessionSnapshotDto {
	readonly id: PiHostSessionId;
	readonly generation: number;
	readonly cwd: string;
	readonly piSessionId: string;
	readonly persistent: boolean;
	/** Host-only restore metadata. Do not forward this absolute path to the webview. */
	readonly sessionFile?: string;
	readonly title?: string;
	readonly phase: PiSessionPhase;
	readonly busy: boolean;
	readonly model?: PiModelRefDto;
	readonly thinkingLevel: PiThinkingLevel;
	readonly availableThinkingLevels: readonly PiThinkingLevel[];
	readonly pendingMessages: number;
	readonly activeTools: readonly string[];
	readonly stats: PiSessionStatsDto;
}

export type PiCommandKind = "extension" | "prompt" | "skill";

export interface PiCommandDto {
	readonly invocation: string;
	readonly kind: PiCommandKind;
	readonly description?: string;
	readonly hasArgumentCompletions: boolean;
}

export interface PiTextContentDto {
	readonly type: "text";
	readonly text: string;
	readonly truncated?: boolean;
}

export interface PiThinkingContentDto {
	readonly type: "thinking";
	readonly text: string;
	readonly truncated?: boolean;
}

export interface PiImageContentDto {
	readonly type: "image";
	readonly mimeType?: string;
	readonly omitted: true;
}

export interface PiToolCallContentDto {
	readonly type: "toolCall";
	readonly id?: string;
	readonly name: string;
	readonly arguments?: PiJsonValue;
}

export interface PiUnknownContentDto {
	readonly type: "unknown";
}

export type PiMessageContentDto =
	| PiTextContentDto
	| PiThinkingContentDto
	| PiImageContentDto
	| PiToolCallContentDto
	| PiUnknownContentDto;

export interface PiUsageDto {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	/** Provider-reported context total, with the component sum as a fallback. */
	readonly total: number;
	readonly cost: number;
	/** False when the stream has not supplied a usable cost total. */
	readonly costKnown: boolean;
}

export interface PiMessageDto {
	readonly role: "user" | "assistant" | "toolResult" | "custom" | "bashExecution" | "unknown";
	readonly timestamp?: number;
	readonly content: readonly PiMessageContentDto[];
	readonly stopReason?:
		| "pending"
		| "stop"
		| "length"
		| "toolUse"
		| "error"
		| "aborted"
		| "deferred";
	readonly usage?: PiUsageDto;
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly isError?: boolean;
	readonly errorMessage?: string;
}

export type PiJsonPrimitive = string | number | boolean | null;
export type PiJsonValue =
	| PiJsonPrimitive
	| readonly PiJsonValue[]
	| { readonly [key: string]: PiJsonValue };

export interface PiStreamDeltaDto {
	readonly kind: "text" | "thinking" | "tool" | "status";
	readonly text?: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
}

export interface PiToolEventDto {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly args?: PiJsonValue;
	readonly result?: PiJsonValue;
	readonly isError?: boolean;
}

export type PiErrorScope =
	| "host"
	| "prompt"
	| "agent"
	| "tool"
	| "extension"
	| "compaction"
	| "model";

export interface PiErrorDto {
	readonly scope: PiErrorScope;
	readonly code: string;
	readonly message: string;
	readonly recoverable: boolean;
}

interface PiHostEventBase {
	readonly sessionId: PiHostSessionId;
	readonly generation: number;
}

export type PiHostEvent =
	| (PiHostEventBase & {
			readonly type: "session.bootstrap";
			readonly bootstrap: PiSessionBootstrapDto;
	  })
	| (PiHostEventBase & {
			readonly type: "session.state";
			readonly phase: PiSessionPhase;
			readonly busy: boolean;
	  })
	| (PiHostEventBase & {
			readonly type: "session.snapshot";
			readonly snapshot: PiSessionSnapshotDto;
	  })
	| (PiHostEventBase & { readonly type: "session.stats"; readonly stats: PiSessionStatsDto })
	| (PiHostEventBase & { readonly type: "session.title"; readonly title?: string })
	| (PiHostEventBase & { readonly type: "session.thinking"; readonly level: PiThinkingLevel })
	| (PiHostEventBase & {
			readonly type: "session.queue";
			readonly steering: readonly string[];
			readonly followUp: readonly string[];
	  })
	| (PiHostEventBase & {
			readonly type: "session.commands";
			readonly commands: readonly PiCommandDto[];
	  })
	| (PiHostEventBase & { readonly type: "session.error"; readonly error: PiErrorDto })
	| (PiHostEventBase & { readonly type: "session.closed" })
	| (PiHostEventBase & { readonly type: "message.start"; readonly message: PiMessageDto })
	| (PiHostEventBase & {
			readonly type: "message.update";
			readonly message: PiMessageDto;
			readonly delta: PiStreamDeltaDto;
	  })
	| (PiHostEventBase & { readonly type: "message.end"; readonly message: PiMessageDto })
	| (PiHostEventBase & { readonly type: "tool.start"; readonly tool: PiToolEventDto })
	| (PiHostEventBase & { readonly type: "tool.update"; readonly tool: PiToolEventDto })
	| (PiHostEventBase & { readonly type: "tool.end"; readonly tool: PiToolEventDto })
	| (PiHostEventBase & {
			readonly type: "lifecycle";
			readonly name:
				| "agent.start"
				| "agent.end"
				| "agent.settled"
				| "turn.start"
				| "turn.end"
				| "retry.start"
				| "retry.end"
				| "compaction.start"
				| "compaction.end";
			readonly detail?: PiJsonValue;
	  });

export interface PiSessionBootstrapDto {
	readonly snapshot: PiSessionSnapshotDto;
	readonly history: readonly PiMessageDto[];
	readonly commands: readonly PiCommandDto[];
}

/** Host-only session metadata used by VS Code's native history picker. */
export interface PiSessionHistoryDto {
	readonly path: string;
	readonly id: string;
	readonly title?: string;
	readonly firstMessage: string;
	readonly messageCount: number;
	readonly createdAt: number;
	readonly modifiedAt: number;
}

export interface PiDisposable {
	dispose(): void;
}

export type PiHostEventListener = (event: PiHostEvent) => void;

export interface PiHostApi {
	start(signal?: AbortSignal): Promise<void>;
	open(input: {
		readonly cwd: string;
		readonly target: PiSessionOpenTarget;
	}): Promise<PiSessionBootstrapDto>;
	replace(id: PiHostSessionId, target: PiSessionReplaceTarget): Promise<PiSessionBootstrapDto>;
	send(id: PiHostSessionId, input: PiPromptInput): Promise<void>;
	listCommands(id: PiHostSessionId): Promise<readonly PiCommandDto[]>;
	listSessions(cwd: string): Promise<readonly PiSessionHistoryDto[]>;
	invokeCommand(
		id: PiHostSessionId,
		invocation: string,
		args?: string,
		delivery?: PiPromptDelivery,
	): Promise<void>;
	listModels(signal?: AbortSignal): Promise<PiModelCatalogDto>;
	setRuntimeApiKey(provider: string, apiKey: string): Promise<void>;
	removeRuntimeApiKey(provider: string): Promise<void>;
	setModel(
		id: PiHostSessionId,
		ref: { readonly provider: string; readonly id: string },
		persist?: boolean,
	): Promise<PiSessionSnapshotDto>;
	setThinking(
		id: PiHostSessionId,
		level: PiThinkingLevel,
		persist?: boolean,
	): Promise<PiSessionSnapshotDto>;
	setTitle(id: PiHostSessionId, title: string): Promise<PiSessionSnapshotDto>;
	compact(id: PiHostSessionId, customInstructions?: string): Promise<PiSessionSnapshotDto>;
	abort(id: PiHostSessionId): Promise<void>;
	close(id: PiHostSessionId): Promise<void>;
	onEvent(listener: PiHostEventListener): PiDisposable;
	dispose(): Promise<void>;
}
