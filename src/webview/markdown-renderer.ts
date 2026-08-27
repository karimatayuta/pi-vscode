import MarkdownIt, { type Env, type StateCore, type Token } from "markdown-it";
import type { ReferenceDescriptor } from "./types.js";

const MAX_LANGUAGE_LABEL_LENGTH = 40;

interface MarkdownEnvironment extends Env {
	piReferences: readonly ReferenceDescriptor[];
	piCodeBlockIndex: number;
	piStreaming: boolean;
	piCopiedCodeBlock?: number;
}

export interface MarkdownRenderOptions {
	readonly references?: readonly ReferenceDescriptor[];
	readonly streaming?: boolean;
	readonly copiedCodeBlock?: number;
}

function environment(value: Env | undefined): MarkdownEnvironment | undefined {
	if (!value || !Array.isArray(value.piReferences)) return undefined;
	return value as MarkdownEnvironment;
}

function languageLabel(info: string): { readonly label: string; readonly slug: string } {
	const raw = info.trim().split(/\s+/u, 1)[0]?.slice(0, MAX_LANGUAGE_LABEL_LENGTH) ?? "";
	const label = raw || "text";
	const slug = label.toLowerCase().replace(/[^a-z0-9_+#.-]/gu, "") || "text";
	return { label, slug };
}

function decodedDestination(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/**
 * Only destinations already registered by the extension host can become
 * interactive. The Webview never opens an arbitrary href directly.
 */
function referenceForDestination(
	destination: string,
	references: readonly ReferenceDescriptor[],
): ReferenceDescriptor | undefined {
	const decoded = decodedDestination(destination);
	return references.find((reference) => {
		if (reference.label === destination || reference.label === decoded) return true;
		if (reference.kind !== "external") return false;
		try {
			const target = new URL(decoded);
			const label = new URL(reference.label);
			return (
				(target.protocol === "http:" || target.protocol === "https:") &&
				!target.username &&
				!target.password &&
				target.href === label.href
			);
		} catch {
			return false;
		}
	});
}

function addClass(token: Token | undefined, className: string): void {
	if (!token) return;
	const classes = String(token.attrGet("class") ?? "").split(/\s+/u);
	if (!classes.includes(className)) token.attrJoin("class", className);
}

function markTaskItems(state: StateCore): void {
	for (let index = 0; index < state.tokens.length; index += 1) {
		const inline = state.tokens[index];
		if (inline?.type !== "inline" || !inline.children?.length) continue;
		const firstTextIndex = inline.children.findIndex((child) => child.type === "text");
		if (firstTextIndex < 0) continue;
		const firstText = inline.children[firstTextIndex];
		if (!firstText) continue;
		const marker = /^\[([ xX])\]\s+/u.exec(firstText.content);
		if (!marker) continue;

		let itemOpenIndex = -1;
		for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
			const candidate = state.tokens[cursor];
			if (candidate?.type === "list_item_close") break;
			if (candidate?.type === "list_item_open") {
				itemOpenIndex = cursor;
				break;
			}
		}
		if (itemOpenIndex < 0) continue;

		firstText.content = firstText.content.slice(marker[0].length);
		const checkbox = new state.Token("task_checkbox", "span", 0);
		checkbox.meta = { checked: marker[1]?.toLowerCase() === "x" };
		inline.children.splice(firstTextIndex, 0, checkbox);
		addClass(state.tokens[itemOpenIndex], "task-list-item");

		for (let cursor = itemOpenIndex - 1; cursor >= 0; cursor -= 1) {
			const candidate = state.tokens[cursor];
			if (candidate?.type === "bullet_list_open" || candidate?.type === "ordered_list_open") {
				addClass(candidate, "task-list");
				break;
			}
		}
	}
}

/**
 * linkify-it accepts Unicode path characters, which can absorb adjacent CJK
 * prose into a bare URL. The host intentionally registers a conservative ASCII
 * URL boundary; split the suffix back into ordinary text so the visible link
 * and the host-issued opaque reference stay identical.
 */
function alignBareLinksWithReferences(state: StateCore): void {
	const references = environment(state.env)?.piReferences ?? [];
	const external = references.filter((reference) => reference.kind === "external");
	if (external.length === 0) return;
	for (const inline of state.tokens) {
		if (inline.type !== "inline" || !inline.children) continue;
		for (let index = 0; index < inline.children.length - 2; index += 1) {
			const open = inline.children[index];
			const text = inline.children[index + 1];
			const close = inline.children[index + 2];
			if (
				open?.type !== "link_open" ||
				open.markup !== "linkify" ||
				text?.type !== "text" ||
				close?.type !== "link_close"
			)
				continue;
			const reference = external.find(
				(candidate) =>
					text.content.startsWith(candidate.label) &&
					text.content.length > candidate.label.length &&
					(text.content.codePointAt(candidate.label.length) ?? 0) > 0x7f,
			);
			if (!reference) continue;
			const suffix = text.content.slice(reference.label.length);
			open.attrSet("href", reference.label);
			text.content = reference.label;
			const suffixToken = new state.Token("text", "", 0);
			suffixToken.content = suffix;
			inline.children.splice(index + 3, 0, suffixToken);
			index += 3;
		}
	}
}

function createMarkdown() {
	const instance = new MarkdownIt({
		html: false,
		linkify: true,
		breaks: true,
		typographer: false,
	});

	instance.core.ruler.after("inline", "pi-reference-boundaries", alignBareLinksWithReferences);
	instance.core.ruler.after("pi-reference-boundaries", "pi-task-lists", markTaskItems);

	instance.renderer.rules.task_checkbox = (tokens, index) => {
		const checked = tokens[index]?.meta?.checked === true;
		return `<span class="task-checkbox${checked ? " checked" : ""}" role="img" aria-label="${checked ? "Completed" : "Not completed"}">${checked ? "&#10003;" : ""}</span>`;
	};

	const renderTableCell = (
		tokens: Token[],
		index: number,
		options: Parameters<NonNullable<(typeof instance.renderer.rules)["th_open"]>>[2],
		renderer: Parameters<NonNullable<(typeof instance.renderer.rules)["th_open"]>>[4],
	) => {
		const token = tokens[index];
		if (!token) return "";
		const alignment = String(token.attrGet("style") ?? "").match(
			/^text-align:(left|center|right)$/u,
		)?.[1];
		token.attrs = token.attrs?.filter(([name]) => name !== "style") ?? null;
		if (alignment) addClass(token, `align-${alignment}`);
		if (token.tag === "th") token.attrSet("scope", "col");
		return renderer.renderToken(tokens, index, options);
	};
	instance.renderer.rules.th_open = (tokens, index, options, _environment, renderer) =>
		renderTableCell(tokens, index, options, renderer);
	instance.renderer.rules.td_open = (tokens, index, options, _environment, renderer) =>
		renderTableCell(tokens, index, options, renderer);

	instance.renderer.rules.fence = (tokens, index, _options, rawEnvironment) => {
		const token = tokens[index];
		if (!token) return "";
		const env = environment(rawEnvironment);
		const blockIndex = env?.piCodeBlockIndex ?? 0;
		if (env) env.piCodeBlockIndex += 1;
		const language = languageLabel(token.info);
		const copied = env?.piCopiedCodeBlock === blockIndex;
		if (language.slug === "mermaid") {
			const pending = env?.piStreaming === true;
			const status = pending
				? "Diagram source is streaming. It will render when the response is complete."
				: "Rendering Mermaid diagram…";
			return `<figure class="mermaid-figure${pending ? " mermaid-pending" : ""}" data-mermaid-block="${blockIndex}" aria-label="Mermaid diagram ${blockIndex + 1}"><div class="mermaid-header"><span class="mermaid-language">Mermaid</span><button class="mermaid-copy-button" type="button" data-code-block="${blockIndex}" aria-label="${copied ? "Mermaid source copied" : "Copy Mermaid source"}">${copied ? "Copied" : "Copy"}</button></div><div class="mermaid-render" role="img" aria-label="Rendered Mermaid diagram ${blockIndex + 1}"></div><pre class="mermaid-source"><code class="language-mermaid">${instance.utils.escapeHtml(token.content)}</code></pre><p class="mermaid-status" role="status" aria-live="polite">${status}</p></figure>`;
		}
		return `<div class="code-block"><div class="code-block-header"><span class="code-language">${instance.utils.escapeHtml(language.label)}</span><button class="code-copy-button" type="button" data-code-block="${blockIndex}" aria-label="${copied ? "Code copied" : "Copy code"}">${copied ? "Copied" : "Copy"}</button></div><pre><code class="language-${language.slug}">${instance.utils.escapeHtml(token.content)}</code></pre></div>`;
	};

	instance.renderer.rules.code_block = (tokens, index, options, rawEnvironment) => {
		const token = tokens[index];
		if (!token) return "";
		return (
			instance.renderer.rules.fence?.(
				[{ ...token, info: "" } as Token],
				0,
				options,
				rawEnvironment,
				instance.renderer,
			) ?? ""
		);
	};

	instance.renderer.rules.link_open = (tokens, index, options, rawEnvironment, renderer) => {
		const token = tokens[index];
		if (!token) return "";
		const destination = String(token.attrGet("href") ?? "");
		const reference = referenceForDestination(
			destination,
			environment(rawEnvironment)?.piReferences ?? [],
		);
		token.attrSet("href", "#");
		token.attrJoin("class", "markdown-link");
		if (reference) {
			token.attrSet("data-ref-id", reference.refId);
			token.attrSet("data-ref-epoch", reference.epoch);
			token.attrSet("title", reference.ariaLabel);
		} else {
			token.attrSet("aria-disabled", "true");
			token.attrSet("title", "This link is not available through the Pi Agent safety gate");
		}
		return renderer.renderToken(tokens, index, options);
	};

	// Remote and data images are deliberately never loaded in the Webview. The
	// registered source remains available as a safety-gated reference below the
	// message, without leaking a request to an untrusted server.
	instance.renderer.rules.image = (tokens, index) => {
		const token = tokens[index];
		const alt = token?.content.trim() || "Image";
		return `<span class="markdown-image-placeholder" role="img" aria-label="Image preview hidden: ${instance.utils.escapeHtml(alt)}"><span aria-hidden="true">&#9638;</span><span>${instance.utils.escapeHtml(alt)}</span><small>Preview hidden for privacy</small></span>`;
	};

	return instance;
}

const markdown = createMarkdown();

/**
 * Keeps an unfinished fenced block contained while response text is arriving.
 * Markdown-it already tolerates an omitted closing fence; adding one makes the
 * intent explicit and avoids a partially streamed suffix changing containers.
 */
export function stabilizeStreamingMarkdown(source: string, streaming: boolean): string {
	if (!streaming) return source;
	let openFence: { readonly marker: "`" | "~"; readonly length: number } | undefined;
	for (const line of source.split("\n")) {
		const match = /^\s{0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
		const run = match?.[1];
		if (!run) continue;
		const marker = run[0] as "`" | "~";
		if (!openFence) {
			openFence = { marker, length: run.length };
			continue;
		}
		if (
			marker === openFence.marker &&
			run.length >= openFence.length &&
			(match?.[2]?.trim().length ?? 0) === 0
		) {
			openFence = undefined;
		}
	}
	return openFence ? `${source}\n${openFence.marker.repeat(openFence.length)}` : source;
}

export function renderMarkdown(source: string, options: MarkdownRenderOptions = {}): string {
	const environment: MarkdownEnvironment = {
		piReferences: options.references ?? [],
		piCodeBlockIndex: 0,
		piStreaming: options.streaming === true,
		...(options.copiedCodeBlock === undefined
			? {}
			: { piCopiedCodeBlock: options.copiedCodeBlock }),
	};
	return markdown.render(
		stabilizeStreamingMarkdown(source, options.streaming === true),
		environment,
	);
}
