import * as acorn from "acorn";
import { SourcePosition } from "../index/types";

export type AnyNode = acorn.Node & Record<string, any>;

export function parseJs(
	source: string,
	comments?: acorn.Comment[]
): AnyNode | undefined {
	const options: acorn.Options = {
		ecmaVersion: "latest",
		sourceType: "script",
		locations: true,
		allowReturnOutsideFunction: true
	};
	if (comments) {
		options.onComment = comments;
	}
	try {
		return acorn.parse(source, options) as AnyNode;
	} catch {
		try {
			return acorn.parse(source, { ...options, ecmaVersion: 2020 }) as AnyNode;
		} catch {
			return undefined;
		}
	}
}

export function childNodes(node: AnyNode): AnyNode[] {
	const out: AnyNode[] = [];
	for (const key of Object.keys(node)) {
		if (
			key === "type" ||
			key === "start" ||
			key === "end" ||
			key === "loc" ||
			key === "range" ||
			key === "raw"
		) {
			continue;
		}
		const value = node[key];
		if (Array.isArray(value)) {
			for (const item of value) {
				if (item && typeof item.type === "string") {
					out.push(item);
				}
			}
		} else if (value && typeof value.type === "string") {
			out.push(value);
		}
	}
	return out;
}

export function posFromNode(node: AnyNode | undefined): SourcePosition | undefined {
	if (typeof node?.start !== "number") {
		return undefined;
	}
	const loc = node.loc?.start;
	if (!loc) {
		return undefined;
	}
	return { line: loc.line - 1, character: loc.column };
}

export function leadingComment(
	comments: acorn.Comment[],
	node: AnyNode,
	maxGap: number
): string | undefined {
	if (typeof node.start !== "number") {
		return undefined;
	}
	let best: acorn.Comment | undefined;
	for (const comment of comments) {
		if (comment.end <= node.start && node.start - comment.end < maxGap) {
			if (!best || comment.end > best.end) {
				best = comment;
			}
		}
	}
	if (!best) {
		return undefined;
	}
	return best.value
		.replace(/^\*+/, "")
		.replace(/\n\s*\*/g, "\n")
		.trim();
}

export function skipJsString(text: string, start: number, end: number): number {
	const quote = text[start];
	let i = start + 1;
	while (i < end) {
		if (quote === "`" && text[i] === "$" && text[i + 1] === "{") {
			i += 2;
			let depth = 1;
			while (i < end && depth > 0) {
				if (text[i] === "'" || text[i] === '"') {
					i = skipJsString(text, i, end);
					continue;
				}
				if (text[i] === "`") {
					i = skipJsString(text, i, end);
					continue;
				}
				if (text[i] === "{") {
					depth++;
				} else if (text[i] === "}") {
					depth--;
				}
				i++;
			}
			continue;
		}
		if (text[i] === "\\") {
			i += 2;
			continue;
		}
		if (text[i] === quote) {
			return i + 1;
		}
		i++;
	}
	return end;
}
