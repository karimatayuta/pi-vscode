/// <reference types="mocha" />

import assert from "node:assert/strict";
import { chmod, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import * as vscode from "vscode";
import { ContextStore } from "../../src/extension/context/context-store.js";
import { parseMessageReferences } from "../../src/extension/links/reference-parser.js";
import { ReferenceRegistry } from "../../src/extension/links/reference-registry.js";

const extensionIdentifier = "karimatayuta.pi-agent";

suite("Pi Agent Extension Host", () => {
	test("isolates Pi Agent data from the developer profile", () => {
		const agentDir = process.env.PI_CODING_AGENT_DIR;
		assert.ok(agentDir, "the integration runner must provide an isolated Pi agent directory");
		assert.equal(isAbsolute(agentDir), true, "the isolated Pi agent directory must be absolute");
		assert.notEqual(
			resolve(agentDir),
			resolve(homedir(), ".pi", "agent"),
			"integration tests must never use the developer's default Pi agent directory",
		);
		const testState = resolve(import.meta.dirname, "..", "..", ".vscode-test");
		const relativeToTestState = relative(testState, agentDir);
		assert.equal(
			relativeToTestState.startsWith(".."),
			false,
			"the Pi agent directory must remain inside the disposable .vscode-test state",
		);
	});

	test("activates and registers its public commands", async () => {
		const extension = vscode.extensions.getExtension(extensionIdentifier);
		assert.ok(extension, `${extensionIdentifier} was not discovered by VS Code`);
		const expectedPackagePath = process.env.PI_AGENT_TEST_EXTENSION_PATH;
		if (expectedPackagePath) {
			assert.equal(
				await realpath(extension.extensionPath),
				await realpath(expectedPackagePath),
				"the package test must activate the unpacked VSIX instead of the development tree",
			);
		}
		assert.equal(
			extension.packageJSON.capabilities?.untrustedWorkspaces?.supported,
			"limited",
			"the packaged extension must preserve Restricted Mode support",
		);
		assert.equal(
			extension.packageJSON.capabilities?.virtualWorkspaces?.supported,
			false,
			"the packaged extension must not claim unsupported virtual-workspace behavior",
		);

		await extension.activate();
		assert.equal(extension.isActive, true);

		const commands = new Set(await vscode.commands.getCommands(true));
		for (const command of [
			"piAgent.openChat",
			"piAgent.newChat",
			"piAgent.addContext",
			"piAgent.configureProvider",
			"piAgent.stop",
		]) {
			assert.equal(commands.has(command), true, `${command} was not registered`);
		}

		await vscode.commands.executeCommand("piAgent.openChat");
		await vscode.commands.executeCommand("piAgent.focusComposer");
	});

	test("opens a real workspace link without registering adjacent tool prose", async () => {
		const references = parseMessageReferences(
			"edit/write前後の内容から確認します。 [README](README.md:1)",
		);
		assert.equal(references.length, 1);
		const target = references[0]?.target;
		assert.ok(target?.kind === "workspace");
		assert.equal(target.relativePath, "README.md");

		const registry = new ReferenceRegistry();
		const reference = registry.issue(target);
		await registry.open(reference.refId, reference.epoch, "open");

		assert.equal(vscode.window.activeTextEditor?.document.uri.path.endsWith("/README.md"), true);
		assert.equal(vscode.window.activeTextEditor?.selection.start.line, 0);
	});

	test("bounds retained selections and folder traversal", async () => {
		const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
		assert.ok(workspaceUri, "the integration fixture workspace must be open");
		const fixture = vscode.Uri.joinPath(workspaceUri, `.pi-context-budget-${Date.now()}`);
		const selectionFile = vscode.Uri.joinPath(fixture, "selection.txt");
		const folder = vscode.Uri.joinPath(fixture, "folder");
		const store = new ContextStore({
			maxItems: 4,
			maxFileBytes: 64,
			maxFolderFiles: 1,
			maxTotalBytes: 31,
		});
		try {
			await vscode.workspace.fs.createDirectory(folder);
			for (let index = 0; index < 20; index += 1) {
				await vscode.workspace.fs.createDirectory(
					vscode.Uri.joinPath(folder, `empty-${index.toString().padStart(2, "0")}`),
				);
			}
			await vscode.workspace.fs.writeFile(
				selectionFile,
				new TextEncoder().encode("🙂".repeat(256)),
			);
			const document = await vscode.workspace.openTextDocument(selectionFile);
			const editor = await vscode.window.showTextDocument(document);
			editor.selection = new vscode.Selection(0, 0, 0, 512);

			const selection = store.addSelection(editor);
			assert.ok(selection?.selection, "the workspace selection should be accepted");
			assert.ok(new TextEncoder().encode(selection.selection.text).byteLength <= 31);
			assert.equal(selection.selection.text.includes("�"), false);
			assert.equal(selection.selection.truncated, true);
			const resolvedSelection = await store.resolveForPrompt([selection.id]);
			assert.equal(resolvedSelection[0]?.truncated, true);
			assert.ok(new TextEncoder().encode(resolvedSelection[0]?.content ?? "").byteLength <= 31);

			const [folderItem] = await store.addUris([folder]);
			assert.ok(folderItem, "the workspace folder should be accepted");
			const resolvedFolder = await store.resolveForPrompt([folderItem.id]);
			assert.equal(resolvedFolder.length, 1);
			assert.match(resolvedFolder[0]?.warning ?? "", /traversal safety budget/u);
		} finally {
			store.dispose();
			await vscode.workspace.fs.delete(fixture, { recursive: true, useTrash: false });
		}
	});

	test("reports folder entries that become unreadable without dropping readable files", async () => {
		const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
		assert.ok(workspaceUri, "the integration fixture workspace must be open");
		const fixture = vscode.Uri.joinPath(workspaceUri, `.pi-context-unreadable-${Date.now()}`);
		const folder = vscode.Uri.joinPath(fixture, "folder");
		const locked = vscode.Uri.joinPath(folder, "locked");
		const store = new ContextStore({
			maxItems: 4,
			maxFileBytes: 1_024,
			maxFolderFiles: 8,
			maxTotalBytes: 8_192,
		});
		try {
			await vscode.workspace.fs.createDirectory(locked);
			await vscode.workspace.fs.writeFile(
				vscode.Uri.joinPath(folder, "readable.txt"),
				new TextEncoder().encode("readable context"),
			);
			await vscode.workspace.fs.writeFile(
				vscode.Uri.joinPath(locked, "hidden.txt"),
				new TextEncoder().encode("hidden context"),
			);
			const [folderItem] = await store.addUris([folder]);
			assert.ok(folderItem, "the folder should be accepted before permissions change");
			await chmod(locked.fsPath, 0o000);

			const resolved = await store.resolveForPrompt([folderItem.id]);
			assert.equal(
				resolved.some((item) => item.content === "readable context"),
				true,
			);
			const warning = resolved.find((item) => item.kind === "folder")?.warning ?? "";
			assert.match(warning, /1 folder location was skipped/u);
			assert.equal(warning.includes("locked"), false, "warnings must not expose hidden paths");
		} finally {
			await chmod(locked.fsPath, 0o700).catch(() => undefined);
			store.dispose();
			await vscode.workspace.fs.delete(fixture, { recursive: true, useTrash: false });
		}
	});
});
