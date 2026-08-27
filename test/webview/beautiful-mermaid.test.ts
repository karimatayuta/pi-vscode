import { describe, expect, test } from "bun:test";
import {
	MERMAID_SVG_SANITIZE_OPTIONS,
	renderModernMermaid,
	sanitizeMermaidSvg,
} from "../../src/webview/beautiful-mermaid.js";

const supportedDiagrams = [
	"flowchart LR\nA[Start] --> B{Done?}",
	"stateDiagram-v2\n[*] --> Idle\nIdle --> [*]",
	"sequenceDiagram\nAlice->>Bob: Hello",
	"classDiagram\nAnimal <|-- Duck",
	"erDiagram\nCUSTOMER ||--o{ ORDER : places",
	"xychart-beta\nx-axis [Jan, Feb]\nbar [1, 2]",
] as const;

describe("beautiful Mermaid renderer", () => {
	test("renders all six supported diagram families with local Pi theme variables", () => {
		for (const [index, source] of supportedDiagrams.entries()) {
			const svg = renderModernMermaid(source, `test-${index}`);
			expect(svg).toStartWith("<svg");
			expect(svg).toContain("var(--pi-background)");
			expect(svg).toContain("var(--pi-text)");
			expect(svg).toContain("var(--pi-font-message)");
			expect(svg).not.toContain("fonts.googleapis.com");
			expect(svg).not.toContain("@import");
		}
	});

	test("namespaces SVG definitions and their local fragment references per diagram", () => {
		const first = renderModernMermaid("flowchart LR\nA --> B", "message-1-block-0");
		const second = renderModernMermaid("flowchart LR\nA --> B", "message-2-block-0");
		const firstIds = [...first.matchAll(/\bid="([^"]+)"/gu)].map((match) => match[1]);
		const secondIds = [...second.matchAll(/\bid="([^"]+)"/gu)].map((match) => match[1]);

		expect(firstIds.length).toBeGreaterThan(0);
		expect(firstIds.every((id) => id?.startsWith("message-1-block-0-"))).toBe(true);
		expect(secondIds.every((id) => id?.startsWith("message-2-block-0-"))).toBe(true);
		expect(first).toContain(`url(#${firstIds[0]})`);
		expect(new Set([...firstIds, ...secondIds]).size).toBe(firstIds.length + secondIds.length);
	});

	test("uses a narrow SVG sanitizer policy with no executable or external-resource elements", () => {
		expect(MERMAID_SVG_SANITIZE_OPTIONS.FORBID_TAGS).toContain("script");
		expect(MERMAID_SVG_SANITIZE_OPTIONS.FORBID_TAGS).toContain("foreignObject");
		expect(MERMAID_SVG_SANITIZE_OPTIONS.FORBID_TAGS).toContain("image");
		expect(MERMAID_SVG_SANITIZE_OPTIONS.FORBID_ATTR).toContain("href");
		expect(MERMAID_SVG_SANITIZE_OPTIONS.ALLOW_DATA_ATTR).toBe(false);
	});

	test("accepts a sanitized local SVG but rejects executable and external URL output", () => {
		const local = renderModernMermaid("flowchart LR\nA --> B", "safe");
		expect(sanitizeMermaidSvg(local, (dirty) => dirty)).toBe(local);
		expect(() =>
			sanitizeMermaidSvg(
				'<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
				(dirty) => dirty,
			),
		).toThrow("Unsafe content");
		expect(() =>
			sanitizeMermaidSvg(
				'<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://example.com/a.svg)" /></svg>',
				(dirty) => dirty,
			),
		).toThrow("External Mermaid resources");
	});

	test("does not mistake a visible URL label for an external SVG resource", () => {
		const svg = renderModernMermaid(
			"flowchart LR\nA[Visit https://example.com/docs] --> B[Done]",
			"url-label",
		);

		expect(sanitizeMermaidSvg(svg, (dirty) => dirty)).toBe(svg);
		expect(svg).toContain("https://example.com/docs");
	});

	test("fails closed when a suspicious style directive survives sanitization", () => {
		const svg = renderModernMermaid(
			'flowchart LR\nA --> B\nlinkStyle 0 stroke:red" onload="alert(1)',
			"hostile-style",
		);

		expect(svg).not.toContain(' onload="');
		expect(svg).not.toContain("<script");
		expect(svg).toContain("&quot;");
		expect(() => sanitizeMermaidSvg(svg, (dirty) => dirty)).toThrow("Unsafe content");
	});

	test("bounds synchronous rendering work", () => {
		expect(() => renderModernMermaid("", "empty")).toThrow("source is required");
		expect(() => renderModernMermaid(`flowchart LR\n${"A".repeat(50_001)}`, "large")).toThrow(
			"too large",
		);
	});
});
