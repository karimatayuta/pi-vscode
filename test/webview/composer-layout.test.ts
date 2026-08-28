import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "../..");
const appSource = readFileSync(resolve(projectRoot, "src/webview/App.tsx"), "utf8");
const composerSource = readFileSync(
	resolve(projectRoot, "src/webview/components/Composer.tsx"),
	"utf8",
);
const modeControlSource = readFileSync(
	resolve(projectRoot, "src/webview/components/ComposerModeControl.tsx"),
	"utf8",
);
const sessionControlsSource = readFileSync(
	resolve(projectRoot, "src/webview/components/ModelBar.tsx"),
	"utf8",
);
const styles = readFileSync(resolve(projectRoot, "src/webview/styles.css"), "utf8");

describe("composer configuration layout", () => {
	test("keeps model and usage controls beside Send in keyboard order", () => {
		const actions = composerSource.slice(
			composerSource.indexOf('<div class="composer-actions">'),
			composerSource.indexOf("</form>"),
		);
		const contextIndex = actions.indexOf('aria-label="Add context"');
		const modeIndex = actions.indexOf("<ComposerModeControl");
		const sessionIndex = actions.indexOf("<ComposerSessionControls");
		const sendIndex = actions.indexOf('class="send-button"');

		expect(contextIndex).toBeGreaterThanOrEqual(0);
		expect(modeIndex).toBeGreaterThan(contextIndex);
		expect(sessionIndex).toBeGreaterThan(modeIndex);
		expect(sendIndex).toBeGreaterThan(sessionIndex);

		const modelIndex = sessionControlsSource.indexOf('class="model-control"');
		const usageIndex = sessionControlsSource.indexOf("<UsagePill");
		expect(modelIndex).toBeGreaterThanOrEqual(0);
		expect(usageIndex).toBeGreaterThan(modelIndex);
	});

	test("removes the former workspace configuration row", () => {
		expect(appSource).not.toContain("<ModelBar");
		expect(styles).not.toContain(".session-bar");
		expect(styles).not.toContain(".workspace-status");
		expect(styles).toContain("grid-template-rows: auto minmax(0, 1fr) auto;");
	});

	test("presents model and usage as readable, accessible session controls", () => {
		expect(sessionControlsSource).toContain('class="model-glyph"');
		expect(sessionControlsSource).toContain('class="usage-glyph"');
		expect(sessionControlsSource).toContain("aria-controls={open ? popoverId : undefined}");
		expect(sessionControlsSource).toContain('role="dialog"');
		expect(sessionControlsSource).toContain('role="progressbar"');
		expect(sessionControlsSource).toContain('<dl class="usage-grid">');
		expect(sessionControlsSource).toContain('class="live-badge">Live');
		expect(sessionControlsSource).toContain('live={phase === "running"}');
		expect(sessionControlsSource).not.toContain("active={busy}");
		expect(sessionControlsSource).toContain('event.key !== "Escape"');
		expect(sessionControlsSource).toContain("buttonRef.current?.focus()");

		expect(styles).toMatch(/\.composer-session-controls \{[\s\S]*?gap: 3px[\s\S]*?border: 0/u);
		expect(styles).toMatch(/\.model-pill \{[\s\S]*?height: 30px[\s\S]*?gap: 4px/u);
		expect(styles).toMatch(/\.usage-pill \{[\s\S]*?min-width: 56px[\s\S]*?height: 30px/u);
		expect(styles).toMatch(/\.popover \{[\s\S]*?padding: 12px[\s\S]*?border-radius: 9px/u);
		expect(styles).toMatch(
			/@media \(max-width: 288px\)[\s\S]*?\.composer-actions \{[\s\S]*?flex-wrap: wrap[\s\S]*?\.composer-right-actions \{[\s\S]*?width: 100%[\s\S]*?flex: 1 0 100%/u,
		);
		expect(styles).toMatch(
			/@media \(max-width: 288px\)[\s\S]*?\.model-popover,[\s\S]*?\.usage-popover \{[\s\S]*?width: calc\(100% - 10px\)/u,
		);
		expect(styles).toMatch(
			/\.model-popover \{[\s\S]*?max-height: min\(520px, calc\(100vh - 72px\)\)[\s\S]*?overflow-y: auto/u,
		);
		expect(styles).toMatch(
			/\.usage-popover \{[\s\S]*?max-height: min\(520px, calc\(100vh - 72px\)\)[\s\S]*?overflow-y: auto/u,
		);
	});

	test("keeps every action reachable in the 289px sidebar regression viewport", () => {
		const actionOrder = [
			composerSource.indexOf('aria-label="Add context"'),
			composerSource.indexOf("<ComposerModeControl"),
			composerSource.indexOf("<ComposerSessionControls"),
			composerSource.indexOf('class="send-button"'),
		];
		expect(actionOrder).toEqual([...actionOrder].sort((left, right) => left - right));

		// At 289 CSS pixels the compact right-hand row needs only 122px:
		// model 30 + fieldset gap 3 + usage 56 + outer gap 3 + Send 30.
		const minimumRightRowWidth = 30 + 3 + 56 + 3 + 30;
		expect(minimumRightRowWidth).toBeLessThan(289 - 10);
		expect(styles).toMatch(
			/@media \(max-width: 340px\)[\s\S]*?\.model-pill \{[\s\S]*?min-width: 30px/u,
		);
		expect(styles).toMatch(/\.usage-pill \{[\s\S]*?min-width: 56px/u);
		expect(styles).toMatch(/\.send-button \{[\s\S]*?min-width: 30px/u);
	});

	test("keeps approval-mode focus and Full Access confirmation inside one control", () => {
		expect(modeControlSource).toContain('class="mode-control"');
		expect(modeControlSource).toContain('role="menuitemradio"');
		expect(modeControlSource).toContain('role="alertdialog"');
		expect(modeControlSource).toContain('event.key === "Escape"');
		expect(modeControlSource).toContain('event.key !== "Tab"');
		expect(modeControlSource).toContain("restoreButtonFocus()");
		expect(modeControlSource).toContain("通常のコマンド実行は自動。削除や高リスク操作は確認します");
		expect(modeControlSource).toContain("コマンドを個別確認なしで実行します");
		expect(modeControlSource).toContain("影響範囲は完全には判定できず");
		expect(modeControlSource).not.toContain("危険な操作は引き続き個別確認");
		expect(composerSource).toContain("Commands run without individual confirmation");
		expect(composerSource).toContain("cannot be fully detected.");
	});

	test("resizes the prompt from an accessible top-center handle", () => {
		expect(composerSource).toContain("<hr");
		expect(composerSource).toContain('class="composer-resize-handle"');
		expect(composerSource).toContain('aria-controls="pi-prompt"');
		expect(composerSource).toContain('aria-orientation="horizontal"');
		expect(composerSource).toContain("aria-valuemin={COMPOSER_INPUT_MIN_HEIGHT}");
		expect(composerSource).toContain("aria-valuemax={maximumInputHeight}");
		expect(composerSource).toContain("onPointerDown={handleResizePointerDown}");
		expect(composerSource).toContain("onPointerMove={handleResizePointerMove}");
		expect(composerSource).toContain('case "ArrowUp"');
		expect(composerSource).toContain('case "ArrowDown"');
		expect(composerSource).toContain('case "Home"');
		expect(composerSource).toContain('case "End"');
		expect(composerSource).toContain('case "Enter"');
		expect(composerSource).toContain("COMPOSER_MIN_TIMELINE_HEIGHT");
		expect(composerSource).toContain("new ResizeObserver(clampToViewport)");
		expect(composerSource).toContain('window.addEventListener("resize", clampToViewport)');

		expect(styles).toMatch(
			/\.composer-resize-handle \{[\s\S]*?left: 50%[\s\S]*?width: 48px[\s\S]*?height: 24px[\s\S]*?touch-action: none[\s\S]*?cursor: ns-resize/u,
		);
		expect(styles).toMatch(/\.prompt-shell textarea \{[\s\S]*?resize: none/u);
		expect(styles).toMatch(
			/@media \(max-width: 288px\)[\s\S]*?\.composer-actions \{[\s\S]*?flex-wrap: wrap/u,
		);
		expect(styles).toMatch(/\.suggestion-popover \{[\s\S]*?max-height: min\(310px, 42vh\)/u);
	});

	test("formats estimated and subscription costs without losing sub-cent values", () => {
		expect(sessionControlsSource).toContain(
			'import { formatEstimatedCost } from "../../shared/usage.js";',
		);
		expect(sessionControlsSource).toContain("const formatted = formatEstimatedCost(usage.cost);");
		expect(sessionControlsSource).toMatch(
			/usage\.costKind === "subscription" \? `\$\{estimate\} · Sub` : estimate/u,
		);
		expect(sessionControlsSource).toContain(
			"Token cost shown for reference; your provider subscription may cover it.",
		);
		expect(sessionControlsSource).toContain("Pricing is unavailable for this session.");
		expect(sessionControlsSource).toContain(
			'{cost ? <span class="usage-cost wide-only">{cost}</span> : null}',
		);
	});

	test("supports listbox keyboard navigation without adding every model to the Tab order", () => {
		expect(sessionControlsSource).toContain('".model-option:not(:disabled)"');
		expect(sessionControlsSource).toContain("tabIndex={isSelected ? 0 : -1}");
		expect(sessionControlsSource).toContain('event.key === "ArrowDown"');
		expect(sessionControlsSource).toContain('event.key === "ArrowUp"');
		expect(sessionControlsSource).toContain('event.key === "Home"');
		expect(sessionControlsSource).toContain('event.key === "End"');
		expect(sessionControlsSource).toContain("setSelected(option);");
	});
});
