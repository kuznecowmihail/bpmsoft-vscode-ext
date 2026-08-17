import { StyleFix, StyleIssue } from "./styleAnalyzer";

interface Token {
	kind: "ident" | "kw" | "punct" | "num" | "str";
	value: string;
	start: number;
	end: number;
}

type FrameKind =
	| "file"
	| "ns"
	| "type"
	| "enum"
	| "method"
	| "prop"
	| "accessor"
	| "block"
	| "init";

const IF_CHAIN_WARN_AFTER = 3;

const KEYWORDS = new Set([
	"abstract", "as", "base", "bool", "break", "byte", "case", "catch", "char",
	"checked", "class", "const", "continue", "decimal", "default", "delegate",
	"do", "double", "else", "enum", "event", "explicit", "extern", "false",
	"finally", "fixed", "float", "for", "foreach", "goto", "if", "implicit",
	"in", "int", "interface", "internal", "is", "lock", "long", "namespace",
	"new", "null", "object", "operator", "out", "override", "params", "private",
	"protected", "public", "readonly", "ref", "return", "sbyte", "sealed",
	"short", "sizeof", "stackalloc", "static", "string", "struct", "switch",
	"this", "throw", "true", "try", "typeof", "uint", "ulong", "unchecked",
	"unsafe", "ushort", "using", "virtual", "void", "volatile", "while",
	"add", "alias", "and", "async", "await", "file", "get", "global", "init",
	"managed", "nameof", "nint", "not", "nuint", "or", "partial", "record",
	"remove", "required", "scoped", "set", "unmanaged", "value", "var", "when",
	"where", "with", "yield"
]);

const TYPE_KEYWORDS = new Set([
	"bool", "byte", "char", "decimal", "double", "dynamic", "float", "int",
	"long", "nint", "nuint", "object", "sbyte", "short", "string", "uint",
	"ulong", "ushort", "void", "var"
]);

const MODIFIERS = new Set([
	"public", "private", "protected", "internal", "static", "readonly",
	"volatile", "const", "new", "virtual", "override", "abstract", "sealed",
	"async", "extern", "partial", "unsafe", "required", "ref", "out", "in",
	"params", "file", "scoped", "event"
]);

const ACCESS_MODIFIERS = new Set([
	"public", "private", "protected", "internal", "file"
]);

const TYPE_DECL = new Set([
	"class", "struct", "interface", "enum", "record", "delegate"
]);

const CONTROL_HEADER = new Set([
	"if", "for", "foreach", "while", "switch", "using", "lock", "fixed", "catch"
]);

const BLOCK_KEYWORDS = new Set([
	"else", "do", "try", "finally", "checked", "unchecked", "unsafe"
]);

const ACCESSOR_KEYWORDS = new Set(["get", "set", "init", "add", "remove"]);

const TERMINATORS = new Set(["break", "return", "throw", "continue", "goto"]);

const PUNCT_MULTI = [
	"??=", "<<=", ">>=", "...", "??", "?.", "::", "=>", "==", "!=", "<=", ">=",
	"&&", "||", "++", "--", "<<", ">>", "+=", "-=", "*=", "/=", "%=", "&=",
	"|=", "^="
];

export function collectCsharpStyleIssues(source: string): StyleIssue[] {
	const tokens = tokenize(source);
	if (!tokens.length) {
		return [];
	}
	return new Analyzer(source, tokens).run();
}

class Analyzer {
	private readonly issues: StyleIssue[] = [];
	private readonly n: number;

	constructor(
		private readonly source: string,
		private readonly tokens: Token[]
	) {
		this.n = tokens.length;
	}

	run(): StyleIssue[] {
		let i = 0;
		const stack: FrameKind[] = ["file"];
		while (i < this.n) {
			const tok = this.tokens[i];
			if (tok.value === "{") {
				this.checkAllman(i);
				stack.push(this.inferFrame(i, stack[stack.length - 1]));
				i++;
				continue;
			}
			if (tok.value === "}") {
				this.checkCuddle(i);
				if (stack.length > 1) {
					stack.pop();
				}
				i++;
				continue;
			}
			const frame = stack[stack.length - 1];
			if (tok.value === "if" && this.tokens[i - 1]?.value !== "else") {
				this.checkIfChain(i);
			}
			if (CONTROL_HEADER.has(tok.value) || tok.value === "else") {
				this.checkCurly(i);
			}
			if (tok.value === "switch" && this.tokens[i + 1]?.value === "(") {
				this.checkSwitch(i);
			}
			if (tok.value === "catch") {
				this.checkEmptyCatch(i);
			}
			if (tok.value === "==" || tok.value === "!=") {
				this.checkNullPattern(i);
			}
			if (frame === "file" || frame === "ns" || frame === "type") {
				const next = this.tryParseTypeOrMember(i, frame);
				if (next > i) {
					i = next;
					continue;
				}
			}
			if (frame === "method" || frame === "block" || frame === "accessor") {
				const next = this.tryParseLocal(i);
				if (next > i) {
					i = next;
					continue;
				}
			}
			i++;
		}
		return this.issues;
	}

	private inferFrame(braceIdx: number, parent: FrameKind): FrameKind {
		if (this.isCollectionOrObjectInit(braceIdx)) {
			return "init";
		}
		if (this.isCompactAutoProperty(braceIdx)) {
			return "prop";
		}
		const prev = this.tokens[braceIdx - 1];
		if (prev && ACCESSOR_KEYWORDS.has(prev.value)) {
			return "accessor";
		}
		const kw = this.findDeclKeywordBefore(braceIdx);
		if (kw === "namespace") {
			return "ns";
		}
		if (kw === "enum") {
			return "enum";
		}
		if (kw && TYPE_DECL.has(kw)) {
			return "type";
		}
		if (prev?.value === ")" && this.isPropertyBrace(braceIdx)) {
			return "prop";
		}
		if (prev?.kind === "ident" && this.isPropertyBrace(braceIdx)) {
			return "prop";
		}
		if (prev?.value === ")" || prev?.value === ">" || prev?.kind === "ident") {
			if (parent === "type" || parent === "ns" || parent === "file") {
				return "method";
			}
			if (this.looksLikeMethodBrace(braceIdx)) {
				return "method";
			}
			return "block";
		}
		return "block";
	}

	private looksLikeMethodBrace(braceIdx: number): boolean {
		const prev = this.tokens[braceIdx - 1];
		if (prev?.value !== ")") {
			return false;
		}
		const open = this.matchOpen(braceIdx - 1);
		if (open < 0) {
			return false;
		}
		const name = this.tokens[open - 1];
		if (name?.kind !== "ident") {
			return false;
		}
		const before = this.tokens[open - 2];
		return !!(
			before &&
			(before.kind === "ident" ||
				TYPE_KEYWORDS.has(before.value) ||
				MODIFIERS.has(before.value) ||
				before.value === ">")
		);
	}

	private isPropertyBrace(braceIdx: number): boolean {
		const close = this.matchClose(braceIdx);
		if (close < 0) {
			return false;
		}
		for (let j = braceIdx + 1; j < close; j++) {
			const value = this.tokens[j].value;
			if (ACCESSOR_KEYWORDS.has(value) || ACCESS_MODIFIERS.has(value)) {
				return true;
			}
			if (value === "{" || value === "=>") {
				return true;
			}
			if (value === ";") {
				continue;
			}
			return false;
		}
		return false;
	}

	private isCompactAutoProperty(braceIdx: number): boolean {
		const close = this.matchClose(braceIdx);
		if (close < 0) {
			return false;
		}
		if (!this.sameSourceLine(this.tokens[braceIdx].start, this.tokens[close].start)) {
			return false;
		}
		for (let j = braceIdx + 1; j < close; j++) {
			const value = this.tokens[j].value;
			if (
				ACCESSOR_KEYWORDS.has(value) ||
				ACCESS_MODIFIERS.has(value) ||
				value === ";"
			) {
				continue;
			}
			return false;
		}
		return close > braceIdx + 1;
	}

	private isCollectionOrObjectInit(braceIdx: number): boolean {
		const prev = this.tokens[braceIdx - 1];
		if (!prev) {
			return false;
		}
		if (prev.value === "=>") {
			return true;
		}
		if (prev.value === "=" || prev.value === "," || prev.value === "[") {
			return true;
		}
		if (prev.value === "with" || prev.value === "stackalloc") {
			return true;
		}
		if (prev.value === "switch") {
			return true;
		}
		if (prev.kind === "ident" || prev.value === ">") {
			return this.identChainPrecededBy(braceIdx - 1, "new");
		}
		if (prev.value === ")") {
			const open = this.matchOpen(braceIdx - 1);
			if (open < 0) {
				return false;
			}
			const before = this.tokens[open - 1];
			if (before?.kind === "ident" || before?.value === ">") {
				const typeIdx = before.value === ">" ? this.matchOpen(open - 1) - 1 : open - 1;
				return this.identChainPrecededBy(typeIdx, "new");
			}
		}
		return false;
	}

	private identChainPrecededBy(idx: number, keyword: string): boolean {
		let i = idx;
		while (i >= 0) {
			const tok = this.tokens[i];
			if (tok.value === ">" ) {
				const open = this.matchOpen(i);
				if (open < 0) {
					return false;
				}
				i = open - 1;
				continue;
			}
			if (tok.value === "?" || tok.value === "]") {
				i--;
				continue;
			}
			if (tok.value === "[") {
				i--;
				continue;
			}
			if (tok.kind === "ident" || TYPE_KEYWORDS.has(tok.value)) {
				i--;
				if (this.tokens[i]?.value === ".") {
					i--;
					continue;
				}
				if (this.tokens[i]?.value === "::") {
					i--;
					continue;
				}
				return this.tokens[i]?.value === keyword;
			}
			return tok.value === keyword;
		}
		return false;
	}

	private findDeclKeywordBefore(braceIdx: number): string | undefined {
		let i = braceIdx - 1;
		let depthParen = 0;
		let depthAngle = 0;
		while (i >= 0) {
			const tok = this.tokens[i];
			if (tok.value === ";" || tok.value === "{" || tok.value === "}") {
				return undefined;
			}
			if (tok.value === ")") {
				depthParen++;
			} else if (tok.value === "(") {
				if (depthParen === 0) {
					i--;
					continue;
				}
				depthParen--;
			} else if (tok.value === ">") {
				depthAngle++;
			} else if (tok.value === "<") {
				if (depthAngle > 0) {
					depthAngle--;
				}
			} else if (depthParen === 0 && depthAngle === 0 && tok.kind === "kw") {
				if (
					TYPE_DECL.has(tok.value) ||
					tok.value === "namespace" ||
					CONTROL_HEADER.has(tok.value) ||
					BLOCK_KEYWORDS.has(tok.value)
				) {
					return tok.value;
				}
			}
			i--;
		}
		return undefined;
	}

	private shouldCheckAllman(braceIdx: number): boolean {
		if (this.isControlFlowBrace(braceIdx) || this.looksLikeMethodBrace(braceIdx)) {
			return true;
		}
		if (this.isCompactAutoProperty(braceIdx)) {
			return false;
		}
		if (this.isCollectionOrObjectInit(braceIdx)) {
			return false;
		}
		const prev = this.tokens[braceIdx - 1];
		if (!prev) {
			return false;
		}
		if (prev.value === "=" || prev.value === "," || prev.value === "[") {
			return false;
		}
		return true;
	}

	private isControlFlowBrace(braceIdx: number): boolean {
		const kw = this.findDeclKeywordBefore(braceIdx);
		return !!kw && (CONTROL_HEADER.has(kw) || BLOCK_KEYWORDS.has(kw));
	}

	private checkAllman(braceIdx: number): void {
		if (!this.shouldCheckAllman(braceIdx)) {
			return;
		}
		const brace = this.tokens[braceIdx];
		if (isAllmanBrace(this.source, brace.start)) {
			return;
		}
		const prev = this.tokens[braceIdx - 1];
		const fix = braceSplitFix(this.source, brace.start);
		this.issues.push({
			kind: "allmanBrace",
			start: prev ? prev.end : brace.start,
			end: brace.end,
			message: "Ожидается стиль Allman: «{» на новой строке",
			severity: "warning",
			fix: fix
				? {
						title: "Перенести «{» на новую строку",
						start: fix.start,
						end: fix.end,
						text: fix.text
					}
				: undefined
		});
	}

	private checkCuddle(closeIdx: number): void {
		const next = this.tokens[closeIdx + 1];
		if (!next || !["else", "catch", "finally", "while"].includes(next.value)) {
			return;
		}
		const close = this.tokens[closeIdx];
		if (!this.sameSourceLine(close.start, next.start)) {
			return;
		}
		const indent = lineIndent(this.source, close.start);
		const nl = newline(this.source);
		this.issues.push({
			kind: "allmanCuddle",
			start: next.start,
			end: next.end,
			message: `Ожидается стиль Allman: «${next.value}» на новой строке`,
			severity: "warning",
			fix: {
				title: `Перенести «${next.value}» на новую строку`,
				start: close.end,
				end: next.start,
				text: `${nl}${indent}`
			}
		});
	}

	private checkCurly(kwIdx: number): void {
		const tok = this.tokens[kwIdx];
		if (tok.value === "else" && this.tokens[kwIdx + 1]?.value === "if") {
			return;
		}
		if (tok.value === "using" && this.tokens[kwIdx + 1]?.value !== "(") {
			return;
		}
		if (tok.value === "switch") {
			return;
		}
		if (!CONTROL_HEADER.has(tok.value) && tok.value !== "else" && tok.value !== "do") {
			return;
		}
		const bodyIdx = this.controlBodyIndex(kwIdx);
		if (bodyIdx < 0) {
			return;
		}
		if (this.tokens[bodyIdx]?.value === "{") {
			return;
		}
		const end = this.statementEnd(bodyIdx);
		if (end < 0) {
			return;
		}
		const start = this.tokens[bodyIdx].start;
		const stop = this.tokens[end].end;
		const indent = lineIndent(this.source, tok.start);
		const nl = newline(this.source);
		const unit = indent.includes("\t") || !indent ? "\t" : "    ";
		const inner = this.source.slice(start, stop).trim();
		this.issues.push({
			kind: "curly",
			start,
			end: stop,
			message: "Ожидаются фигурные скобки вокруг тела",
			severity: "warning",
			fix: {
				title: "Добавить фигурные скобки",
				start,
				end: stop,
				text: `${nl}${indent}{${nl}${indent}${unit}${inner}${nl}${indent}}`
			}
		});
	}

	private controlBodyIndex(kwIdx: number): number {
		const tok = this.tokens[kwIdx];
		if (
			tok.value === "else" ||
			tok.value === "do" ||
			tok.value === "try" ||
			tok.value === "finally" ||
			(tok.value === "catch" && this.tokens[kwIdx + 1]?.value !== "(")
		) {
			return kwIdx + 1;
		}
		if (this.tokens[kwIdx + 1]?.value !== "(") {
			return -1;
		}
		const close = this.matchClose(kwIdx + 1);
		if (close < 0) {
			return -1;
		}
		if (tok.value === "catch" && this.tokens[close + 1]?.value === "when") {
			if (this.tokens[close + 2]?.value !== "(") {
				return close + 1;
			}
			const whenClose = this.matchClose(close + 2);
			return whenClose < 0 ? -1 : whenClose + 1;
		}
		return close + 1;
	}

	private statementEnd(startIdx: number): number {
		const tok = this.tokens[startIdx];
		if (!tok) {
			return -1;
		}
		if (tok.value === "{") {
			return this.matchClose(startIdx);
		}
		if (
			CONTROL_HEADER.has(tok.value) ||
			tok.value === "else" ||
			tok.value === "do" ||
			tok.value === "try"
		) {
			return this.controlStatementEnd(startIdx);
		}
		let depth = 0;
		for (let j = startIdx; j < this.n; j++) {
			const value = this.tokens[j].value;
			if (value === "(" || value === "{" || value === "[") {
				depth++;
			} else if (value === ")" || value === "}" || value === "]") {
				depth--;
				if (depth < 0) {
					return j - 1;
				}
			} else if (value === ";" && depth === 0) {
				return j;
			}
		}
		return -1;
	}

	private controlStatementEnd(kwIdx: number): number {
		const tok = this.tokens[kwIdx];
		let i = kwIdx;
		if (tok.value === "do") {
			const bodyEnd = this.statementEnd(kwIdx + 1);
			if (bodyEnd < 0) {
				return -1;
			}
			const whileIdx = bodyEnd + 1;
			if (this.tokens[whileIdx]?.value !== "while") {
				return bodyEnd;
			}
			if (this.tokens[whileIdx + 1]?.value !== "(") {
				return bodyEnd;
			}
			const close = this.matchClose(whileIdx + 1);
			if (close < 0) {
				return bodyEnd;
			}
			return this.tokens[close + 1]?.value === ";" ? close + 1 : close;
		}
		if (tok.value === "try") {
			let end = this.statementEnd(kwIdx + 1);
			if (end < 0) {
				return -1;
			}
			while (this.tokens[end + 1]?.value === "catch" || this.tokens[end + 1]?.value === "finally") {
				end = this.controlStatementEnd(end + 1);
				if (end < 0) {
					return -1;
				}
			}
			return end;
		}
		const bodyIdx = this.controlBodyIndex(kwIdx);
		if (bodyIdx < 0) {
			return -1;
		}
		let end = this.statementEnd(bodyIdx);
		if (end < 0) {
			return -1;
		}
		if (tok.value === "if" && this.tokens[end + 1]?.value === "else") {
			return this.controlStatementEnd(end + 1);
		}
		return end;
	}

	private checkIfChain(ifIdx: number): void {
		const chain = this.readIfChain(ifIdx);
		if (!chain || chain.length <= IF_CHAIN_WARN_AFTER) {
			return;
		}
		const start = this.tokens[ifIdx].start;
		const endTok = this.tokens[chain.endIdx];
		const switchText = this.buildSwitchFromIfChain(ifIdx, chain);
		this.issues.push({
			kind: "ifElseChain",
			start,
			end: start + 2,
			message: "Цепочка if/else длиннее 3 ветвей: перейдите на switch",
			severity: "warning",
			fix: switchText
				? {
						title: "Заменить на switch",
						start,
						end: endTok.end,
						text: switchText
					}
				: undefined
		});
	}

	private readIfChain(
		ifIdx: number
	): { length: number; endIdx: number; branches: IfBranch[] } | undefined {
		const branches: IfBranch[] = [];
		let i = ifIdx;
		while (true) {
			if (this.tokens[i]?.value !== "if") {
				return undefined;
			}
			if (this.tokens[i + 1]?.value !== "(") {
				return undefined;
			}
			const testClose = this.matchClose(i + 1);
			if (testClose < 0) {
				return undefined;
			}
			const bodyIdx = testClose + 1;
			const bodyEnd = this.statementEnd(bodyIdx);
			if (bodyEnd < 0) {
				return undefined;
			}
			branches.push({
				testOpen: i + 1,
				testClose,
				bodyIdx,
				bodyEnd
			});
			if (this.tokens[bodyEnd + 1]?.value !== "else") {
				return { length: branches.length, endIdx: bodyEnd, branches };
			}
			const elseIdx = bodyEnd + 1;
			if (this.tokens[elseIdx + 1]?.value === "if") {
				i = elseIdx + 1;
				continue;
			}
			const elseBody = elseIdx + 1;
			const elseEnd = this.statementEnd(elseBody);
			if (elseEnd < 0) {
				return undefined;
			}
			branches.push({
				testOpen: -1,
				testClose: -1,
				bodyIdx: elseBody,
				bodyEnd: elseEnd
			});
			return { length: branches.length, endIdx: elseEnd, branches };
		}
	}

	private buildSwitchFromIfChain(
		ifIdx: number,
		chain: { branches: IfBranch[] }
	): string | undefined {
		let disc: string | undefined;
		const clauses: { labels: string[]; bodyIdx: number; bodyEnd: number }[] = [];
		let defaultBranch: IfBranch | undefined;
		for (const branch of chain.branches) {
			if (branch.testOpen < 0) {
				defaultBranch = branch;
				continue;
			}
			const parsed = this.parseEqualityTest(branch.testOpen + 1, branch.testClose);
			if (!parsed) {
				return undefined;
			}
			if (!disc) {
				disc = parsed.disc;
			} else if (parsed.disc !== disc) {
				return undefined;
			}
			clauses.push({
				labels: parsed.labels,
				bodyIdx: branch.bodyIdx,
				bodyEnd: branch.bodyEnd
			});
		}
		if (!disc || clauses.length < 2) {
			return undefined;
		}
		const nl = newline(this.source);
		const indent = lineIndent(this.source, this.tokens[ifIdx].start);
		const unit = indent.includes("\t") || !indent ? "\t" : "    ";
		const inner = indent + unit;
		const bodyIndent = inner + unit;
		const lines = [`switch (${disc})`, `${indent}{`];
		for (const clause of clauses) {
			for (const label of clause.labels) {
				lines.push(`${inner}case ${label}:`);
			}
			this.pushSwitchBody(lines, clause.bodyIdx, clause.bodyEnd, bodyIndent);
		}
		if (defaultBranch) {
			lines.push(`${inner}default:`);
			this.pushSwitchBody(
				lines,
				defaultBranch.bodyIdx,
				defaultBranch.bodyEnd,
				bodyIndent
			);
		}
		lines.push(`${indent}}`);
		return lines.join(nl);
	}

	private parseEqualityTest(
		from: number,
		to: number
	): { disc: string; labels: string[] } | undefined {
		const parts: { disc: string; label: string }[] = [];
		if (!this.walkOrEquals(from, to, parts) || !parts.length) {
			return undefined;
		}
		const disc = parts[0].disc;
		if (parts.some((part) => part.disc !== disc)) {
			return undefined;
		}
		return { disc, labels: parts.map((part) => part.label) };
	}

	private walkOrEquals(
		from: number,
		to: number,
		parts: { disc: string; label: string }[]
	): boolean {
		let depth = 0;
		for (let j = from; j < to; j++) {
			const value = this.tokens[j].value;
			if (value === "(") {
				depth++;
			} else if (value === ")") {
				depth--;
			} else if (value === "||" && depth === 0) {
				return (
					this.walkOrEquals(from, j, parts) &&
					this.walkOrEquals(j + 1, to, parts)
				);
			}
		}
		if (
			this.tokens[from]?.value === "(" &&
			this.matchClose(from) === to - 1
		) {
			return this.walkOrEquals(from + 1, to - 1, parts);
		}
		let eq = -1;
		depth = 0;
		for (let j = from; j < to; j++) {
			const value = this.tokens[j].value;
			if (value === "(") {
				depth++;
			} else if (value === ")") {
				depth--;
			} else if (value === "==" && depth === 0) {
				eq = j;
				break;
			}
		}
		if (eq < 0) {
			return false;
		}
		const left = this.sliceTokens(from, eq).trim();
		const right = this.sliceTokens(eq + 1, to).trim();
		if (!left || !right) {
			return false;
		}
		const leftLabel = isSwitchLabel(left);
		const rightLabel = isSwitchLabel(right);
		if (leftLabel && !rightLabel) {
			parts.push({ disc: right, label: left });
			return true;
		}
		if (rightLabel && !leftLabel) {
			parts.push({ disc: left, label: right });
			return true;
		}
		if (rightLabel) {
			parts.push({ disc: left, label: right });
			return true;
		}
		return false;
	}

	private pushSwitchBody(
		lines: string[],
		bodyIdx: number,
		bodyEnd: number,
		bodyIndent: string
	): void {
		let from = bodyIdx;
		let to = bodyEnd;
		if (this.tokens[bodyIdx]?.value === "{") {
			from = bodyIdx + 1;
			to = bodyEnd - 1;
		}
		const raw =
			to >= from
				? this.source.slice(this.tokens[from].start, this.tokens[to].end).trim()
				: "";
		let terminates = false;
		if (raw) {
			for (const line of raw.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (trimmed) {
					lines.push(bodyIndent + trimmed);
				}
			}
			terminates = TERMINATORS.has(this.tokens[to]?.value) ||
				this.endsWithTerminator(from, to);
		}
		if (!terminates) {
			lines.push(`${bodyIndent}break;`);
		}
	}

	private endsWithTerminator(from: number, to: number): boolean {
		for (let j = to; j >= from; j--) {
			const value = this.tokens[j].value;
			if (value === ";" || value === "}") {
				continue;
			}
			return TERMINATORS.has(value);
		}
		return false;
	}

	private checkSwitch(switchIdx: number): void {
		if (this.tokens[switchIdx + 1]?.value !== "(") {
			return;
		}
		const parenClose = this.matchClose(switchIdx + 1);
		if (parenClose < 0 || this.tokens[parenClose + 1]?.value !== "{") {
			return;
		}
		const braceOpen = parenClose + 1;
		const braceClose = this.matchClose(braceOpen);
		if (braceClose < 0) {
			return;
		}
		const sections = this.readSwitchSections(braceOpen + 1, braceClose);
		const seen = new Set<string>();
		for (let s = 0; s < sections.length; s++) {
			const section = sections[s];
			for (const label of section.labels) {
				if (seen.has(label)) {
					this.issues.push({
						kind: "switchDuplicateCase",
						start: this.tokens[section.startIdx].start,
						end: this.tokens[section.startIdx].end,
						message: `Повторяющаяся ветка switch «${label}»`,
						severity: "error"
					});
				} else {
					seen.add(label);
				}
			}
			const hasBody = section.bodyStart <= section.bodyEnd;
			const isLast = s === sections.length - 1;
			if (!hasBody || isLast) {
				continue;
			}
			if (this.endsWithTerminator(section.bodyStart, section.bodyEnd)) {
				continue;
			}
			const last = this.tokens[section.bodyEnd];
			const indent = lineIndent(this.source, last.start);
			this.issues.push({
				kind: "switchFallthrough",
				start: this.tokens[section.startIdx].start,
				end: this.tokens[section.startIdx].end,
				message: "Возможен провал в следующую ветку switch: добавьте break",
				severity: "warning",
				fix: {
					title: "Добавить break",
					start: last.end,
					end: last.end,
					text: `\n${indent}break;`
				}
			});
		}
	}

	private readSwitchSections(
		from: number,
		to: number
	): SwitchSection[] {
		const sections: SwitchSection[] = [];
		let i = from;
		while (i < to) {
			if (this.tokens[i].value !== "case" && this.tokens[i].value !== "default") {
				i++;
				continue;
			}
			const startIdx = i;
			const labels: string[] = [];
			while (i < to && (this.tokens[i].value === "case" || this.tokens[i].value === "default")) {
				const kind = this.tokens[i].value;
				const colon = this.findColon(i + 1, to);
				if (colon < 0) {
					return sections;
				}
				labels.push(
					kind === "default"
						? "default"
						: this.sliceTokens(i, colon).replace(/:$/, "").trim()
				);
				i = colon + 1;
			}
			const bodyStart = i;
			let bodyEnd = i - 1;
			let depth = 0;
			while (i < to) {
				const value = this.tokens[i].value;
				if (value === "{") {
					depth++;
				} else if (value === "}") {
					depth--;
				} else if (
					depth === 0 &&
					(value === "case" || value === "default")
				) {
					break;
				}
				bodyEnd = i;
				i++;
			}
			sections.push({ startIdx, labels, bodyStart, bodyEnd });
		}
		return sections;
	}

	private findColon(from: number, to: number): number {
		let depth = 0;
		for (let j = from; j < to; j++) {
			const value = this.tokens[j].value;
			if (value === "(" || value === "[" || value === "{") {
				depth++;
			} else if (value === ")" || value === "]" || value === "}") {
				depth--;
			} else if (value === ":" && depth === 0) {
				return j;
			}
		}
		return -1;
	}

	private checkEmptyCatch(catchIdx: number): void {
		const bodyIdx = this.controlBodyIndex(catchIdx);
		if (bodyIdx < 0 || this.tokens[bodyIdx]?.value !== "{") {
			return;
		}
		const close = this.matchClose(bodyIdx);
		if (close < 0) {
			return;
		}
		const inner = this.source.slice(this.tokens[bodyIdx].end, this.tokens[close].start).trim();
		if (inner) {
			return;
		}
		this.issues.push({
			kind: "emptyCatch",
			start: this.tokens[catchIdx].start,
			end: this.tokens[catchIdx].end,
			message: "Пустой catch: обработайте исключение или явно проглотите его с комментарием",
			severity: "warning"
		});
	}

	private checkNullPattern(idx: number): void {
		const op = this.tokens[idx];
		const left = this.tokens[idx - 1];
		const right = this.tokens[idx + 1];
		const leftNull = left?.value === "null";
		const rightNull = right?.value === "null";
		if (!leftNull && !rightNull) {
			return;
		}
		if (leftNull && rightNull) {
			return;
		}
		const exprTok = leftNull ? right : left;
		if (!exprTok) {
			return;
		}
		const isNot = op.value === "!=";
		const replacement = isNot ? " is not null" : " is null";
		const start = left.start;
		const end = right.end;
		const expr = leftNull
			? this.source.slice(right.start, right.end)
			: this.source.slice(left.start, left.end);
		this.issues.push({
			kind: "nullPattern",
			start,
			end,
			message: isNot
				? "Сравнение с null: используйте «is not null»"
				: "Сравнение с null: используйте «is null»",
			severity: "warning",
			fix: {
				title: isNot ? "Заменить на is not null" : "Заменить на is null",
				start,
				end,
				text: `${expr}${replacement}`
			}
		});
	}

	private tryParseTypeOrMember(i: number, frame: FrameKind): number {
		const tok = this.tokens[i];
		if (!tok) {
			return i;
		}
		if (tok.value === "[" ) {
			const close = this.matchClose(i);
			return close < 0 ? i : this.tryParseTypeOrMember(close + 1, frame);
		}
		if (tok.value === "using" || tok.value === "namespace") {
			return this.skipHeaderToBraceOrSemi(i);
		}
		if (tok.value === "where") {
			return i;
		}
		const mods = this.readModifiers(i);
		let j = mods.next;
		if (j >= this.n) {
			return i;
		}
		if (this.tokens[j].value === "record" && TYPE_DECL.has(this.tokens[j + 1]?.value)) {
			j++;
		}
		if (TYPE_DECL.has(this.tokens[j].value)) {
			return this.parseTypeDecl(j);
		}
		if (frame !== "type") {
			return i;
		}
		if (this.tokens[j].value === "operator" || this.tokens[j].value === "~") {
			return this.skipHeaderToBraceOrSemi(j);
		}
		if (this.tokens[j].value === "explicit" || this.tokens[j].value === "implicit") {
			return this.skipHeaderToBraceOrSemi(j);
		}
		if (this.tokens[j].value === "this") {
			return this.parseIndexer(j);
		}
		const afterType = this.skipType(j);
		if (afterType === j) {
			if (this.tokens[j].kind === "ident" && this.tokens[j + 1]?.value === "(") {
				return this.parseMethod(j, j, mods);
			}
			return i;
		}
		if (this.tokens[afterType]?.value === "this") {
			return this.parseIndexer(afterType);
		}
		const name = this.tokens[afterType];
		if (!name || (name.kind !== "ident" && name.value !== "this")) {
			return i;
		}
		const afterName = this.skipGeneric(afterType + 1);
		const next = this.tokens[afterName];
		if (next?.value === "(") {
			return this.parseMethod(afterType, afterName, mods);
		}
		if (next?.value === "{" || next?.value === "=>") {
			this.checkName(name, "pascalProperty", "Свойство");
			return afterName;
		}
		if (next?.value === "=" || next?.value === ";") {
			this.checkField(name, mods);
			return this.skipToSemi(afterName);
		}
		if (next?.value === ",") {
			this.checkField(name, mods);
			return this.skipFieldList(afterName, mods);
		}
		return i;
	}

	private parseTypeDecl(kwIdx: number): number {
		const kw = this.tokens[kwIdx].value;
		let j = kwIdx + 1;
		const name = this.tokens[j];
		if (name?.kind !== "ident") {
			return this.skipHeaderToBraceOrSemi(kwIdx);
		}
		if (kw === "interface") {
			if (!/^I[A-Z][a-zA-Z0-9]*$/.test(name.value)) {
				const pascal = toPascal(name.value.replace(/^I(?![A-Z])/, ""));
				const next = `I${pascal.replace(/^I/, "")}`;
				this.issues.push({
					kind: "interfacePrefix",
					start: name.start,
					end: name.end,
					message: `Интерфейс «${name.value}» должен быть в стиле IPascalCase`,
					severity: "warning",
					fix: next !== name.value
						? {
								title: `Переименовать в ${next}`,
								start: name.start,
								end: name.end,
								text: next
							}
						: undefined
				});
			}
		} else {
			this.checkName(name, "pascalType", "Тип");
		}
		return this.skipHeaderToBraceOrSemi(j);
	}

	private parseMethod(
		nameIdx: number,
		parenIdx: number,
		mods: ModifierSet
	): number {
		const name = this.tokens[nameIdx];
		if (name.kind === "ident") {
			this.checkName(name, "pascalMethod", "Метод");
			if (mods.async && !name.value.endsWith("Async") && mods.returnLooksLikeTask) {
				this.issues.push({
					kind: "asyncSuffix",
					start: name.start,
					end: name.end,
					message: `Async-метод «${name.value}» должен заканчиваться на Async`,
					severity: "warning",
					fix: {
						title: "Добавить суффикс Async",
						start: name.start,
						end: name.end,
						text: `${name.value}Async`
					}
				});
			}
		}
		if (this.tokens[parenIdx]?.value !== "(") {
			return parenIdx;
		}
		const close = this.matchClose(parenIdx);
		if (close < 0) {
			return parenIdx + 1;
		}
		this.checkParams(parenIdx + 1, close);
		let j = close + 1;
		if (this.tokens[j]?.value === "where") {
			j = this.skipHeaderToBraceOrSemi(j);
			return j;
		}
		return j;
	}

	private parseIndexer(thisIdx: number): number {
		if (this.tokens[thisIdx + 1]?.value !== "[") {
			return thisIdx + 1;
		}
		const close = this.matchClose(thisIdx + 1);
		if (close < 0) {
			return thisIdx + 1;
		}
		this.checkParams(thisIdx + 2, close);
		return close + 1;
	}

	private checkParams(from: number, to: number): void {
		let i = from;
		while (i < to) {
			if (this.tokens[i].value === "[") {
				const close = this.matchClose(i);
				i = close < 0 ? i + 1 : close + 1;
				continue;
			}
			if (this.tokens[i].value === ",") {
				i++;
				continue;
			}
			while (i < to && (MODIFIERS.has(this.tokens[i].value) || this.tokens[i].value === "this")) {
				i++;
			}
			const afterType = this.skipType(i);
			if (afterType === i) {
				i++;
				continue;
			}
			const name = this.tokens[afterType];
			if (name?.kind === "ident") {
				this.checkName(name, "camelParam", "Параметр");
				i = afterType + 1;
			} else {
				i = afterType;
			}
			while (i < to && this.tokens[i].value !== ",") {
				if (this.tokens[i].value === "(") {
					const close = this.matchClose(i);
					i = close < 0 ? i + 1 : close + 1;
					continue;
				}
				i++;
			}
		}
	}

	private checkField(name: Token, mods: ModifierSet): void {
		if (mods.const || mods.event) {
			this.checkName(name, "pascalProperty", mods.event ? "Событие" : "Константа");
			return;
		}
		if (mods.access === "private" || mods.access === "none") {
			if (!isPrivateFieldName(name.value)) {
				const next = toPrivateField(name.value);
				this.issues.push({
					kind: "privateField",
					start: name.start,
					end: name.end,
					message: `Приватное поле «${name.value}» должно быть в стиле _camelCase`,
					severity: "warning",
					fix: next !== name.value
						? {
								title: `Переименовать в ${next}`,
								start: name.start,
								end: name.end,
								text: next
							}
						: undefined
				});
			}
			return;
		}
		this.checkName(name, "pascalProperty", "Поле");
	}

	private tryParseLocal(i: number): number {
		const tok = this.tokens[i];
		if (!tok) {
			return i;
		}
		if (tok.value === "using" && this.tokens[i + 1]?.value !== "(") {
			return this.parseLocalAfter(i + 1);
		}
		if (tok.value === "out" || tok.value === "ref" || tok.value === "const") {
			return this.parseLocalAfter(i + 1);
		}
		if (tok.value === "await" && this.tokens[i + 1]?.value === "using") {
			return this.parseLocalAfter(i + 2);
		}
		if (tok.value === "foreach" || tok.value === "for" || tok.value === "catch") {
			return i;
		}
		return this.parseLocalAfter(i);
	}

	private parseLocalAfter(i: number): number {
		if (this.tokens[i]?.value === "(") {
			const close = this.matchClose(i);
			if (close >= 0 && this.tokens[close + 1]?.value === "=") {
				return this.parseDeconstruction(i);
			}
			return i;
		}
		if (this.tokens[i]?.value === "var") {
			const name = this.tokens[i + 1];
			if (name?.value === "(") {
				return this.parseDeconstruction(i + 1);
			}
			if (name?.kind === "ident") {
				this.checkName(name, "camelLocal", "Локальная переменная");
				return i + 2;
			}
			return i;
		}
		const afterType = this.skipType(i);
		if (afterType === i) {
			return i;
		}
		const name = this.tokens[afterType];
		if (name?.kind !== "ident") {
			return i;
		}
		const afterName = this.skipGeneric(afterType + 1);
		const next = this.tokens[afterName];
		if (next?.value === "(") {
			return this.parseMethod(afterType, afterName, emptyMods());
		}
		if (next?.value === "=" || next?.value === ";" || next?.value === "," || next?.value === "in") {
			this.checkName(name, "camelLocal", "Локальная переменная");
			return afterName;
		}
		return i;
	}

	private parseDeconstruction(openIdx: number): number {
		const close = this.matchClose(openIdx);
		if (close < 0) {
			return openIdx;
		}
		for (let j = openIdx + 1; j < close; j++) {
			const tok = this.tokens[j];
			if (tok.kind === "ident" && this.tokens[j - 1]?.value !== ".") {
				const next = this.tokens[j + 1];
				if (!next || next.value === "," || next.value === ")" || next.value === "=") {
					this.checkName(tok, "camelLocal", "Локальная переменная");
				}
			}
		}
		return close + 1;
	}

	private checkName(
		name: Token,
		kind: "pascalMethod" | "pascalProperty" | "camelLocal" | "camelParam" | "pascalType",
		label: string
	): void {
		const value = stripAt(name.value);
		if (shouldSkipName(value)) {
			return;
		}
		const ok =
			kind === "camelLocal" || kind === "camelParam"
				? isCamelCase(value)
				: isPascalCase(value);
		if (ok) {
			return;
		}
		const next =
			kind === "camelLocal" || kind === "camelParam"
				? toCamel(value)
				: toPascal(value);
		const style =
			kind === "camelLocal" || kind === "camelParam" ? "camelCase" : "PascalCase";
		this.issues.push({
			kind,
			start: name.start,
			end: name.end,
			message: `${label} «${name.value}»: ожидается ${style}`,
			severity: "warning",
			fix: next !== value
				? {
						title: `Переименовать в ${next}`,
						start: name.start,
						end: name.end,
						text: next
					}
				: undefined
		});
	}

	private readModifiers(i: number): ModifierSet {
		const set: ModifierSet = {
			next: i,
			access: "none",
			async: false,
			const: false,
			event: false,
			returnLooksLikeTask: false
		};
		let j = i;
		while (j < this.n && MODIFIERS.has(this.tokens[j].value)) {
			const value = this.tokens[j].value;
			if (value === "private") {
				set.access = "private";
			} else if (
				(value === "public" ||
					value === "internal" ||
					value === "protected" ||
					value === "file") &&
				set.access !== "private"
			) {
				set.access = "public";
			}
			if (value === "async") {
				set.async = true;
			}
			if (value === "const") {
				set.const = true;
			}
			if (value === "event") {
				set.event = true;
			}
			j++;
		}
		set.next = j;
		const typeEnd = this.skipType(j);
		if (typeEnd > j) {
			const typeText = this.sliceTokens(j, typeEnd);
			set.returnLooksLikeTask = /\bTask\b/.test(typeText);
		}
		return set;
	}

	private skipType(i: number): number {
		let j = i;
		if (this.tokens[j]?.value === "global" && this.tokens[j + 1]?.value === "::") {
			j += 2;
		}
		if (this.tokens[j]?.value === "(") {
			const close = this.matchClose(j);
			return close < 0 ? i : this.skipTypeSuffix(close + 1);
		}
		if (
			this.tokens[j]?.kind !== "ident" &&
			!TYPE_KEYWORDS.has(this.tokens[j]?.value)
		) {
			return i;
		}
		j++;
		while (this.tokens[j]?.value === "." || this.tokens[j]?.value === "::") {
			if (this.tokens[j + 1]?.kind !== "ident") {
				break;
			}
			j += 2;
		}
		j = this.skipGeneric(j);
		return this.skipTypeSuffix(j);
	}

	private skipGeneric(i: number): number {
		if (this.tokens[i]?.value !== "<") {
			return i;
		}
		let depth = 0;
		for (let j = i; j < this.n; j++) {
			const value = this.tokens[j].value;
			if (value === "<") {
				depth++;
			} else if (value === ">") {
				depth--;
				if (depth === 0) {
					return j + 1;
				}
			} else if (value === ">>" && depth >= 2) {
				depth -= 2;
				if (depth === 0) {
					return j + 1;
				}
			} else if (value === ";" || value === "{" ) {
				return i;
			}
		}
		return i;
	}

	private skipTypeSuffix(i: number): number {
		let j = i;
		while (j < this.n) {
			if (this.tokens[j].value === "?" || this.tokens[j].value === "*") {
				j++;
				continue;
			}
			if (this.tokens[j].value === "[") {
				const close = this.matchClose(j);
				if (close < 0) {
					return j;
				}
				j = close + 1;
				continue;
			}
			break;
		}
		return j;
	}

	private skipHeaderToBraceOrSemi(i: number): number {
		let depth = 0;
		for (let j = i; j < this.n; j++) {
			const value = this.tokens[j].value;
			if (value === "(" || value === "[" || value === "<") {
				depth++;
			} else if (value === ")" || value === "]" || value === ">") {
				depth--;
			} else if ((value === "{" || value === ";" || value === "=>") && depth <= 0) {
				return j;
			}
		}
		return i + 1;
	}

	private skipToSemi(i: number): number {
		let depth = 0;
		for (let j = i; j < this.n; j++) {
			const value = this.tokens[j].value;
			if (value === "(" || value === "[" || value === "{") {
				depth++;
			} else if (value === ")" || value === "]" || value === "}") {
				depth--;
			} else if (value === ";" && depth === 0) {
				return j + 1;
			}
		}
		return i + 1;
	}

	private skipFieldList(i: number, mods: ModifierSet): number {
		let j = i;
		while (j < this.n) {
			if (this.tokens[j].value === ";") {
				return j + 1;
			}
			if (this.tokens[j].kind === "ident") {
				this.checkField(this.tokens[j], mods);
			}
			if (this.tokens[j].value === "{") {
				return j;
			}
			j++;
		}
		return j;
	}

	private matchClose(openIdx: number): number {
		const open = this.tokens[openIdx]?.value;
		const close = open === "(" ? ")" : open === "{" ? "}" : open === "[" ? "]" : open === "<" ? ">" : "";
		if (!close) {
			return -1;
		}
		let depth = 0;
		for (let j = openIdx; j < this.n; j++) {
			if (this.tokens[j].value === open) {
				depth++;
			} else if (this.tokens[j].value === close) {
				depth--;
				if (depth === 0) {
					return j;
				}
			}
		}
		return -1;
	}

	private matchOpen(closeIdx: number): number {
		const close = this.tokens[closeIdx]?.value;
		const open = close === ")" ? "(" : close === "}" ? "{" : close === "]" ? "[" : close === ">" ? "<" : "";
		if (!open) {
			return -1;
		}
		let depth = 0;
		for (let j = closeIdx; j >= 0; j--) {
			if (this.tokens[j].value === close) {
				depth++;
			} else if (this.tokens[j].value === open) {
				depth--;
				if (depth === 0) {
					return j;
				}
			}
		}
		return -1;
	}

	private sliceTokens(from: number, to: number): string {
		if (from >= to || from < 0) {
			return "";
		}
		return this.source.slice(this.tokens[from].start, this.tokens[to - 1].end);
	}

	private sameSourceLine(a: number, b: number): boolean {
		return this.source.lastIndexOf("\n", a - 1) === this.source.lastIndexOf("\n", b - 1);
	}
}

interface IfBranch {
	testOpen: number;
	testClose: number;
	bodyIdx: number;
	bodyEnd: number;
}

interface SwitchSection {
	startIdx: number;
	labels: string[];
	bodyStart: number;
	bodyEnd: number;
}

interface ModifierSet {
	next: number;
	access: "private" | "public" | "none";
	async: boolean;
	const: boolean;
	event: boolean;
	returnLooksLikeTask: boolean;
}

function emptyMods(): ModifierSet {
	return {
		next: 0,
		access: "none",
		async: false,
		const: false,
		event: false,
		returnLooksLikeTask: false
	};
}

function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	const n = source.length;
	let i = 0;
	while (i < n) {
		const ch = source[i];
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
			i++;
			continue;
		}
		if (ch === "#" && atLineStart(source, i)) {
			while (i < n && source[i] !== "\n") {
				i++;
			}
			continue;
		}
		if (ch === "/" && source[i + 1] === "/") {
			i += 2;
			while (i < n && source[i] !== "\n") {
				i++;
			}
			continue;
		}
		if (ch === "/" && source[i + 1] === "*") {
			i = source.indexOf("*/", i + 2);
			i = i < 0 ? n : i + 2;
			continue;
		}
		if (ch === "'" ) {
			const start = i;
			i = skipChar(source, i);
			tokens.push({
				kind: "str",
				value: source.slice(start, i),
				start,
				end: i
			});
			continue;
		}
		if (ch === '"' || ch === "$" || ch === "@") {
			const next = skipString(source, i);
			if (next > i) {
				tokens.push({
					kind: "str",
					value: source.slice(i, next),
					start: i,
					end: next
				});
				i = next;
				continue;
			}
		}
		if (isIdentStart(ch)) {
			const start = i;
			i++;
			while (i < n && isIdentPart(source[i])) {
				i++;
			}
			const value = source.slice(start, i);
			tokens.push({
				kind: KEYWORDS.has(value) ? "kw" : "ident",
				value,
				start,
				end: i
			});
			continue;
		}
		if (ch === "@" && isIdentStart(source[i + 1])) {
			const start = i;
			i += 2;
			while (i < n && isIdentPart(source[i])) {
				i++;
			}
			tokens.push({
				kind: "ident",
				value: source.slice(start, i),
				start,
				end: i
			});
			continue;
		}
		if (ch >= "0" && ch <= "9") {
			const start = i;
			i++;
			while (i < n && /[0-9a-fA-FxX_.]/.test(source[i])) {
				i++;
			}
			tokens.push({
				kind: "num",
				value: source.slice(start, i),
				start,
				end: i
			});
			continue;
		}
		const multi = matchPunct(source, i);
		tokens.push({
			kind: "punct",
			value: multi.value,
			start: i,
			end: i + multi.value.length
		});
		i += multi.value.length;
	}
	return tokens;
}

function matchPunct(source: string, i: number): { value: string } {
	for (const item of PUNCT_MULTI) {
		if (source.startsWith(item, i)) {
			return { value: item };
		}
	}
	return { value: source[i] };
}

function skipChar(source: string, i: number): number {
	let j = i + 1;
	while (j < source.length) {
		if (source[j] === "\\") {
			j += 2;
			continue;
		}
		if (source[j] === "'") {
			return j + 1;
		}
		j++;
	}
	return source.length;
}

function skipString(source: string, i: number): number {
	let p = i;
	let interpolated = false;
	let verbatim = false;
	while (source[p] === "$" || source[p] === "@") {
		if (source[p] === "$") {
			interpolated = true;
		} else {
			verbatim = true;
		}
		p++;
	}
	if (source[p] !== '"') {
		return i;
	}
	if (source[p + 1] === '"' && source[p + 2] === '"') {
		return skipRawString(source, p, interpolated);
	}
	p++;
	while (p < source.length) {
		const ch = source[p];
		if (verbatim) {
			if (ch === '"' && source[p + 1] === '"') {
				p += 2;
				continue;
			}
		} else if (ch === "\\") {
			p += 2;
			continue;
		}
		if (interpolated && ch === "{") {
			if (source[p + 1] === "{") {
				p += 2;
				continue;
			}
			p = skipInterpolation(source, p + 1);
			continue;
		}
		if (ch === '"') {
			return p + 1;
		}
		p++;
	}
	return source.length;
}

function skipRawString(source: string, quoteIdx: number, interpolated: boolean): number {
	let n = 0;
	while (source[quoteIdx + n] === '"') {
		n++;
	}
	let p = quoteIdx + n;
	while (p < source.length) {
		if (interpolated && source[p] === "{" && source[p + 1] !== "{") {
			p = skipInterpolation(source, p + 1);
			continue;
		}
		if (source[p] === "{") {
			p++;
			continue;
		}
		if (source[p] === '"') {
			let k = 0;
			while (source[p + k] === '"') {
				k++;
			}
			if (k >= n) {
				return p + k;
			}
			p += k;
			continue;
		}
		p++;
	}
	return source.length;
}

function skipInterpolation(source: string, i: number): number {
	let depth = 1;
	let p = i;
	while (p < source.length && depth > 0) {
		if (source[p] === "/" && source[p + 1] === "/") {
			while (p < source.length && source[p] !== "\n") {
				p++;
			}
			continue;
		}
		if (source[p] === "/" && source[p + 1] === "*") {
			const end = source.indexOf("*/", p + 2);
			p = end < 0 ? source.length : end + 2;
			continue;
		}
		if (source[p] === "'" ) {
			p = skipChar(source, p);
			continue;
		}
		if (source[p] === '"' || source[p] === "$" || source[p] === "@") {
			const next = skipString(source, p);
			if (next > p) {
				p = next;
				continue;
			}
		}
		if (source[p] === "{") {
			depth++;
		} else if (source[p] === "}") {
			depth--;
			if (depth === 0) {
				return p + 1;
			}
		}
		p++;
	}
	return p;
}

function atLineStart(source: string, i: number): boolean {
	let j = i - 1;
	while (j >= 0 && (source[j] === " " || source[j] === "\t")) {
		j--;
	}
	return j < 0 || source[j] === "\n" || source[j] === "\r";
}

function isIdentStart(ch: string | undefined): boolean {
	return !!ch && /[A-Za-z_]/.test(ch);
}

function isIdentPart(ch: string): boolean {
	return /[A-Za-z0-9_]/.test(ch);
}

function isAllmanBrace(source: string, braceStart: number): boolean {
	const lineStart = source.lastIndexOf("\n", braceStart - 1) + 1;
	return source.slice(lineStart, braceStart).trim().length === 0;
}

function braceSplitFix(
	source: string,
	braceStart: number
): StyleFix | undefined {
	let i = braceStart - 1;
	while (i >= 0 && (source[i] === " " || source[i] === "\t")) {
		i--;
	}
	if (i < 0 || source[i] === "\n") {
		return undefined;
	}
	const indent = lineIndent(source, i);
	return {
		title: "",
		start: i + 1,
		end: braceStart,
		text: `${newline(source)}${indent}`
	};
}

function lineIndent(source: string, offset: number): string {
	const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
	let i = lineStart;
	while (i < source.length && (source[i] === " " || source[i] === "\t")) {
		i++;
	}
	return source.slice(lineStart, i);
}

function newline(source: string): string {
	return source.includes("\r\n") ? "\r\n" : "\n";
}

function isPascalCase(name: string): boolean {
	return /^[A-Z][a-zA-Z0-9]*$/.test(name);
}

function isCamelCase(name: string): boolean {
	return /^[a-z][a-zA-Z0-9]*$/.test(name);
}

function isPrivateFieldName(name: string): boolean {
	return /^_[a-z][a-zA-Z0-9]*$/.test(name);
}

function stripAt(name: string): string {
	return name.startsWith("@") ? name.slice(1) : name;
}

function shouldSkipName(name: string): boolean {
	return !name || name === "_" || /^_+$/.test(name);
}

function toPascal(name: string): string {
	const stripped = name.replace(/^_+/, "");
	if (!stripped) {
		return name;
	}
	return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

function toCamel(name: string): string {
	const stripped = name.replace(/^_+/, "");
	if (!stripped) {
		return name;
	}
	return stripped.charAt(0).toLowerCase() + stripped.slice(1);
}

function toPrivateField(name: string): string {
	return `_${toCamel(name)}`;
}

function isSwitchLabel(text: string): boolean {
	const trimmed = text.trim();
	return (
		/^(\d+(\.\d+)?|true|false|null|'.*'|".*"|[A-Za-z_][A-Za-z0-9]*(?:\.[A-Za-z_][A-Za-z0-9]*)*)$/.test(
			trimmed
		)
	);
}
