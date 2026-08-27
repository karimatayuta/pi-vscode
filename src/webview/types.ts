import type { ApprovalMode } from "../shared/approval.js";
import type {
	ApprovalRequest,
	AppSnapshot,
	ChatMessage,
	ChatPhase,
	ChatTab,
	CommandSuggestion,
	ContextChip,
	FileSuggestion,
	ModelOption,
	ModelState,
	ProposedEdit,
	ReferenceDescriptor,
	ThinkingLevel,
	ToolItem,
	UsageState,
} from "../shared/protocol.js";
import { type AgentIcon, DEFAULT_VIEW_DESIGN, type ViewDesign } from "../shared/view-design.js";

export type {
	AgentIcon,
	ApprovalMode,
	ApprovalRequest,
	AppSnapshot,
	ChatMessage,
	ChatPhase,
	ChatTab,
	CommandSuggestion,
	ContextChip,
	FileSuggestion,
	ModelOption,
	ModelState,
	ProposedEdit,
	ReferenceDescriptor,
	ThinkingLevel,
	ToolItem,
	UsageState,
	ViewDesign,
};

export type DesignColorMode = ViewDesign["colorMode"];
export type DesignDensity = ViewDesign["density"];

export const DEFAULT_DESIGN = DEFAULT_VIEW_DESIGN;

export const EMPTY_SNAPSHOT: AppSnapshot = {
	protocolVersion: 1,
	epoch: "boot",
	workspace: "No workspace",
	trusted: false,
	tabs: [
		{
			id: "boot",
			title: "New chat",
			phase: "idle",
			progress: "Ready",
			unread: false,
			manualTitle: false,
		},
	],
	activeChatId: "boot",
	messages: { boot: [] },
	context: [],
	approvalMode: "plan",
	usage: {
		contextTokens: null,
		contextWindow: null,
		contextPercent: null,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
		cost: null,
		costKind: "unknown",
	},
	model: { name: "Choose model", thinking: "off", options: [], loading: true },
	commands: [],
	fileSuggestions: [],
	design: DEFAULT_VIEW_DESIGN,
	designScope: "global",
};
