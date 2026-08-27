import { type RenderOptions, renderMermaidSVG } from "beautiful-mermaid";

// The presentation and ID-isolation approach is adapted from Markdown Preview
// Annotator (MIT, Copyright (c) 2026 karimatayuta). See THIRD_PARTY_NOTICES.md.
const MODERN_THEME: RenderOptions = {
	bg: "var(--pi-background)",
	fg: "var(--pi-text)",
	line: "var(--pi-muted)",
	accent: "var(--pi-accent)",
	muted: "var(--pi-muted)",
	surface: "var(--pi-surface-2)",
	border: "var(--pi-border)",
	transparent: true,
	padding: 32,
	nodeSpacing: 28,
	layerSpacing: 48,
	componentSpacing: 28,
};

const MAX_MERMAID_SOURCE_LENGTH = 50_000;
const MAX_MERMAID_SOURCE_LINES = 800;
const MAX_MERMAID_SVG_LENGTH = 3_000_000;

const SVG_TAGS = [
	"svg",
	"style",
	"defs",
	"marker",
	"g",
	"rect",
	"circle",
	"ellipse",
	"line",
	"polyline",
	"polygon",
	"path",
	"text",
	"tspan",
	"title",
];

const SVG_ATTRIBUTES = [
	"xmlns",
	"viewBox",
	"width",
	"height",
	"style",
	"class",
	"id",
	"x",
	"y",
	"x1",
	"x2",
	"y1",
	"y2",
	"cx",
	"cy",
	"r",
	"rx",
	"ry",
	"d",
	"dy",
	"points",
	"fill",
	"fill-opacity",
	"stroke",
	"stroke-width",
	"stroke-opacity",
	"stroke-dasharray",
	"stroke-linecap",
	"stroke-linejoin",
	"stroke-miterlimit",
	"marker-start",
	"marker-end",
	"markerWidth",
	"markerHeight",
	"refX",
	"refY",
	"orient",
	"transform",
	"opacity",
	"display",
	"text-anchor",
	"font-size",
	"font-weight",
	"font-style",
	"text-decoration",
	"focusable",
	"aria-hidden",
];

/**
 * A deliberately narrow DOMPurify policy for generated inline SVG. Links,
 * images, animation, foreignObject, event handlers, and data attributes are
 * not needed by beautiful-mermaid and therefore are never admitted.
 */
export const MERMAID_SVG_SANITIZE_OPTIONS = {
	ALLOWED_TAGS: SVG_TAGS,
	ALLOWED_ATTR: SVG_ATTRIBUTES,
	ALLOW_ARIA_ATTR: false,
	ALLOW_DATA_ATTR: false,
	ALLOW_UNKNOWN_PROTOCOLS: false,
	FORBID_TAGS: [
		"script",
		"foreignObject",
		"a",
		"image",
		"use",
		"iframe",
		"object",
		"embed",
		"animate",
		"animateMotion",
		"animateTransform",
		"set",
	],
	FORBID_ATTR: ["href", "xlink:href", "src"],
} satisfies Record<string, unknown>;

export type MermaidSvgSanitizer = (
	dirty: string,
	options: typeof MERMAID_SVG_SANITIZE_OPTIONS,
) => unknown;

function applyLocalFonts(svg: string): string {
	return svg
		.replace(/^\s*@import\s+url\([^\n]+\);?\s*$/gimu, "")
		.replace(
			/text\s*\{\s*font-family:\s*'[^']*',\s*system-ui,\s*sans-serif;\s*\}/u,
			"text { font-family: var(--pi-font-message), system-ui, sans-serif; }",
		)
		.replace(
			/\.mono\s*\{\s*font-family:[^}]+\}/u,
			".mono { font-family: var(--pi-font-code), ui-monospace, monospace; }",
		);
}

function namespaceSvgIds(svg: string, namespace: string): string {
	const prefix = namespace.replace(/[^A-Za-z0-9_-]/gu, "-") || "pi-mermaid";
	const ids = new Map<string, string>();
	const withNamespacedIds = svg.replace(/\bid="([^"]+)"/gu, (_match, id: string) => {
		const namespacedId = `${prefix}-${id}`;
		ids.set(id, namespacedId);
		return `id="${namespacedId}"`;
	});

	return withNamespacedIds
		.replace(/url\(\s*#([^)\s]+)\s*\)/gu, (match, id: string) => {
			const namespacedId = ids.get(id);
			return namespacedId ? `url(#${namespacedId})` : match;
		})
		.replace(/\b((?:xlink:)?href)="#([^"]+)"/gu, (match, attribute: string, id: string) => {
			const namespacedId = ids.get(id);
			return namespacedId ? `${attribute}="#${namespacedId}"` : match;
		});
}

function assertSafeSvg(svg: string): void {
	const trimmed = svg.trim();
	if (
		trimmed.length === 0 ||
		trimmed.length > MAX_MERMAID_SVG_LENGTH ||
		!/^<svg(?:\s|>)/iu.test(trimmed) ||
		!/<\/svg>$/iu.test(trimmed)
	) {
		throw new Error("Mermaid renderer did not produce a bounded SVG document.");
	}
	if ((trimmed.match(/<svg(?:\s|>)/giu) ?? []).length !== 1) {
		throw new Error("Nested Mermaid SVG documents are not allowed.");
	}
	if (
		/<\s*\/?\s*(?:script|foreignObject|a|image|use|iframe|object|embed|animate(?:Motion|Transform)?|set)\b/iu.test(
			trimmed,
		) ||
		/<!\s*(?:doctype|entity)/iu.test(trimmed)
	) {
		throw new Error("Unsafe content was removed from the Mermaid diagram.");
	}

	const assertSafeCss = (value: string) => {
		if (
			/@(?:import|font-face|namespace)\b|expression\s*\(|-moz-binding\s*:|behavior\s*:/iu.test(
				value,
			) ||
			/(?:^|[\s;])on[a-z]+\s*=/iu.test(value)
		) {
			throw new Error("Unsafe content was removed from the Mermaid diagram.");
		}
		for (const match of value.matchAll(/\burl\s*\(([^)]*)\)/giu)) {
			const destination = match[1]?.trim().replace(/^(['"])(.*)\1$/u, "$2") ?? "";
			if (!/^#[A-Za-z_][A-Za-z0-9_.:-]*$/u.test(destination)) {
				throw new Error("External Mermaid resources are not allowed.");
			}
		}
	};

	for (const match of trimmed.matchAll(
		/\s([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu,
	)) {
		const name = match[1]?.toLowerCase() ?? "";
		const value = match[2] ?? match[3] ?? "";
		if (name === "href" || name === "xlink:href" || name === "src" || name.startsWith("on")) {
			throw new Error("Unsafe content was removed from the Mermaid diagram.");
		}
		if (
			name === "style" ||
			name === "fill" ||
			name === "stroke" ||
			name === "marker-start" ||
			name === "marker-end"
		) {
			assertSafeCss(value);
		}
	}
	for (const style of trimmed.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/giu)) {
		assertSafeCss(style[1] ?? "");
	}
}

export function sanitizeMermaidSvg(svg: string, sanitize: MermaidSvgSanitizer): string {
	const sanitized = String(sanitize(svg, MERMAID_SVG_SANITIZE_OPTIONS));
	assertSafeSvg(sanitized);
	return sanitized;
}

export function renderModernMermaid(source: string, namespace: string): string {
	const normalized = source.trim();
	if (!normalized) throw new TypeError("Mermaid source is required.");
	if (
		normalized.length > MAX_MERMAID_SOURCE_LENGTH ||
		normalized.split("\n").length > MAX_MERMAID_SOURCE_LINES
	) {
		throw new RangeError("Mermaid source is too large to render safely.");
	}

	return namespaceSvgIds(applyLocalFonts(renderMermaidSVG(normalized, MODERN_THEME)), namespace);
}
