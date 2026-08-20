import { skipJsString } from "./jsAst";

export interface OverrideInsertContext {
	kind: "methods" | "class";
	typed: string;
	identStart: number;
	identEnd: number;
}

/**
 * Cursor is at an object-key in schema `methods: { }` or Ext.define class body.
 */
export function getOverrideInsertContext(
	documentText: string,
	offset: number
): OverrideInsertContext | undefined {
	if (offset < 0 || offset > documentText.length) {
		return undefined;
	}
	const key = objectKeyPrefix(documentText, offset);
	if (!key) {
		return undefined;
	}
	const scope = scanOverrideScope(documentText, key.identStart);
	if (scope && scope.methodsDepth >= 0 && scope.braceDepth === scope.methodsDepth) {
		return { ...key, kind: "methods" };
	}
	if (scope && scope.classBodyDepth >= 0 && scope.braceDepth === scope.classBodyDepth) {
		return { ...key, kind: "class" };
	}
	return undefined;
}

export function formatOverrideSnippet(
	owner: string,
	name: string,
	params: string[] = []
): string {
	const args = params.join(", ");
	return [
		"/**",
		` * @inheritdoc ${owner}#${name}`,
		" * @overriden",
		" */",
		`${name}: function (${args}) {`,
		"\t$0",
		"},"
	].join("\n");
}

/**
 * Method names already declared in this file's `methods: { }` or Ext.define body.
 * The identifier currently being typed is not included.
 */
export function collectLocalMethodKeys(
	documentText: string,
	skipStart = -1,
	skipEnd = -1
): Set<string> {
	const keys = new Set<string>();
	let braceDepth = 0;
	let parenDepth = 0;
	let bracketDepth = 0;
	let methodsDepth = -1;
	let classBodyDepth = -1;
	let extDefineParen = -1;
	let lastIdent = "";
	let lastIdentStart = -1;
	let pendingKey = "";
	let afterDot = false;
	let i = 0;
	const end = documentText.length;

	const setIdent = (name: string, start: number) => {
		if (afterDot && lastIdent === "Ext" && name === "define") {
			lastIdent = "Ext.define";
			lastIdentStart = -1;
		} else {
			lastIdent = name;
			lastIdentStart = start;
		}
		afterDot = false;
	};

	const atMemberDepth = () =>
		(methodsDepth >= 0 && braceDepth === methodsDepth) ||
		(classBodyDepth >= 0 && braceDepth === classBodyDepth);

	while (i < end) {
		const ch = documentText[i];
		const next = documentText[i + 1];

		if (ch === "/" && next === "/") {
			i += 2;
			while (i < end && documentText[i] !== "\n") {
				i++;
			}
			continue;
		}
		if (ch === "/" && next === "*") {
			i += 2;
			while (i + 1 < end && !(documentText[i] === "*" && documentText[i + 1] === "/")) {
				i++;
			}
			i = Math.min(end, i + 2);
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			i = skipJsString(documentText, i, end);
			pendingKey = "";
			lastIdent = "";
			lastIdentStart = -1;
			afterDot = false;
			continue;
		}

		if (/[A-Za-z_$]/.test(ch)) {
			let j = i + 1;
			while (j < end && /[A-Za-z0-9_$]/.test(documentText[j])) {
				j++;
			}
			setIdent(documentText.slice(i, j), i);
			i = j;
			continue;
		}

		if (ch === ".") {
			afterDot = lastIdent === "Ext";
			i++;
			continue;
		}

		if (ch === "(") {
			parenDepth++;
			if (lastIdent === "Ext.define") {
				extDefineParen = parenDepth;
			}
			pendingKey = "";
			lastIdent = "";
			lastIdentStart = -1;
			afterDot = false;
			i++;
			continue;
		}
		if (ch === ")") {
			if (parenDepth === extDefineParen) {
				extDefineParen = -1;
				classBodyDepth = -1;
			}
			parenDepth = Math.max(0, parenDepth - 1);
			lastIdent = "";
			lastIdentStart = -1;
			afterDot = false;
			i++;
			continue;
		}
		if (ch === "[") {
			bracketDepth++;
			pendingKey = "";
			lastIdent = "";
			lastIdentStart = -1;
			afterDot = false;
			i++;
			continue;
		}
		if (ch === "]") {
			bracketDepth = Math.max(0, bracketDepth - 1);
			lastIdent = "";
			lastIdentStart = -1;
			afterDot = false;
			i++;
			continue;
		}
		if (ch === "{") {
			braceDepth++;
			if (pendingKey === "methods") {
				methodsDepth = braceDepth;
			} else if (
				!pendingKey &&
				extDefineParen >= 0 &&
				classBodyDepth < 0 &&
				bracketDepth === 0
			) {
				classBodyDepth = braceDepth;
			}
			pendingKey = "";
			lastIdent = "";
			lastIdentStart = -1;
			afterDot = false;
			i++;
			continue;
		}
		if (ch === "}") {
			if (braceDepth === methodsDepth) {
				methodsDepth = -1;
			}
			if (braceDepth === classBodyDepth) {
				classBodyDepth = -1;
			}
			braceDepth = Math.max(0, braceDepth - 1);
			pendingKey = "";
			lastIdent = "";
			lastIdentStart = -1;
			afterDot = false;
			i++;
			continue;
		}
		if (ch === ":") {
			if (
				atMemberDepth() &&
				lastIdent &&
				lastIdent !== "Ext.define" &&
				(lastIdentStart < skipStart || lastIdentStart >= skipEnd)
			) {
				keys.add(lastIdent);
			}
			pendingKey = lastIdent;
			lastIdent = "";
			lastIdentStart = -1;
			afterDot = false;
			i++;
			continue;
		}
		if (ch === "," || ch === ";" || ch === "=") {
			pendingKey = "";
			lastIdent = "";
			lastIdentStart = -1;
			afterDot = false;
			i++;
			continue;
		}

		if (!/\s/.test(ch)) {
			lastIdent = "";
			lastIdentStart = -1;
			afterDot = false;
		}
		i++;
	}

	return keys;
}

function objectKeyPrefix(
	documentText: string,
	offset: number
): Omit<OverrideInsertContext, "kind"> | undefined {
	let identEnd = offset;
	while (
		identEnd < documentText.length &&
		/[A-Za-z0-9_$]/.test(documentText[identEnd])
	) {
		identEnd++;
	}
	let identStart = offset;
	while (identStart > 0 && /[A-Za-z0-9_$]/.test(documentText[identStart - 1])) {
		identStart--;
	}
	const typed = documentText.slice(identStart, offset);
	if (typed && !/^[A-Za-z_$][\w$]*$/.test(typed)) {
		return undefined;
	}

	let k = identEnd;
	while (k < documentText.length && /[ \t]/.test(documentText[k])) {
		k++;
	}
	if (documentText[k] === ":") {
		return undefined;
	}

	let i = identStart - 1;
	while (i >= 0 && /\s/.test(documentText[i])) {
		i--;
	}
	const prev = documentText[i];
	if (prev !== "{" && prev !== ",") {
		return undefined;
	}

	let lineStart = identStart;
	while (lineStart > 0 && documentText[lineStart - 1] !== "\n") {
		lineStart--;
	}
	const indent = documentText.slice(lineStart, identStart);
	if (/[^\t ]/.test(indent)) {
		return undefined;
	}
	return { typed, identStart, identEnd };
}

function scanOverrideScope(
	text: string,
	end: number
): {
	braceDepth: number;
	methodsDepth: number;
	classBodyDepth: number;
} {
	let braceDepth = 0;
	let parenDepth = 0;
	let bracketDepth = 0;
	let methodsDepth = -1;
	let classBodyDepth = -1;
	let extDefineParen = -1;
	let lastIdent = "";
	let pendingKey = "";
	let afterDot = false;
	let i = 0;

	const setIdent = (name: string) => {
		if (afterDot && lastIdent === "Ext" && name === "define") {
			lastIdent = "Ext.define";
		} else {
			lastIdent = name;
		}
		afterDot = false;
	};

	while (i < end) {
		const ch = text[i];
		const next = text[i + 1];

		if (ch === "/" && next === "/") {
			i += 2;
			while (i < end && text[i] !== "\n") {
				i++;
			}
			continue;
		}
		if (ch === "/" && next === "*") {
			i += 2;
			while (i + 1 < end && !(text[i] === "*" && text[i + 1] === "/")) {
				i++;
			}
			i = Math.min(end, i + 2);
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			i = skipJsString(text, i, end);
			pendingKey = "";
			lastIdent = "";
			afterDot = false;
			continue;
		}

		if (/[A-Za-z_$]/.test(ch)) {
			let j = i + 1;
			while (j < end && /[A-Za-z0-9_$]/.test(text[j])) {
				j++;
			}
			setIdent(text.slice(i, j));
			i = j;
			continue;
		}

		if (ch === ".") {
			afterDot = lastIdent === "Ext";
			i++;
			continue;
		}

		if (ch === "(") {
			parenDepth++;
			if (lastIdent === "Ext.define") {
				extDefineParen = parenDepth;
			}
			pendingKey = "";
			lastIdent = "";
			afterDot = false;
			i++;
			continue;
		}
		if (ch === ")") {
			if (parenDepth === extDefineParen) {
				extDefineParen = -1;
				classBodyDepth = -1;
			}
			parenDepth = Math.max(0, parenDepth - 1);
			lastIdent = "";
			afterDot = false;
			i++;
			continue;
		}
		if (ch === "[") {
			bracketDepth++;
			pendingKey = "";
			lastIdent = "";
			afterDot = false;
			i++;
			continue;
		}
		if (ch === "]") {
			bracketDepth = Math.max(0, bracketDepth - 1);
			lastIdent = "";
			afterDot = false;
			i++;
			continue;
		}
		if (ch === "{") {
			braceDepth++;
			if (pendingKey === "methods") {
				methodsDepth = braceDepth;
			} else if (
				!pendingKey &&
				extDefineParen >= 0 &&
				classBodyDepth < 0 &&
				bracketDepth === 0
			) {
				classBodyDepth = braceDepth;
			}
			pendingKey = "";
			lastIdent = "";
			afterDot = false;
			i++;
			continue;
		}
		if (ch === "}") {
			if (braceDepth === methodsDepth) {
				methodsDepth = -1;
			}
			if (braceDepth === classBodyDepth) {
				classBodyDepth = -1;
			}
			braceDepth = Math.max(0, braceDepth - 1);
			pendingKey = "";
			lastIdent = "";
			afterDot = false;
			i++;
			continue;
		}
		if (ch === ":") {
			pendingKey = lastIdent;
			lastIdent = "";
			afterDot = false;
			i++;
			continue;
		}
		if (ch === "," || ch === ";" || ch === "=") {
			pendingKey = "";
			lastIdent = "";
			afterDot = false;
			i++;
			continue;
		}

		if (!/\s/.test(ch)) {
			lastIdent = "";
			afterDot = false;
		}
		i++;
	}

	return {
		braceDepth,
		methodsDepth,
		classBodyDepth
	};
}
