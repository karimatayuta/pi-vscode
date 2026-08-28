export async function writeClipboard(value: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(value);
		return true;
	} catch {
		const field = document.createElement("textarea");
		field.value = value;
		field.setAttribute("readonly", "");
		field.style.position = "fixed";
		field.style.opacity = "0";
		document.body.append(field);
		try {
			field.select();
			return document.execCommand("copy");
		} catch {
			return false;
		} finally {
			field.remove();
		}
	}
}
