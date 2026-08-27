import { describe, expect, test } from "bun:test";
import {
	auditViewDesignContrast,
	contrastRatio,
	DEFAULT_VIEW_DESIGN,
	isSafeAgentIconDataUri,
	isSafeAgentIconText,
	isSafeFontFamily,
	MAX_AGENT_ICON_DATA_BYTES,
	meetsContrast,
	parseViewDesign,
	sanitizeViewDesign,
} from "../../src/shared/view-design.js";

describe("View Design", () => {
	test("default design passes runtime and accessibility validation", () => {
		expect(parseViewDesign(DEFAULT_VIEW_DESIGN)).toEqual(DEFAULT_VIEW_DESIGN);
		expect(auditViewDesignContrast(DEFAULT_VIEW_DESIGN)).toEqual([]);
		expect(sanitizeViewDesign(DEFAULT_VIEW_DESIGN)).toMatchObject({
			isValid: true,
			issues: [],
		});
	});

	test("uses an original black and white geometric agent icon by default", () => {
		expect(DEFAULT_VIEW_DESIGN.agentIcon).toEqual({
			kind: "geometric",
			text: "π",
			imageDataUri: "",
			background: "#050505",
			foreground: "#FFFFFF",
		});
	});

	test.each(["π", "P", "🤖", "👩‍💻"])('accepts safe icon text "%s"', (value) => {
		expect(isSafeAgentIconText(value)).toBe(true);
	});

	test.each(["", "\n", "toolong!!!", "A\u202Etxt"])('rejects unsafe icon text "%s"', (value) => {
		expect(isSafeAgentIconText(value)).toBe(false);
	});

	test("accepts bounded raster data and rejects SVG, remote URLs, and oversized data", () => {
		expect(isSafeAgentIconDataUri("data:image/png;base64,aGVsbG8=")).toBe(true);
		expect(isSafeAgentIconDataUri("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
		expect(isSafeAgentIconDataUri("https://example.invalid/icon.png")).toBe(false);
		const oversized = Buffer.alloc(MAX_AGENT_ICON_DATA_BYTES + 1).toString("base64");
		expect(isSafeAgentIconDataUri(`data:image/webp;base64,${oversized}`)).toBe(false);
	});

	test("migrates legacy saved designs to the safe default agent icon", () => {
		const { agentIcon: _agentIcon, ...legacy } = DEFAULT_VIEW_DESIGN;
		const result = sanitizeViewDesign(legacy);
		expect(result.value.agentIcon).toEqual(DEFAULT_VIEW_DESIGN.agentIcon);
		expect(result.issues).toEqual([]);
		expect(result.isValid).toBe(true);
	});

	test.each([
		"Inter, -apple-system, sans-serif",
		'"SF Pro Text", system-ui',
		"Noto Sans JP",
		"var(--vscode-font-family)",
		"var(--vscode-editor-font-family)",
	])("accepts safe installed font expression %s", (font) => {
		expect(isSafeFontFamily(font)).toBe(true);
	});

	test.each([
		"url(https://evil.invalid/font.woff2)",
		"Arial; background: red",
		"@import 'evil.css'",
		"var(--attacker-controlled)",
		"Arial } body { display:none",
	])("rejects injectable font expression %s", (font) => {
		expect(isSafeFontFamily(font)).toBe(false);
	});

	test("sanitizes invalid values to defaults and reports every affected path", () => {
		const result = sanitizeViewDesign({
			...DEFAULT_VIEW_DESIGN,
			interfaceFont: "url(https://evil.invalid/font.woff2)",
			textSize: 999,
			colorMode: "neon",
			messageSpacing: 100,
			colors: { ...DEFAULT_VIEW_DESIGN.colors, accent: "red" },
		});
		expect(result.value.interfaceFont).toBe(DEFAULT_VIEW_DESIGN.interfaceFont);
		expect(result.value.textSize).toBe(DEFAULT_VIEW_DESIGN.textSize);
		expect(result.value.colorMode).toBe(DEFAULT_VIEW_DESIGN.colorMode);
		expect(result.value.messageSpacing).toBe(DEFAULT_VIEW_DESIGN.messageSpacing);
		expect(result.value.colors.accent).toBe(DEFAULT_VIEW_DESIGN.colors.accent);
		expect(result.issues.map(({ path }) => path)).toEqual(
			expect.arrayContaining([
				"interfaceFont",
				"textSize",
				"colorMode",
				"messageSpacing",
				"colors.accent",
			]),
		);
		expect(result.isValid).toBe(false);
	});

	test("calculates WCAG contrast and reports unsafe custom theme colors", () => {
		expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
		expect(meetsContrast("#777777", "#FFFFFF", 4.5)).toBe(false);

		const design = {
			...DEFAULT_VIEW_DESIGN,
			colors: {
				...DEFAULT_VIEW_DESIGN.colors,
				muted: "#191A1F",
			},
		};
		expect(auditViewDesignContrast(design)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					path: "colors.muted",
					code: "insufficient-contrast",
				}),
			]),
		);
		expect(sanitizeViewDesign(design).isValid).toBe(false);
	});

	test("strict parser rejects out-of-range size and malformed colors", () => {
		expect(() => parseViewDesign({ ...DEFAULT_VIEW_DESIGN, codeSize: 10 })).toThrow();
		expect(() =>
			parseViewDesign({
				...DEFAULT_VIEW_DESIGN,
				colors: { ...DEFAULT_VIEW_DESIGN.colors, text: "white" },
			}),
		).toThrow();
		expect(() =>
			parseViewDesign({
				...DEFAULT_VIEW_DESIGN,
				interfaceFont: "Arial; display: none",
			}),
		).toThrow();
		expect(() =>
			parseViewDesign({
				...DEFAULT_VIEW_DESIGN,
				agentIcon: {
					...DEFAULT_VIEW_DESIGN.agentIcon,
					kind: "image",
					imageDataUri: "data:image/svg+xml;base64,PHN2Zz4=",
				},
			}),
		).toThrow();
	});
});
