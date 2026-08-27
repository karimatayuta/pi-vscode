import * as v from "valibot";

export const APPROVAL_MODES = ["plan", "ask", "autoEdit", "fullAccess"] as const;

export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export const ApprovalModeSchema = v.picklist(APPROVAL_MODES);

export const CAPABILITIES = [
	"workspace.read",
	"workspace.search",
	"workspace.edit",
	"workspace.write",
	"workspace.delete",
	"command.execute",
	"network.access",
	"filesystem.outside-workspace",
	"secrets.read",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const CapabilitySchema = v.picklist(CAPABILITIES);

export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];

export const RiskLevelSchema = v.picklist(RISK_LEVELS);

export const APPROVAL_MODE_LABELS: Readonly<Record<ApprovalMode, string>> = {
	plan: "Plan",
	ask: "Ask",
	autoEdit: "Auto Edit",
	fullAccess: "Full Access",
};
