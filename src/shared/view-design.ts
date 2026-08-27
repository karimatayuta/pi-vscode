import * as v from "valibot";

export type DesignColorMode = "vscode" | "light" | "dark" | "highContrast" | "custom";
export type DesignDensity = "compact" | "comfortable";
export type DesignLineHeight = "compact" | "comfortable" | "spacious";
export type AgentIconKind = "geometric" | "text" | "image";

/** Keeps synced View Design state small while allowing a crisp 128px avatar. */
export const MAX_AGENT_ICON_DATA_BYTES = 48 * 1_024;

export function isSafeAgentIconText(value: string): boolean {
	const normalized = value.trim().normalize("NFC");
	if (normalized.length === 0 || normalized.length > 32 || [...normalized].length > 8) return false;
	return [...normalized].every((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return !(
			codePoint <= 0x1f ||
			(codePoint >= 0x7f && codePoint <= 0x9f) ||
			(codePoint >= 0x2028 && codePoint <= 0x202e) ||
			(codePoint >= 0x2066 && codePoint <= 0x2069)
		);
	});
}

/** Only raster image data is accepted; SVG and remote URLs never enter the Webview. */
export function isSafeAgentIconDataUri(value: string): boolean {
	const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(value);
	if (!match?.[1]) return false;
	const payload = match[1];
	if (payload.length % 4 !== 0) return false;
	const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
	return (payload.length / 4) * 3 - padding <= MAX_AGENT_ICON_DATA_BYTES;
}

/** Allows installed font-family names and the two VS Code font variables only. */
export function isSafeFontFamily(value: string): boolean {
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > 200) return false;
	if (/(?:url\s*\(|@import|expression\s*\(|[;{}<>\\])/iu.test(trimmed)) {
		return false;
	}
	if (/^var\(/u.test(trimmed)) {
		return (
			trimmed === "var(--vscode-font-family)" || trimmed === "var(--vscode-editor-font-family)"
		);
	}
	return /^[\p{L}\p{N}\s'",._-]+$/u.test(trimmed);
}

export const DesignColorModeSchema = v.picklist([
	"vscode",
	"light",
	"dark",
	"highContrast",
	"custom",
] as const);
export const DesignDensitySchema = v.picklist(["compact", "comfortable"] as const);
export const DesignLineHeightSchema = v.picklist(["compact", "comfortable", "spacious"] as const);
export const HexColorSchema = v.pipe(v.string(), v.regex(/^#[0-9a-fA-F]{6}$/));
const FontFamilySchema = v.pipe(
	v.string(),
	v.trim(),
	v.minLength(1),
	v.maxLength(200),
	v.check(isSafeFontFamily, "Font family contains unsafe CSS syntax."),
);

export const ViewDesignColorsSchema = v.object({
	background: HexColorSchema,
	surface: HexColorSchema,
	text: HexColorSchema,
	muted: HexColorSchema,
	accent: HexColorSchema,
	border: HexColorSchema,
	userMessage: HexColorSchema,
	assistantMessage: HexColorSchema,
});

const AgentIconTextSchema = v.pipe(
	v.string(),
	v.maxLength(32),
	v.check((value) => value.length === 0 || isSafeAgentIconText(value), "Invalid agent icon text."),
);
const AgentIconDataUriSchema = v.pipe(
	v.string(),
	v.maxLength(90_000),
	v.check(
		(value) => value.length === 0 || isSafeAgentIconDataUri(value),
		"Agent icon must be a small PNG, JPEG, or WebP data URI.",
	),
);

export const AgentIconSchema = v.pipe(
	v.object({
		kind: v.picklist(["geometric", "text", "image"] as const),
		text: AgentIconTextSchema,
		imageDataUri: AgentIconDataUriSchema,
		background: HexColorSchema,
		foreground: HexColorSchema,
	}),
	v.check(
		(icon) => icon.kind !== "text" || isSafeAgentIconText(icon.text),
		"A text agent icon requires one short character or emoji.",
	),
	v.check(
		(icon) => icon.kind !== "image" || isSafeAgentIconDataUri(icon.imageDataUri),
		"An image agent icon requires a valid raster image.",
	),
);

export const ViewDesignSchema = v.object({
	interfaceFont: FontFamilySchema,
	messageFont: FontFamilySchema,
	codeFont: FontFamilySchema,
	textSize: v.pipe(v.number(), v.integer(), v.minValue(11), v.maxValue(20)),
	codeSize: v.pipe(v.number(), v.integer(), v.minValue(11), v.maxValue(20)),
	lineHeight: DesignLineHeightSchema,
	colorMode: DesignColorModeSchema,
	density: DesignDensitySchema,
	messageSpacing: v.pipe(v.number(), v.integer(), v.minValue(4), v.maxValue(24)),
	cornerRadius: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(16)),
	agentIcon: AgentIconSchema,
	colors: ViewDesignColorsSchema,
});

export type ViewDesign = v.InferOutput<typeof ViewDesignSchema>;
export type ViewDesignColors = v.InferOutput<typeof ViewDesignColorsSchema>;
export type AgentIcon = v.InferOutput<typeof AgentIconSchema>;

export const DEFAULT_VIEW_DESIGN: Readonly<ViewDesign> = {
	interfaceFont: "var(--vscode-font-family)",
	messageFont: "var(--vscode-font-family)",
	codeFont: "var(--vscode-editor-font-family)",
	textSize: 13,
	codeSize: 12,
	lineHeight: "comfortable",
	colorMode: "vscode",
	density: "comfortable",
	messageSpacing: 10,
	cornerRadius: 8,
	agentIcon: {
		kind: "geometric",
		text: "π",
		imageDataUri: "",
		background: "#050505",
		foreground: "#FFFFFF",
	},
	colors: {
		background: "#181A1F",
		surface: "#202329",
		text: "#F0F0F0",
		muted: "#A9ADB7",
		accent: "#9B6CFF",
		border: "#6C7280",
		userMessage: "#22262E",
		assistantMessage: "#1D2026",
	},
};

export type ViewDesignIssueCode =
	| "invalid-font"
	| "invalid-enum"
	| "invalid-number"
	| "invalid-color"
	| "invalid-icon"
	| "insufficient-contrast";
export interface ViewDesignIssue {
	readonly path: string;
	readonly code: ViewDesignIssueCode;
	readonly message: string;
}
export interface SanitizedViewDesign {
	readonly value: ViewDesign;
	readonly issues: readonly ViewDesignIssue[];
	readonly isValid: boolean;
}

function isRecord(input: unknown): input is Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input);
}

function sanitizeFont(
	input: unknown,
	fallback: string,
	path: string,
	issues: ViewDesignIssue[],
): string {
	if (typeof input === "string" && isSafeFontFamily(input)) {
		return input.trim().replace(/\s+/gu, " ");
	}
	issues.push({
		path,
		code: "invalid-font",
		message: `${path} is not a safe font-family value; the default was used.`,
	});
	return fallback;
}

function sanitizeEnum<T extends string>(
	input: unknown,
	allowed: readonly T[],
	fallback: T,
	path: string,
	issues: ViewDesignIssue[],
): T {
	if (typeof input === "string" && allowed.includes(input as T)) return input as T;
	issues.push({
		path,
		code: "invalid-enum",
		message: `${path} has an unsupported value; the default was used.`,
	});
	return fallback;
}

function sanitizeInteger(
	input: unknown,
	fallback: number,
	min: number,
	max: number,
	path: string,
	issues: ViewDesignIssue[],
): number {
	if (typeof input === "number" && Number.isInteger(input) && input >= min && input <= max) {
		return input;
	}
	issues.push({
		path,
		code: "invalid-number",
		message: `${path} must be an integer from ${min} to ${max}; the default was used.`,
	});
	return fallback;
}

function sanitizeColor(
	input: unknown,
	fallback: string,
	path: string,
	issues: ViewDesignIssue[],
): string {
	if (typeof input === "string" && /^#[0-9a-fA-F]{6}$/u.test(input)) {
		return input.toUpperCase();
	}
	issues.push({
		path,
		code: "invalid-color",
		message: `${path} must be a six-digit hex color; the default was used.`,
	});
	return fallback;
}

function sanitizeAgentIcon(input: unknown, issues: ViewDesignIssue[]): AgentIcon {
	if (input === undefined) return { ...DEFAULT_VIEW_DESIGN.agentIcon };
	if (!isRecord(input)) {
		issues.push({
			path: "agentIcon",
			code: "invalid-icon",
			message: "agentIcon must be an object; the default icon was used.",
		});
		return { ...DEFAULT_VIEW_DESIGN.agentIcon };
	}
	const kind = sanitizeEnum(
		input.kind,
		["geometric", "text", "image"],
		DEFAULT_VIEW_DESIGN.agentIcon.kind,
		"agentIcon.kind",
		issues,
	);
	const background = sanitizeColor(
		input.background,
		DEFAULT_VIEW_DESIGN.agentIcon.background,
		"agentIcon.background",
		issues,
	);
	const foreground = sanitizeColor(
		input.foreground,
		DEFAULT_VIEW_DESIGN.agentIcon.foreground,
		"agentIcon.foreground",
		issues,
	);
	const text =
		typeof input.text === "string" && (input.text === "" || isSafeAgentIconText(input.text))
			? input.text.trim().normalize("NFC")
			: DEFAULT_VIEW_DESIGN.agentIcon.text;
	if (text === DEFAULT_VIEW_DESIGN.agentIcon.text && input.text !== text) {
		issues.push({
			path: "agentIcon.text",
			code: "invalid-icon",
			message: "agentIcon.text must be one short character or emoji; the default was used.",
		});
	}
	const imageDataUri =
		typeof input.imageDataUri === "string" &&
		(input.imageDataUri === "" || isSafeAgentIconDataUri(input.imageDataUri))
			? input.imageDataUri
			: "";
	if (imageDataUri === "" && input.imageDataUri !== "") {
		issues.push({
			path: "agentIcon.imageDataUri",
			code: "invalid-icon",
			message: "agentIcon.imageDataUri must be a small PNG, JPEG, or WebP image.",
		});
	}
	if (kind === "text" && !isSafeAgentIconText(text)) {
		issues.push({
			path: "agentIcon.text",
			code: "invalid-icon",
			message: "The text icon is empty; the default icon was used.",
		});
		return { ...DEFAULT_VIEW_DESIGN.agentIcon, background, foreground };
	}
	if (kind === "image" && !isSafeAgentIconDataUri(imageDataUri)) {
		issues.push({
			path: "agentIcon.imageDataUri",
			code: "invalid-icon",
			message: "The image icon is empty; the default icon was used.",
		});
		return { ...DEFAULT_VIEW_DESIGN.agentIcon, background, foreground };
	}
	return { kind, text, imageDataUri, background, foreground };
}

export function sanitizeViewDesign(input: unknown): SanitizedViewDesign {
	const issues: ViewDesignIssue[] = [];
	const source = isRecord(input) ? input : {};
	const colorSource = isRecord(source.colors) ? source.colors : {};
	if (!isRecord(input)) {
		issues.push({
			path: "design",
			code: "invalid-enum",
			message: "Design settings must be an object; defaults were used.",
		});
	}
	const colors = Object.fromEntries(
		Object.entries(DEFAULT_VIEW_DESIGN.colors).map(([key, fallback]) => [
			key,
			sanitizeColor(colorSource[key], fallback, `colors.${key}`, issues),
		]),
	) as unknown as ViewDesignColors;
	const candidate: ViewDesign = {
		interfaceFont: sanitizeFont(
			source.interfaceFont,
			DEFAULT_VIEW_DESIGN.interfaceFont,
			"interfaceFont",
			issues,
		),
		messageFont: sanitizeFont(
			source.messageFont,
			DEFAULT_VIEW_DESIGN.messageFont,
			"messageFont",
			issues,
		),
		codeFont: sanitizeFont(source.codeFont, DEFAULT_VIEW_DESIGN.codeFont, "codeFont", issues),
		textSize: sanitizeInteger(
			source.textSize,
			DEFAULT_VIEW_DESIGN.textSize,
			11,
			20,
			"textSize",
			issues,
		),
		codeSize: sanitizeInteger(
			source.codeSize,
			DEFAULT_VIEW_DESIGN.codeSize,
			11,
			20,
			"codeSize",
			issues,
		),
		lineHeight: sanitizeEnum(
			source.lineHeight,
			["compact", "comfortable", "spacious"],
			DEFAULT_VIEW_DESIGN.lineHeight,
			"lineHeight",
			issues,
		),
		colorMode: sanitizeEnum(
			source.colorMode,
			["vscode", "light", "dark", "highContrast", "custom"],
			DEFAULT_VIEW_DESIGN.colorMode,
			"colorMode",
			issues,
		),
		density: sanitizeEnum(
			source.density,
			["compact", "comfortable"],
			DEFAULT_VIEW_DESIGN.density,
			"density",
			issues,
		),
		messageSpacing: sanitizeInteger(
			source.messageSpacing,
			DEFAULT_VIEW_DESIGN.messageSpacing,
			4,
			24,
			"messageSpacing",
			issues,
		),
		cornerRadius: sanitizeInteger(
			source.cornerRadius,
			DEFAULT_VIEW_DESIGN.cornerRadius,
			0,
			16,
			"cornerRadius",
			issues,
		),
		agentIcon: sanitizeAgentIcon(source.agentIcon, issues),
		colors,
	};
	issues.push(...auditViewDesignContrast(candidate));
	return { value: candidate, issues, isValid: issues.length === 0 };
}

function hexToRgb(hex: string): readonly [number, number, number] {
	if (!/^#[0-9a-fA-F]{6}$/u.test(hex)) {
		throw new Error(`Expected a six-digit hex color, received: ${hex}`);
	}
	return [
		Number.parseInt(hex.slice(1, 3), 16),
		Number.parseInt(hex.slice(3, 5), 16),
		Number.parseInt(hex.slice(5, 7), 16),
	];
}

export function relativeLuminance(hex: string): number {
	const linearize = (channel: number): number => {
		const normalized = channel / 255;
		return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
	};
	const [red, green, blue] = hexToRgb(hex);
	return 0.2126 * linearize(red) + 0.7152 * linearize(green) + 0.0722 * linearize(blue);
}

export function contrastRatio(first: string, second: string): number {
	const firstLuminance = relativeLuminance(first);
	const secondLuminance = relativeLuminance(second);
	const lighter = Math.max(firstLuminance, secondLuminance);
	const darker = Math.min(firstLuminance, secondLuminance);
	return (lighter + 0.05) / (darker + 0.05);
}

export function meetsContrast(
	foreground: string,
	background: string,
	minimumRatio: number,
): boolean {
	return contrastRatio(foreground, background) >= minimumRatio;
}

export function auditViewDesignContrast(
	design: Pick<ViewDesign, "colors">,
): readonly ViewDesignIssue[] {
	const { colors } = design;
	const pairs: readonly [string, string, string, number][] = [
		["colors.text", colors.text, colors.background, 4.5],
		["colors.muted", colors.muted, colors.background, 4.5],
		["colors.accent", colors.accent, colors.background, 3],
		["colors.border", colors.border, colors.surface, 3],
		["colors.text", colors.text, colors.userMessage, 4.5],
		["colors.text", colors.text, colors.assistantMessage, 4.5],
	];
	return pairs.flatMap(([path, foreground, background, minimum]) => {
		const ratio = contrastRatio(foreground, background);
		return ratio >= minimum
			? []
			: [
					{
						path,
						code: "insufficient-contrast" as const,
						message: `${path} has a ${ratio.toFixed(2)}:1 contrast ratio; ${minimum}:1 is required.`,
					},
				];
	});
}

export function parseViewDesign(input: unknown): ViewDesign {
	return v.parse(ViewDesignSchema, input);
}
