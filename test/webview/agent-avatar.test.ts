import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "../..");
const appSource = readFileSync(resolve(projectRoot, "src/webview/App.tsx"), "utf8");
const timelineSource = readFileSync(
	resolve(projectRoot, "src/webview/components/Timeline.tsx"),
	"utf8",
);
const avatarSource = readFileSync(
	resolve(projectRoot, "src/webview/components/AgentAvatar.tsx"),
	"utf8",
);
const designSource = readFileSync(
	resolve(projectRoot, "src/webview/components/ViewDesign.tsx"),
	"utf8",
);
const htmlSource = readFileSync(
	resolve(projectRoot, "src/extension/views/webview-html.ts"),
	"utf8",
);

describe("custom Pi Agent avatar", () => {
	test("flows the saved avatar through the timeline and live preview", () => {
		expect(appSource).toContain("agentIcon={snapshot.design.agentIcon}");
		expect(timelineSource).toContain("<AgentAvatar icon={agentIcon}");
		expect(designSource).toContain("<AgentAvatar icon={draft.agentIcon}");
	});

	test("uses an original geometric mark and allows only local raster image input", () => {
		expect(avatarSource).toContain("GeometricPiMark");
		expect(designSource).toContain('accept="image/png,image/jpeg,image/webp"');
		expect(designSource).not.toContain('accept="image/svg');
		expect(htmlSource).toMatch(/img-src \$\{webview\.cspSource\} data:/u);
		expect(htmlSource).not.toContain("img-src https:");
	});
});
