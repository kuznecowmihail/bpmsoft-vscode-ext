import { COLUMN_ARG0 } from "./esqBinds";

export type { EsqColumnAccess } from "./esqBinds";
export {
	resolveQueryEntities,
	resolveQueryClassNames,
	collectEsqColumnAccesses
} from "./esqBinds";

const METHOD_ARG0_PATTERN = [...COLUMN_ARG0].join("|");

export interface EsqNameSpan {
	quote: '"' | "'" | undefined;
	name: string;
	nameStart: number;
	nameEnd: number;
}

export interface EsqColumnContext extends EsqNameSpan {
	/** Receiver identifier (esq, update, insert). Undefined for BPMSoft.createColumnFilterWithParameter */
	queryIdent?: string;
	method: string;
}

function identEndPlain(documentText: string, offset: number): number {
	let nameEnd = offset;
	while (
		nameEnd < documentText.length &&
		/[\w$]/.test(documentText[nameEnd])
	) {
		nameEnd++;
	}
	return nameEnd;
}

function identEndDotted(documentText: string, offset: number): number {
	let nameEnd = offset;
	while (
		nameEnd < documentText.length &&
		/[\w.$]/.test(documentText[nameEnd])
	) {
		nameEnd++;
	}
	return nameEnd;
}

function nameSpanAt(
	documentText: string,
	offset: number,
	typed: string,
	allowDots: boolean
): { name: string; nameStart: number; nameEnd: number } {
	const nameEnd = allowDots
		? identEndDotted(documentText, offset)
		: identEndPlain(documentText, offset);
	return {
		name: typed + documentText.slice(offset, nameEnd),
		nameStart: offset - typed.length,
		nameEnd
	};
}

export function getRootSchemaNameContext(
	text: string,
	offset: number
): EsqNameSpan | undefined {
	const before = text.slice(Math.max(0, offset - 400), offset);
	const m = before.match(
		/rootSchemaName\s*:\s*(?:(["'])([\w$]*)|([\w$]*))$/
	);
	if (!m) {
		return undefined;
	}
	const quote = (m[1] as '"' | "'" | undefined) || undefined;
	const typed = (quote ? m[2] : m[3]) || "";
	if (!quote) {
		return {
			quote: undefined,
			name: "",
			nameStart: offset,
			nameEnd: offset
		};
	}
	return {
		quote,
		...nameSpanAt(text, offset, typed, false)
	};
}

function buildColumnContext(
	text: string,
	offset: number,
	method: string,
	queryIdent: string | undefined,
	quote: '"' | "'" | undefined,
	typed: string
): EsqColumnContext {
	let ident = queryIdent;
	if (ident === "this" || ident === "BPMSoft") {
		ident = undefined;
	}
	if (!quote) {
		return {
			method,
			queryIdent: ident,
			quote: undefined,
			name: "",
			nameStart: offset,
			nameEnd: offset
		};
	}
	return {
		method,
		queryIdent: ident,
		quote,
		...nameSpanAt(text, offset, typed, true)
	};
}

export function getQueryColumnContext(
	text: string,
	offset: number
): EsqColumnContext | undefined {
	const before = text.slice(Math.max(0, offset - 500), offset);

	const arg0Re = new RegExp(
		`\\b([A-Za-z_$][\\w$]*)\\s*\\.\\s*(${METHOD_ARG0_PATTERN})\\s*\\(\\s*(?:(["'])([\\w.$]*)|([\\w.$]*))$`
	);
	let m = before.match(arg0Re);
	if (m) {
		const quote = (m[3] as '"' | "'" | undefined) || undefined;
		const typed = (quote ? m[4] : m[5]) || "";
		return buildColumnContext(text, offset, m[2], m[1], quote, typed);
	}

	m = before.match(
		/\b([A-Za-z_$][\w$]*)\s*\.\s*(createColumnFilterWithParameter)\s*\(\s*[^,]+,\s*(?:(["'])([\w.$]*)|([\w.$]*))$/
	);
	if (m) {
		const quote = (m[3] as '"' | "'" | undefined) || undefined;
		const typed = (quote ? m[4] : m[5]) || "";
		return buildColumnContext(text, offset, m[2], m[1], quote, typed);
	}

	m = before.match(
		/\bBPMSoft\s*\.\s*createColumnFilterWithParameter\s*\(\s*[^,]+,\s*(?:(["'])([\w.$]*)|([\w.$]*))$/
	);
	if (m) {
		const quote = (m[1] as '"' | "'" | undefined) || undefined;
		const typed = (quote ? m[2] : m[3]) || "";
		return buildColumnContext(
			text,
			offset,
			"createColumnFilterWithParameter",
			undefined,
			quote,
			typed
		);
	}

	return undefined;
}
