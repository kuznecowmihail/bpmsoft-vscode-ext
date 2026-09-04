export interface LineCharacter {
	line: number;
	character: number;
}

/** 0-based line/character for a text offset — correctly splits on every line
 * ending style (`\r\n`, `\r`, or `\n`), matching how VS Code's own
 * `TextDocument.positionAt` treats line breaks. */
export function offsetToLineCharacter(text: string, offset: number): LineCharacter {
	const before = text.slice(0, Math.max(0, offset));
	const lines = before.split(/\r\n|\r|\n/);
	return { line: lines.length - 1, character: lines[lines.length - 1].length };
}
