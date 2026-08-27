import type { JSX } from "preact";
import type { AgentIcon } from "../../shared/view-design.js";

interface AgentAvatarProps {
	readonly icon: AgentIcon;
	readonly className?: string;
	readonly label?: string;
}

/** Original angular Pi mark: monochrome and geometric, without copying a third-party logo. */
function GeometricPiMark() {
	return (
		<svg class="agent-avatar-mark" viewBox="0 0 24 24" role="presentation">
			<path
				fill="currentColor"
				d="M5.2 6.7h13.6v2.65h-2.1l-1.05 7.95h-2.8l1.05-7.95h-3.8l-.8 7.95H6.5l.82-7.95H5.2V6.7Z"
			/>
			<path
				fill="currentColor"
				d="m7.15 3.55 2.15 1.4-1.2 1.1-2.35-1.1 1.4-1.4Zm9.2 13.9 2.05 1.25-1.45 1.75-1.75-1.7 1.15-1.3Z"
				opacity="0.66"
			/>
		</svg>
	);
}

export function AgentAvatar({ icon, className = "", label }: AgentAvatarProps) {
	const style = {
		"--pi-agent-icon-background": icon.background,
		"--pi-agent-icon-foreground": icon.foreground,
	} as JSX.CSSProperties;
	return (
		<span
			class={`agent-avatar ${className}`.trim()}
			style={style}
			{...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
		>
			{icon.kind === "image" && icon.imageDataUri ? (
				<img src={icon.imageDataUri} alt="" draggable={false} />
			) : icon.kind === "text" ? (
				<span class="agent-avatar-text">{icon.text}</span>
			) : (
				<GeometricPiMark />
			)}
		</span>
	);
}
