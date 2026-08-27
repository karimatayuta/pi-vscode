import { describe, expect, test } from "bun:test";
import { renderMarkdown, stabilizeStreamingMarkdown } from "../../src/webview/markdown-renderer.js";
import type { ReferenceDescriptor } from "../../src/webview/types.js";

const externalReference: ReferenceDescriptor = {
	refId: "reference-1",
	epoch: "epoch-1",
	label: "https://example.com/docs",
	kind: "external",
	ariaLabel: "Open documentation in browser",
};

const encodedWorkspaceReference: ReferenceDescriptor = {
	refId: "reference-2",
	epoch: "epoch-1",
	label: "src/My File.ts:12",
	kind: "file",
	ariaLabel: "Open src/My File.ts at line 12 in the editor",
};

describe("rich Markdown renderer", () => {
	test("renders document structure, tables, task lists and inline styles", () => {
		const html = renderMarkdown(`
# Result

> A quiet quote with **strong**, *emphasis*, ~~removed~~ and \`inline()\`.

| File | State |
| --- | ---: |
| auth.ts | ready |

- [x] inspected
- [ ] apply change

---
`);

		expect(html).toContain("<h1>Result</h1>");
		expect(html).toContain("<blockquote>");
		expect(html).toContain("<strong>strong</strong>");
		expect(html).toContain("<code>inline()</code>");
		expect(html).toContain("<table>");
		expect(html).toContain('class="align-right" scope="col"');
		expect(html).toContain('class="task-list"');
		expect(html).toContain('class="task-checkbox checked"');
		expect(html).toContain('aria-label="Not completed"');
		expect(html).toContain("<hr>");
	});

	test("adds a language header and copy control without trusting code contents", () => {
		const html = renderMarkdown('```TypeScript title="unsafe"\nconst value = "<script>";\n```');

		expect(html).toContain('class="code-language">TypeScript</span>');
		expect(html).toContain('class="code-copy-button"');
		expect(html).toContain('data-code-block="0"');
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain("<script>");
	});

	test("emits Mermaid fences as escaped render targets with source fallback", () => {
		const html = renderMarkdown(
			'```mermaid\nflowchart LR\nA["<script>"] --> B\n```\n\n```ts\nconst ok = true;\n```\n\n```MERMAID\nsequenceDiagram\nA->>B: Hi\n```',
		);

		expect(html).toContain('class="mermaid-figure"');
		expect(html).toContain('data-mermaid-block="0"');
		expect(html).toContain('data-mermaid-block="2"');
		expect(html).toContain('class="mermaid-render" role="img"');
		expect(html).toContain('class="mermaid-copy-button"');
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain("<script>");
		expect(html).toContain('data-code-block="1"');
	});

	test("only enables links registered by the extension safety gate", () => {
		const enabled = renderMarkdown("[Documentation](https://example.com/docs)", {
			references: [externalReference],
		});
		const disabled = renderMarkdown("[Unregistered](https://untrusted.example/path)", {
			references: [externalReference],
		});

		expect(enabled).toContain('href="#"');
		expect(enabled).toContain('data-ref-id="reference-1"');
		expect(enabled).toContain('data-ref-epoch="epoch-1"');
		expect(enabled).not.toContain('href="https://example.com/docs"');
		expect(disabled).toContain('aria-disabled="true"');
		expect(disabled).not.toContain("data-ref-id");
	});

	test("keeps adjacent Japanese prose outside a registered bare URL", () => {
		const html = renderMarkdown("https://example.com/docsを参照します。", {
			references: [externalReference],
		});

		expect(html).toContain('data-ref-id="reference-1"');
		expect(html).toContain(">https://example.com/docs</a>を参照します。");
		expect(html).not.toContain("docsを参照します</a>");
	});

	test("matches encoded Markdown file destinations only to their opaque host reference", () => {
		const enabled = renderMarkdown("[Open file](src/My%20File.ts:12)", {
			references: [encodedWorkspaceReference],
		});

		expect(enabled).toContain('href="#"');
		expect(enabled).toContain('data-ref-id="reference-2"');
		expect(enabled).toContain('data-ref-epoch="epoch-1"');
		expect(enabled).not.toContain("src/My%20File.ts:12");
	});

	test("never emits raw HTML, unsafe URI anchors or image requests", () => {
		const html = renderMarkdown(`
<script>alert("xss")</script>

[Run](javascript:alert(1))

![tracking pixel](https://tracker.example/pixel.png)
`);

		expect(html).not.toContain("<script>");
		expect(html).not.toContain('href="javascript:');
		expect(html).not.toContain("<img");
		expect(html).not.toContain('src="');
		expect(html).toContain('class="markdown-image-placeholder"');
		expect(html).toContain("Preview hidden for privacy");
	});

	test("contains an unfinished fenced block while streaming", () => {
		const source = "Before\n\n```ts\nconst answer = 42;";
		const stabilized = stabilizeStreamingMarkdown(source, true);
		const html = renderMarkdown(source, { streaming: true });

		expect(stabilized).toEndWith("\n```");
		expect(html).toContain('class="code-block"');
		expect(html).toContain("const answer = 42;");
		expect(html).not.toContain("<p>const answer");
		expect(stabilizeStreamingMarkdown(source, false)).toBe(source);
		expect(stabilizeStreamingMarkdown("~~~md\n```\n~~~", true)).toBe("~~~md\n```\n~~~");
	});

	test("keeps a streamed Mermaid block as source until the response completes", () => {
		const html = renderMarkdown("```mermaid\nflowchart LR\nA -->", { streaming: true });

		expect(html).toContain('class="mermaid-figure mermaid-pending"');
		expect(html).toContain("It will render when the response is complete.");
		expect(html).toContain("flowchart LR");
	});
});
