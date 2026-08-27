import { useMemo, useRef, useState } from "preact/hooks";
import {
	auditViewDesignContrast,
	isSafeAgentIconDataUri,
	isSafeAgentIconText,
	isSafeFontFamily,
} from "../../shared/view-design.js";
import { postIntent } from "../bridge.js";
import { designDraftSignal, expectDesignUpdate } from "../store.js";
import type { ViewDesign as ViewDesignValue } from "../types.js";
import { AgentAvatar } from "./AgentAvatar.js";

interface ViewDesignProps {
	readonly committed: ViewDesignValue;
	readonly initialScope: "global" | "workspace";
	readonly onClose: () => void;
}

const colorFields: readonly { key: keyof ViewDesignValue["colors"]; label: string }[] = [
	{ key: "background", label: "Background" },
	{ key: "surface", label: "Surface" },
	{ key: "text", label: "Text" },
	{ key: "muted", label: "Muted text" },
	{ key: "accent", label: "Accent" },
	{ key: "border", label: "Border" },
	{ key: "userMessage", label: "User message" },
	{ key: "assistantMessage", label: "Assistant message" },
];

function changed(left: ViewDesignValue, right: ViewDesignValue): boolean {
	return JSON.stringify(left) !== JSON.stringify(right);
}

const ACCEPTED_AGENT_ICON_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_AGENT_ICON_SOURCE_BYTES = 5 * 1_024 * 1_024;

async function createAgentIconDataUri(file: File): Promise<string> {
	if (!ACCEPTED_AGENT_ICON_TYPES.has(file.type)) {
		throw new Error("Choose a PNG, JPEG, or WebP image.");
	}
	if (file.size > MAX_AGENT_ICON_SOURCE_BYTES) {
		throw new Error("Choose an image smaller than 5 MB.");
	}
	const bitmap = await createImageBitmap(file);
	try {
		if (bitmap.width < 1 || bitmap.height < 1) throw new Error("The image is empty.");
		const sourceSize = Math.min(bitmap.width, bitmap.height);
		const sourceX = (bitmap.width - sourceSize) / 2;
		const sourceY = (bitmap.height - sourceSize) / 2;
		for (const size of [128, 112, 96, 80]) {
			const canvas = document.createElement("canvas");
			canvas.width = size;
			canvas.height = size;
			const context = canvas.getContext("2d");
			if (!context) throw new Error("This Webview cannot resize the selected image.");
			context.drawImage(bitmap, sourceX, sourceY, sourceSize, sourceSize, 0, 0, size, size);
			for (const quality of [0.9, 0.8, 0.7]) {
				const dataUri = canvas.toDataURL("image/webp", quality);
				if (isSafeAgentIconDataUri(dataUri)) return dataUri;
			}
		}
		throw new Error("The resized image is still too large. Try a simpler image.");
	} finally {
		bitmap.close();
	}
}

export function ViewDesign({ committed, initialScope, onClose }: ViewDesignProps) {
	const [scope, setScope] = useState(initialScope);
	const [openSections, setOpenSections] = useState(
		() => new Set(["agentIcon", "typography", "theme", "layout"]),
	);
	const [iconError, setIconError] = useState("");
	const imageInputRef = useRef<HTMLInputElement>(null);
	const draft = designDraftSignal.value;
	const dirty = changed(draft, committed);
	const invalidFonts = useMemo(
		() =>
			[draft.interfaceFont, draft.messageFont, draft.codeFont].filter(
				(font) => !isSafeFontFamily(font),
			),
		[draft.interfaceFont, draft.messageFont, draft.codeFont],
	);
	const invalidColors = useMemo(
		() => colorFields.filter(({ key }) => !/^#[0-9a-f]{6}$/iu.test(draft.colors[key])),
		[draft.colors],
	);
	const contrastIssues = useMemo(
		() => (invalidColors.length === 0 ? auditViewDesignContrast(draft) : []),
		[draft, invalidColors.length],
	);
	const invalidAgentIcon =
		(draft.agentIcon.kind === "text" && !isSafeAgentIconText(draft.agentIcon.text)) ||
		(draft.agentIcon.kind === "image" && !isSafeAgentIconDataUri(draft.agentIcon.imageDataUri));

	const update = <Key extends keyof ViewDesignValue>(key: Key, value: ViewDesignValue[Key]) => {
		designDraftSignal.value = { ...designDraftSignal.value, [key]: value };
	};
	const updateColor = (key: keyof ViewDesignValue["colors"], value: string) => {
		update("colors", { ...designDraftSignal.value.colors, [key]: value });
	};
	const updateAgentIcon = (patch: Partial<ViewDesignValue["agentIcon"]>) => {
		update("agentIcon", { ...designDraftSignal.value.agentIcon, ...patch });
	};
	const toggle = (section: string) => {
		const next = new Set(openSections);
		if (next.has(section)) next.delete(section);
		else next.add(section);
		setOpenSections(next);
	};
	const cancel = () => {
		if (!dirty || window.confirm("Discard View Design changes?")) {
			designDraftSignal.value = committed;
			onClose();
		}
	};

	return (
		<section class="design-view" aria-labelledby="design-heading">
			<header class="settings-header">
				<button type="button" class="icon-button" aria-label="Back to chat" onClick={cancel}>
					←
				</button>
				<div>
					<h2 id="design-heading">View Design</h2>
					{dirty ? <span class="unsaved-badge">Unsaved changes</span> : null}
				</div>
			</header>
			<div class="settings-scroll">
				<div class="design-scope-row">
					<label for="design-scope">Apply to</label>
					<select
						id="design-scope"
						value={scope}
						onChange={(event) => setScope(event.currentTarget.value as typeof scope)}
					>
						<option value="global">All workspaces</option>
						<option value="workspace">This workspace</option>
					</select>
				</div>
				<section class="design-preview" aria-label="Live design preview">
					<div class="preview-message user">Please review the attached code.</div>
					<div class="preview-message assistant">
						<AgentAvatar icon={draft.agentIcon} className="agent-avatar-preview" />
						<span>
							I’ll inspect it and propose a focused change.<code>const ready = true;</code>
						</span>
					</div>
				</section>

				<section class="settings-group">
					<button
						type="button"
						class="settings-group-heading"
						aria-expanded={openSections.has("agentIcon")}
						onClick={() => toggle("agentIcon")}
					>
						<span>{openSections.has("agentIcon") ? "⌄" : "›"} Agent icon</span>
					</button>
					{openSections.has("agentIcon") ? (
						<div class="settings-fields agent-icon-settings">
							<div class="agent-icon-showcase">
								<AgentAvatar
									icon={draft.agentIcon}
									className="agent-avatar-settings"
									label="Pi Agent icon preview"
								/>
								<span>
									<strong>Pi Agent</strong>
									<small>Shown beside assistant messages</small>
								</span>
							</div>
							<label class="settings-field">
								<span>Style</span>
								<select
									value={draft.agentIcon.kind}
									onChange={(event) =>
										updateAgentIcon({
											kind: event.currentTarget.value as ViewDesignValue["agentIcon"]["kind"],
										})
									}
								>
									<option value="geometric">Original geometric mark</option>
									<option value="text">Text or emoji</option>
									<option value="image" disabled={!draft.agentIcon.imageDataUri}>
										Custom image
									</option>
								</select>
							</label>
							{draft.agentIcon.kind === "text" ? (
								<label class="settings-field">
									<span>Character or emoji</span>
									<input
										type="text"
										value={draft.agentIcon.text}
										maxLength={32}
										aria-invalid={!isSafeAgentIconText(draft.agentIcon.text)}
										onInput={(event) => updateAgentIcon({ text: event.currentTarget.value })}
									/>
								</label>
							) : null}
							{draft.agentIcon.kind !== "image" ? (
								<div class="agent-icon-colors">
									<label>
										<span>Background</span>
										<input
											type="color"
											value={draft.agentIcon.background}
											onInput={(event) =>
												updateAgentIcon({ background: event.currentTarget.value })
											}
										/>
									</label>
									<label>
										<span>Mark</span>
										<input
											type="color"
											value={draft.agentIcon.foreground}
											onInput={(event) =>
												updateAgentIcon({ foreground: event.currentTarget.value })
											}
										/>
									</label>
								</div>
							) : null}
							<div class="agent-icon-image-actions">
								<input
									ref={imageInputRef}
									class="agent-icon-file-input"
									type="file"
									accept="image/png,image/jpeg,image/webp"
									aria-label="Choose a custom Pi Agent icon image"
									tabIndex={-1}
									onChange={async (event) => {
										const input = event.currentTarget;
										const file = input.files?.[0];
										input.value = "";
										if (!file) return;
										setIconError("");
										try {
											const imageDataUri = await createAgentIconDataUri(file);
											updateAgentIcon({ kind: "image", imageDataUri });
										} catch (error) {
											setIconError(
												error instanceof Error ? error.message : "The image could not be loaded.",
											);
										}
									}}
								/>
								<button type="button" onClick={() => imageInputRef.current?.click()}>
									Choose image…
								</button>
								{draft.agentIcon.imageDataUri ? (
									<button
										type="button"
										onClick={() => updateAgentIcon({ kind: "geometric", imageDataUri: "" })}
									>
										Remove image
									</button>
								) : null}
							</div>
							<p class="help-text">
								Images are cropped to a square and stored with this View Design scope. PNG, JPEG,
								and WebP are supported.
							</p>
							{invalidAgentIcon ? (
								<p class="inline-error">Enter a short character or choose a valid image.</p>
							) : null}
							{iconError ? (
								<p class="inline-error" role="alert">
									{iconError}
								</p>
							) : null}
						</div>
					) : null}
				</section>

				<section class="settings-group">
					<button
						type="button"
						class="settings-group-heading"
						aria-expanded={openSections.has("typography")}
						onClick={() => toggle("typography")}
					>
						<span>{openSections.has("typography") ? "⌄" : "›"} Typography</span>
					</button>
					{openSections.has("typography") ? (
						<div class="settings-fields">
							{(
								[
									["interfaceFont", "Interface font"],
									["messageFont", "Message font"],
									["codeFont", "Code font"],
								] as const
							).map(([key, label]) => (
								<label class="settings-field" key={key}>
									<span>{label}</span>
									<input
										type="text"
										value={draft[key]}
										aria-invalid={!isSafeFontFamily(draft[key])}
										placeholder="VS Code default"
										onInput={(event) => update(key, event.currentTarget.value)}
									/>
								</label>
							))}
							{invalidFonts.length > 0 ? (
								<p class="inline-error">
									Fonts cannot contain CSS rules, url(), @import, or expression().
								</p>
							) : null}
							<label class="settings-field">
								<span>
									Text size <output>{draft.textSize}px</output>
								</span>
								<input
									type="range"
									min={11}
									max={20}
									value={draft.textSize}
									onInput={(event) => update("textSize", Number(event.currentTarget.value))}
								/>
							</label>
							<label class="settings-field">
								<span>
									Code size <output>{draft.codeSize}px</output>
								</span>
								<input
									type="range"
									min={11}
									max={20}
									value={draft.codeSize}
									onInput={(event) => update("codeSize", Number(event.currentTarget.value))}
								/>
							</label>
							<label class="settings-field">
								<span>Line height</span>
								<select
									value={draft.lineHeight}
									onChange={(event) =>
										update("lineHeight", event.currentTarget.value as ViewDesignValue["lineHeight"])
									}
								>
									<option value="compact">Compact</option>
									<option value="comfortable">Comfortable</option>
									<option value="spacious">Spacious</option>
								</select>
							</label>
						</div>
					) : null}
				</section>

				<section class="settings-group">
					<button
						type="button"
						class="settings-group-heading"
						aria-expanded={openSections.has("theme")}
						onClick={() => toggle("theme")}
					>
						<span>{openSections.has("theme") ? "⌄" : "›"} Theme</span>
					</button>
					{openSections.has("theme") ? (
						<div class="settings-fields">
							<label class="settings-field">
								<span>Appearance</span>
								<select
									value={draft.colorMode}
									onChange={(event) =>
										update("colorMode", event.currentTarget.value as ViewDesignValue["colorMode"])
									}
								>
									<option value="vscode">Follow VS Code</option>
									<option value="light">Light</option>
									<option value="dark">Dark</option>
									<option value="highContrast">High Contrast</option>
									<option value="custom">Custom</option>
								</select>
							</label>
							<div class={`color-grid ${draft.colorMode !== "custom" ? "disabled" : ""}`}>
								{colorFields.map((field) => (
									<label key={field.key}>
										<span>{field.label}</span>
										<span class="color-control">
											<input
												type="color"
												value={draft.colors[field.key]}
												disabled={draft.colorMode !== "custom"}
												onInput={(event) => updateColor(field.key, event.currentTarget.value)}
											/>
											<input
												type="text"
												value={draft.colors[field.key]}
												disabled={draft.colorMode !== "custom"}
												onInput={(event) => updateColor(field.key, event.currentTarget.value)}
											/>
										</span>
									</label>
								))}
							</div>
							{invalidColors.length > 0 ? (
								<p class="inline-error">Colors must use six-digit hex values such as #9B6CFF.</p>
							) : null}
							{contrastIssues.length > 0 ? (
								<div class="inline-error" role="alert">
									<strong>Improve color contrast before saving.</strong>
									<ul>
										{contrastIssues.map((issue) => (
											<li key={`${issue.path}:${issue.message}`}>{issue.message}</li>
										))}
									</ul>
								</div>
							) : null}
							{draft.colorMode !== "custom" ? (
								<p class="help-text">
									Custom colors are available when Appearance is set to Custom.
								</p>
							) : null}
						</div>
					) : null}
				</section>

				<section class="settings-group">
					<button
						type="button"
						class="settings-group-heading"
						aria-expanded={openSections.has("layout")}
						onClick={() => toggle("layout")}
					>
						<span>{openSections.has("layout") ? "⌄" : "›"} Layout</span>
					</button>
					{openSections.has("layout") ? (
						<div class="settings-fields">
							<label class="settings-field">
								<span>Density</span>
								<select
									value={draft.density}
									onChange={(event) =>
										update("density", event.currentTarget.value as ViewDesignValue["density"])
									}
								>
									<option value="compact">Compact</option>
									<option value="comfortable">Comfortable</option>
								</select>
							</label>
							<label class="settings-field">
								<span>
									Message spacing <output>{draft.messageSpacing}px</output>
								</span>
								<input
									type="range"
									min={4}
									max={24}
									value={draft.messageSpacing}
									onInput={(event) => update("messageSpacing", Number(event.currentTarget.value))}
								/>
							</label>
							<label class="settings-field">
								<span>
									Corner radius <output>{draft.cornerRadius}px</output>
								</span>
								<input
									type="range"
									min={0}
									max={16}
									value={draft.cornerRadius}
									onInput={(event) => update("cornerRadius", Number(event.currentTarget.value))}
								/>
							</label>
						</div>
					) : null}
				</section>

				<button
					class="link-button reset-design"
					type="button"
					onClick={() => {
						designDraftSignal.value = committed;
						expectDesignUpdate();
						postIntent({ type: "resetDesign", scope });
					}}
				>
					Reset to VS Code defaults
				</button>
			</div>
			<footer class="settings-actions">
				<button type="button" onClick={cancel}>
					Cancel
				</button>
				<button
					type="button"
					class="primary-button"
					disabled={
						!dirty ||
						invalidAgentIcon ||
						invalidFonts.length > 0 ||
						invalidColors.length > 0 ||
						contrastIssues.length > 0
					}
					onClick={() => {
						postIntent({ type: "saveDesign", design: draft, scope });
						onClose();
					}}
				>
					Save
				</button>
			</footer>
		</section>
	);
}
