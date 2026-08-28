import { describe, expect, test } from "bun:test";
import { ChatSessionController } from "../../src/extension/chat/chat-session-controller.js";
import type {
	PiCommandDto,
	PiDisposable,
	PiHostApi,
	PiHostEvent,
	PiHostEventListener,
	PiHostSessionId,
	PiModelCatalogDto,
	PiPromptDelivery,
	PiPromptInput,
	PiSessionBootstrapDto,
	PiSessionHistoryDto,
	PiSessionOpenTarget,
	PiSessionReplaceTarget,
	PiSessionSnapshotDto,
	PiSessionStatsDto,
	PiThinkingLevel,
} from "../../src/extension/pi/types.js";

const stats: PiSessionStatsDto = {
	userMessages: 0,
	assistantMessages: 0,
	toolCalls: 0,
	toolResults: 0,
	totalMessages: 0,
	tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	cost: 0,
	costKind: "unknown",
};

function snapshot(id = "session-1", generation = 1): PiSessionSnapshotDto {
	return {
		id,
		generation,
		cwd: "workspace",
		piSessionId: `pi-${id}`,
		persistent: true,
		phase: "idle",
		busy: false,
		thinkingLevel: "off",
		availableThinkingLevels: ["off"],
		pendingMessages: 0,
		activeTools: ["read"],
		stats,
	};
}

function bootstrap(id = "session-1", generation = 1): PiSessionBootstrapDto {
	return { snapshot: snapshot(id, generation), history: [], commands: [] };
}

class FakePiHost implements PiHostApi {
	readonly listeners = new Set<PiHostEventListener>();
	readonly closed: PiHostSessionId[] = [];
	readonly sent: Array<{ id: PiHostSessionId; input: PiPromptInput }> = [];
	readonly settingsCalls: string[] = [];
	current = bootstrap();
	closeError: Error | undefined;
	thinkingError: Error | undefined;
	openResult: Promise<PiSessionBootstrapDto> | undefined;

	public async start(_signal?: AbortSignal): Promise<void> {}

	public async open(_input: {
		readonly cwd: string;
		readonly target: PiSessionOpenTarget;
	}): Promise<PiSessionBootstrapDto> {
		return this.openResult ?? this.current;
	}

	public async replace(
		_id: PiHostSessionId,
		_target: PiSessionReplaceTarget,
	): Promise<PiSessionBootstrapDto> {
		this.current = bootstrap(this.current.snapshot.id, this.current.snapshot.generation + 1);
		return this.current;
	}

	public async send(id: PiHostSessionId, input: PiPromptInput): Promise<void> {
		this.sent.push({ id, input });
	}

	public async listCommands(_id: PiHostSessionId): Promise<readonly PiCommandDto[]> {
		return [];
	}

	public async listSessions(_cwd: string): Promise<readonly PiSessionHistoryDto[]> {
		return [];
	}

	public async invokeCommand(
		_id: PiHostSessionId,
		_invocation: string,
		_args?: string,
		_delivery?: PiPromptDelivery,
	): Promise<void> {}

	public async listModels(_signal?: AbortSignal): Promise<PiModelCatalogDto> {
		return { models: [], stale: false };
	}

	public async setRuntimeApiKey(_provider: string, _apiKey: string): Promise<void> {}

	public async removeRuntimeApiKey(_provider: string): Promise<void> {}

	public async setModel(
		_id: PiHostSessionId,
		ref: { readonly provider: string; readonly id: string },
		persist?: boolean,
	): Promise<PiSessionSnapshotDto> {
		this.settingsCalls.push(`model:${ref.provider}/${ref.id}:${Boolean(persist)}`);
		this.current = {
			...this.current,
			snapshot: {
				...this.current.snapshot,
				model: { ...ref, name: ref.id },
				availableThinkingLevels: ["off", "high"],
			},
		};
		return this.current.snapshot;
	}

	public async setThinking(
		_id: PiHostSessionId,
		level: PiThinkingLevel,
		persist?: boolean,
	): Promise<PiSessionSnapshotDto> {
		this.settingsCalls.push(`thinking:${level}:${Boolean(persist)}`);
		if (this.thinkingError) throw this.thinkingError;
		this.current = {
			...this.current,
			snapshot: { ...this.current.snapshot, thinkingLevel: level },
		};
		return this.current.snapshot;
	}

	public async setTitle(_id: PiHostSessionId, _title: string): Promise<PiSessionSnapshotDto> {
		return this.current.snapshot;
	}

	public async compact(
		_id: PiHostSessionId,
		_customInstructions?: string,
	): Promise<PiSessionSnapshotDto> {
		this.current = bootstrap(this.current.snapshot.id, this.current.snapshot.generation + 1);
		return this.current.snapshot;
	}

	public async abort(_id: PiHostSessionId): Promise<void> {}

	public async close(id: PiHostSessionId): Promise<void> {
		this.closed.push(id);
		if (this.closeError) {
			throw this.closeError;
		}
		this.emit({
			type: "session.closed",
			sessionId: id,
			generation: this.current.snapshot.generation,
		});
	}

	public onEvent(listener: PiHostEventListener): PiDisposable {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	public async dispose(): Promise<void> {
		this.listeners.clear();
	}

	public emit(event: PiHostEvent): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}
}

describe("ChatSessionController", () => {
	test("binds one host session and delegates prompts", async () => {
		const host = new FakePiHost();
		const controller = new ChatSessionController(host);
		await expect(controller.send({ text: "too early" })).rejects.toThrow("Open a Pi session");

		const opened = await controller.open({ cwd: "/workspace", target: { kind: "new" } });
		expect(controller.sessionId).toBe(opened.snapshot.id);
		await controller.send({ text: "hello" });
		expect(host.sent).toEqual([{ id: "session-1", input: { text: "hello" } }]);
	});

	test("applies model and reasoning settings in one ordered operation", async () => {
		const host = new FakePiHost();
		const controller = new ChatSessionController(host);
		await controller.open({ cwd: "/workspace", target: { kind: "new" } });

		const applied = await controller.applyModelSettings(
			{ provider: "provider", id: "developer-model" },
			"high",
			true,
		);
		expect(host.settingsCalls).toEqual([
			"model:provider/developer-model:true",
			"thinking:high:true",
		]);
		expect(applied).toMatchObject({
			model: { provider: "provider", id: "developer-model" },
			thinkingLevel: "high",
		});

		host.settingsCalls.length = 0;
		await controller.applyModelSettings({ provider: "provider", id: "developer-model" }, "high");
		expect(host.settingsCalls).toEqual([]);
		await controller.applyModelSettings({ provider: "provider", id: "developer-model" }, "off");
		expect(host.settingsCalls).toEqual(["thinking:off:false"]);
	});

	test("retains the accepted model snapshot if applying reasoning fails", async () => {
		const host = new FakePiHost();
		const controller = new ChatSessionController(host);
		await controller.open({ cwd: "/workspace", target: { kind: "new" } });
		host.thinkingError = new Error("reasoning failed");

		await expect(
			controller.applyModelSettings({ provider: "provider", id: "new-model" }, "high"),
		).rejects.toThrow("reasoning failed");
		expect(controller.snapshot).toMatchObject({
			model: { provider: "provider", id: "new-model" },
			thinkingLevel: "off",
		});
	});

	test("forwards only current, non-stale session events", async () => {
		const host = new FakePiHost();
		const controller = new ChatSessionController(host);
		await controller.open({ cwd: "/workspace", target: { kind: "new" } });
		const events: PiHostEvent[] = [];
		controller.onEvent((event) => events.push(event));

		host.emit({ type: "lifecycle", sessionId: "other", generation: 1, name: "agent.start" });
		host.emit({ type: "lifecycle", sessionId: "session-1", generation: 0, name: "agent.start" });
		host.emit({
			type: "session.snapshot",
			sessionId: "session-1",
			generation: 2,
			snapshot: snapshot("session-1", 2),
		});
		host.emit({ type: "lifecycle", sessionId: "session-1", generation: 1, name: "agent.end" });

		expect(events).toHaveLength(1);
		expect(controller.snapshot?.generation).toBe(2);
	});

	test("keeps cached busy state synchronized with authoritative state events", async () => {
		const host = new FakePiHost();
		const controller = new ChatSessionController(host);
		await controller.open({ cwd: "/workspace", target: { kind: "new" } });

		host.emit({
			type: "session.state",
			sessionId: "session-1",
			generation: 1,
			phase: "running",
			busy: true,
		});
		expect(controller.snapshot).toMatchObject({ phase: "running", busy: true });

		host.emit({
			type: "session.state",
			sessionId: "session-1",
			generation: 1,
			phase: "idle",
			busy: false,
		});
		expect(controller.snapshot).toMatchObject({ phase: "idle", busy: false });
	});

	test("keeps cached usage synchronized with live stats events", async () => {
		const host = new FakePiHost();
		const controller = new ChatSessionController(host);
		await controller.open({ cwd: "/workspace", target: { kind: "new" } });
		const liveStats: PiSessionStatsDto = {
			...stats,
			tokens: { input: 120, output: 8, cacheRead: 40, cacheWrite: 0, total: 168 },
			cost: 0.012,
			costKind: "estimated",
		};
		host.emit({
			type: "session.stats",
			sessionId: "session-1",
			generation: 1,
			stats: liveStats,
		});
		expect(controller.snapshot?.stats).toEqual(liveStats);
	});

	test("updates after replacement and compaction, then closes exactly once", async () => {
		const host = new FakePiHost();
		const controller = new ChatSessionController(host);
		await controller.open({ cwd: "/workspace", target: { kind: "new" } });
		expect((await controller.replace({ kind: "new" })).snapshot.generation).toBe(2);
		expect((await controller.compact("keep decisions")).generation).toBe(3);

		await Promise.all([controller.close(), controller.close()]);
		expect(host.closed).toEqual(["session-1"]);
		expect(controller.sessionId).toBeUndefined();
	});

	test("dispose detaches listeners and closes its tab session", async () => {
		const host = new FakePiHost();
		const controller = new ChatSessionController(host);
		await controller.open({ cwd: "/workspace", target: { kind: "new" } });
		controller.dispose();
		await Promise.resolve();
		expect(host.listeners.size).toBe(0);
		expect(host.closed).toEqual(["session-1"]);
	});

	test("reports a rejected background close without leaking the rejection", async () => {
		const host = new FakePiHost();
		const closeError = new Error("close failed");
		host.closeError = closeError;
		const reports: Array<{ message: string; error: unknown }> = [];
		const controller = new ChatSessionController(host, (message, error) => {
			reports.push({ message, error });
		});
		await controller.open({ cwd: "/workspace", target: { kind: "new" } });

		controller.dispose();
		await Promise.resolve();
		await Promise.resolve();

		expect(host.closed).toEqual(["session-1"]);
		expect(reports).toEqual([
			{
				message: "Could not close a Pi Agent session in the background.",
				error: closeError,
			},
		]);
	});

	test("handles a rejected cleanup when disposal wins a session-open race", async () => {
		const host = new FakePiHost();
		const closeError = new Error("race cleanup failed");
		host.closeError = closeError;
		let finishOpen: ((value: PiSessionBootstrapDto) => void) | undefined;
		host.openResult = new Promise((resolve) => {
			finishOpen = resolve;
		});
		const reports: unknown[] = [];
		const controller = new ChatSessionController(host, (_message, error) => {
			reports.push(error);
		});
		const opening = controller.open({ cwd: "/workspace", target: { kind: "new" } });

		controller.dispose();
		finishOpen?.(bootstrap());
		await expect(opening).rejects.toThrow("closed while Pi was starting");
		await Promise.resolve();

		expect(host.closed).toEqual(["session-1"]);
		expect(reports).toEqual([closeError]);
	});
});
