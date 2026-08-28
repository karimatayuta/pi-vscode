import DOMPurify from "dompurify";
import type { JSX } from "preact";
import type { KeyboardEvent } from "preact/compat";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { renderModernMermaid, sanitizeMermaidSvg } from "../beautiful-mermaid.js";
import { postIntent } from "../bridge.js";
import { writeClipboard } from "../clipboard.js";
import { renderMarkdown } from "../markdown-renderer.js";
import type { ReferenceDescriptor } from "../types.js";

let markdownInstanceCounter = 0;

interface MarkdownProps {
	readonly text: string;
	readonly references?: readonly ReferenceDescriptor[];
	readonly streaming?: boolean;
}

type ReferenceAction = "open" | "openBeside" | "reveal" | "copyPath";

interface ReferenceMenuState {
	readonly reference: ReferenceDescriptor;
	readonly x: number;
	readonly y: number;
	readonly opener: HTMLElement;
}

interface CopyStatus {
	readonly block: number;
	readonly state: "copied" | "failed";
}

type MermaidCacheEntry =
	| { readonly state: "rendered"; readonly svg: string }
	| { readonly state: "error" };

export function Markdown({ text, references = [], streaming = false }: MarkdownProps) {
	const [menu, setMenu] = useState<ReferenceMenuState>();
	const [copyStatus, setCopyStatus] = useState<CopyStatus>();
	const menuRef = useRef<HTMLDivElement>(null);
	const markdownRef = useRef<HTMLDivElement>(null);
	const copyResetTimer = useRef<number>();
	const mermaidNamespaceRef = useRef<string>();
	const mermaidCacheRef = useRef<Map<string, MermaidCacheEntry>>(new Map());
	if (!mermaidNamespaceRef.current) {
		markdownInstanceCounter += 1;
		mermaidNamespaceRef.current = `pi-mermaid-${markdownInstanceCounter}`;
	}
	const html = useMemo(
		() =>
			DOMPurify.sanitize(
				renderMarkdown(text, {
					references,
					streaming,
					...(copyStatus?.state === "copied" ? { copiedCodeBlock: copyStatus.block } : {}),
				}),
				{
					ALLOWED_TAGS: [
						"div",
						"figure",
						"span",
						"small",
						"button",
						"p",
						"br",
						"strong",
						"em",
						"s",
						"blockquote",
						"ul",
						"ol",
						"li",
						"pre",
						"code",
						"h1",
						"h2",
						"h3",
						"h4",
						"h5",
						"h6",
						"a",
						"hr",
						"table",
						"thead",
						"tbody",
						"tr",
						"th",
						"td",
					],
					ALLOWED_ATTR: [
						"class",
						"href",
						"title",
						"type",
						"role",
						"start",
						"scope",
						"aria-label",
						"aria-disabled",
						"aria-hidden",
						"aria-live",
						"data-code-block",
						"data-mermaid-block",
						"data-ref-id",
						"data-ref-epoch",
					],
					ALLOW_DATA_ATTR: false,
					ALLOW_ARIA_ATTR: false,
				},
			),
		[text, references, streaming, copyStatus],
	);

	useEffect(() => {
		setCopyStatus(undefined);
	}, [text]);

	useEffect(
		() => () => {
			if (copyResetTimer.current !== undefined) window.clearTimeout(copyResetTimer.current);
		},
		[],
	);

	useEffect(() => {
		const root = markdownRef.current;
		if (!root || streaming) return;
		const namespace = mermaidNamespaceRef.current;
		if (!namespace) return;

		const liveCacheKeys = new Set<string>();
		for (const figure of root.querySelectorAll<HTMLElement>(".mermaid-figure")) {
			const source = figure.querySelector<HTMLElement>(".mermaid-source code")?.textContent ?? "";
			const host = figure.querySelector<HTMLElement>(".mermaid-render");
			const status = figure.querySelector<HTMLElement>(".mermaid-status");
			const block = Number(figure.dataset.mermaidBlock);
			if (!host || !status || !Number.isSafeInteger(block)) continue;

			const cacheKey = `${block}\u0000${source}`;
			liveCacheKeys.add(cacheKey);
			let result = mermaidCacheRef.current.get(cacheKey);
			if (!result) {
				try {
					const rawSvg = renderModernMermaid(source, `${namespace}-${block}`);
					const svg = sanitizeMermaidSvg(rawSvg, (dirty, options) =>
						DOMPurify.sanitize(dirty, options),
					);
					result = { state: "rendered", svg };
				} catch {
					result = { state: "error" };
				}
				mermaidCacheRef.current.set(cacheKey, result);
			}

			if (result.state === "rendered") {
				// The only HTML entering this sink is the locally rendered SVG after a
				// dedicated SVG allowlist and external-resource postcondition.
				host.innerHTML = result.svg;
				const svg = host.querySelector("svg");
				svg?.setAttribute("aria-hidden", "true");
				svg?.setAttribute("focusable", "false");
				figure.classList.add("rendered");
				figure.classList.remove("mermaid-error", "mermaid-pending");
				status.textContent = "Mermaid diagram rendered.";
				status.classList.add("sr-only");
			} else {
				host.replaceChildren();
				figure.classList.add("mermaid-error");
				figure.classList.remove("rendered", "mermaid-pending");
				status.textContent =
					"This Mermaid diagram could not be rendered. Its source is shown below.";
				status.classList.remove("sr-only");
			}
		}

		if (mermaidCacheRef.current.size > 32) {
			for (const key of mermaidCacheRef.current.keys()) {
				if (!liveCacheKeys.has(key)) mermaidCacheRef.current.delete(key);
				if (mermaidCacheRef.current.size <= 32) break;
			}
		}
	}, [html, streaming]);

	useEffect(() => {
		if (!menu) return undefined;
		menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
		const closeFromPointer = (event: PointerEvent) => {
			if (!menuRef.current?.contains(event.target as Node)) setMenu(undefined);
		};
		const closeFromKeyboard = (event: globalThis.KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			setMenu(undefined);
			menu.opener.focus();
		};
		window.addEventListener("pointerdown", closeFromPointer);
		window.addEventListener("keydown", closeFromKeyboard);
		return () => {
			window.removeEventListener("pointerdown", closeFromPointer);
			window.removeEventListener("keydown", closeFromKeyboard);
		};
	}, [menu]);

	const openReference = (reference: ReferenceDescriptor, action: ReferenceAction) => {
		postIntent({
			type: "openReference",
			refId: reference.refId,
			epoch: reference.epoch,
			action,
		});
		setMenu(undefined);
	};

	const openMenu = (event: MouseEvent, reference: ReferenceDescriptor, opener?: HTMLElement) => {
		event.preventDefault();
		const width = 190;
		const estimatedHeight = reference.kind === "external" ? 82 : 154;
		setMenu({
			reference,
			x: Math.max(6, Math.min(event.clientX, window.innerWidth - width - 6)),
			y: Math.max(6, Math.min(event.clientY, window.innerHeight - estimatedHeight - 6)),
			opener: opener ?? (event.currentTarget as HTMLElement),
		});
	};

	const referenceFromElement = (element: Element): ReferenceDescriptor | undefined => {
		const id = element.getAttribute("data-ref-id");
		const epoch = element.getAttribute("data-ref-epoch");
		return references.find((reference) => reference.refId === id && reference.epoch === epoch);
	};

	const handleContentClick = async (event: JSX.TargetedMouseEvent<HTMLDivElement>) => {
		const target = event.target;
		if (!(target instanceof Element)) return;
		const copyButton = target.closest<HTMLButtonElement>(".code-copy-button, .mermaid-copy-button");
		if (copyButton && markdownRef.current?.contains(copyButton)) {
			event.preventDefault();
			const block = Number(copyButton.getAttribute("data-code-block"));
			const code = copyButton
				.closest(".code-block, .mermaid-figure")
				?.querySelector("pre code")?.textContent;
			if (!Number.isSafeInteger(block) || code === undefined) return;
			const copied = await writeClipboard(code);
			setCopyStatus({ block, state: copied ? "copied" : "failed" });
			if (copyResetTimer.current !== undefined) window.clearTimeout(copyResetTimer.current);
			copyResetTimer.current = window.setTimeout(() => setCopyStatus(undefined), 1_800);
			return;
		}

		const anchor = target.closest<HTMLAnchorElement>("a.markdown-link");
		if (!anchor || !markdownRef.current?.contains(anchor)) return;
		event.preventDefault();
		const reference = referenceFromElement(anchor);
		if (reference) openReference(reference, "open");
	};

	const handleContentMenu = (event: JSX.TargetedMouseEvent<HTMLDivElement>) => {
		const target = event.target;
		if (!(target instanceof Element)) return;
		const anchor = target.closest<HTMLAnchorElement>("a.markdown-link");
		if (!anchor || !markdownRef.current?.contains(anchor)) return;
		const reference = referenceFromElement(anchor);
		if (reference) openMenu(event as unknown as MouseEvent, reference, anchor);
	};

	const moveMenuFocus = (event: KeyboardEvent<HTMLDivElement>) => {
		if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
		const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitem']")];
		if (items.length === 0) return;
		event.preventDefault();
		const current = items.indexOf(document.activeElement as HTMLButtonElement);
		const next =
			event.key === "Home"
				? 0
				: event.key === "End"
					? items.length - 1
					: event.key === "ArrowDown"
						? (current + 1) % items.length
						: (current - 1 + items.length) % items.length;
		items[next]?.focus();
	};

	return (
		<div class="markdown-wrap" aria-busy={streaming || undefined}>
			{/* Event delegation only observes native buttons/anchors rendered inside the sanitized markup. */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: native buttons and anchors already emit keyboard click events */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: the wrapper itself is not an interactive target */}
			<div
				ref={markdownRef}
				class="markdown"
				onClick={handleContentClick}
				onContextMenu={handleContentMenu}
				dangerouslySetInnerHTML={{ __html: html }}
			/>
			<span class="sr-only" role="status" aria-live="polite">
				{copyStatus?.state === "copied"
					? "Code copied to clipboard"
					: copyStatus?.state === "failed"
						? "Could not copy code"
						: ""}
			</span>
			{references.length > 0 ? (
				<fieldset class="message-references">
					<legend class="sr-only">Links and file references</legend>
					{references.map((reference) => (
						<button
							class="reference-link"
							type="button"
							key={reference.refId}
							aria-label={reference.ariaLabel}
							aria-haspopup="menu"
							aria-expanded={menu?.reference.refId === reference.refId}
							title="Open; right-click for more actions"
							onClick={() => openReference(reference, "open")}
							onContextMenu={(event) => openMenu(event as unknown as MouseEvent, reference)}
						>
							<span aria-hidden="true">
								{reference.kind === "external" ? "↗" : reference.kind === "folder" ? "▣" : "▤"}
							</span>
							<span>{reference.label}</span>
						</button>
					))}
				</fieldset>
			) : null}
			{menu ? (
				<div
					ref={menuRef}
					class="popover reference-menu"
					role="menu"
					aria-label={`Actions for ${menu.reference.label}`}
					style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
					onKeyDown={moveMenuFocus}
				>
					<button
						type="button"
						role="menuitem"
						onClick={() => openReference(menu.reference, "open")}
					>
						Open
					</button>
					{menu.reference.kind !== "external" ? (
						<button
							type="button"
							role="menuitem"
							onClick={() => openReference(menu.reference, "openBeside")}
						>
							Open to Side
						</button>
					) : null}
					{menu.reference.kind !== "external" ? (
						<button
							type="button"
							role="menuitem"
							onClick={() => openReference(menu.reference, "reveal")}
						>
							Reveal in Explorer
						</button>
					) : null}
					<button
						type="button"
						role="menuitem"
						onClick={() => openReference(menu.reference, "copyPath")}
					>
						{menu.reference.kind === "external" ? "Copy Link" : "Copy Path"}
					</button>
				</div>
			) : null}
		</div>
	);
}
