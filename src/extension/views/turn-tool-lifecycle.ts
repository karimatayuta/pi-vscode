import type { ChatPhase } from "../../shared/protocol.js";
import type { PiHostEvent } from "../pi/types.js";
import type { TurnToolSettlement } from "./turn-tools.js";

export interface TurnToolTransition {
	readonly restore: boolean;
	readonly settle?: TurnToolSettlement;
}

const NO_TOOL_TRANSITION: TurnToolTransition = { restore: false };

function wasTerminal(phase: ChatPhase): boolean {
	return phase === "idle" || phase === "error";
}

/**
 * Describes the tool-panel transition that must surround a Pi host event.
 * Restore runs before the event is applied; settlement runs afterwards.
 */
export function turnToolTransitionForEvent(
	event: PiHostEvent,
	previousPhase: ChatPhase,
): TurnToolTransition {
	if (event.type === "session.snapshot") {
		return event.snapshot.busy
			? { restore: wasTerminal(previousPhase) }
			: { restore: false, settle: "recoverable" };
	}
	if (event.type === "session.state") {
		return event.busy
			? { restore: wasTerminal(previousPhase) }
			: { restore: false, settle: "recoverable" };
	}
	if (event.type === "session.error") {
		return { restore: false, settle: "recoverable" };
	}
	if (event.type === "session.closed") {
		return { restore: false, settle: "final" };
	}
	if (event.type === "message.start") {
		return {
			restore: event.message.role === "assistant" && wasTerminal(previousPhase),
		};
	}
	if (event.type === "message.update") {
		return { restore: wasTerminal(previousPhase) };
	}
	if (event.type === "tool.start" || event.type === "tool.update" || event.type === "tool.end") {
		return { restore: wasTerminal(previousPhase) };
	}
	if (event.type === "lifecycle") {
		if (event.name === "agent.settled") return { restore: false, settle: "final" };
		if (event.name === "compaction.start" || event.name === "retry.start") {
			return { restore: true };
		}
	}
	return NO_TOOL_TRANSITION;
}
