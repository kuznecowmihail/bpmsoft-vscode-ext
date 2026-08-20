import * as fs from "fs";
import * as path from "path";
import { IndexedMember, SourcePosition } from "../index/types";

const D2_BLOCK_RE = /^\+ MetaData\.Schema\.D2\s+\{/gm;
const COLUMN_NAME_RE = /^[A-Za-z_][\w]*$/;
const RESOURCE_FILE_RE = /^resource\.(.+)\.xml$/i;
const RESOURCE_ITEM_RE =
	/<Item\s+Name="Columns\.([^"]+)\.(Caption|Description)"\s+Value="([^"]*)"\s*\/>/g;

function lookupChildren(): IndexedMember[] {
	return [
		{
			name: "value",
			kind: "property",
			detail: "lookup/enum",
			documentation: "Идентификатор / код значения"
		},
		{
			name: "displayValue",
			kind: "property",
			detail: "lookup/enum",
			documentation: "Отображаемое значение"
		}
	];
}

function offsetToPosition(source: string, offset: number): SourcePosition {
	let line = 0;
	let lastBreak = -1;
	for (let i = 0; i < offset; i++) {
		if (source.charCodeAt(i) === 10) {
			line++;
			lastBreak = i;
		}
	}
	return { line, character: offset - lastBreak - 1 };
}

function sliceJsonObject(source: string, braceStart: number): string | undefined {
	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = braceStart; i < source.length; i++) {
		const ch = source[i];
		if (inString) {
			if (escape) {
				escape = false;
				continue;
			}
			if (ch === "\\") {
				escape = true;
				continue;
			}
			if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{") {
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0) {
				return source.slice(braceStart, i + 1);
			}
		}
	}
	return undefined;
}

function isLookupColumn(obj: Record<string, unknown>): boolean {
	return obj.S4 != null || obj.E17 != null || obj.E18 != null;
}

function a2ValueOffset(json: string): number {
	const key = json.search(/"A2"\s*:/);
	if (key < 0) {
		return 0;
	}
	const colon = json.indexOf(":", key);
	const quote = json.indexOf('"', colon + 1);
	return quote >= 0 ? quote : key;
}

/**
 * Columns added in Pkg entity metadata (`+ MetaData.Schema.D2 { A2, S4, E17, E18 }`).
 * S4 / E17 / E18 mark LOOKUP (ENUM) with value + displayValue.
 */
export function parsePkgEntityColumns(
	source: string,
	filePath: string
): IndexedMember[] {
	const members: IndexedMember[] = [];
	const seen = new Set<string>();
	D2_BLOCK_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = D2_BLOCK_RE.exec(source))) {
		const braceStart = match.index + match[0].length - 1;
		const json = sliceJsonObject(source, braceStart);
		if (!json) {
			continue;
		}
		let obj: Record<string, unknown>;
		try {
			obj = JSON.parse(json) as Record<string, unknown>;
		} catch {
			continue;
		}
		const name = typeof obj.A2 === "string" ? obj.A2 : "";
		if (!COLUMN_NAME_RE.test(name) || seen.has(name)) {
			continue;
		}
		seen.add(name);
		const lookup = isLookupColumn(obj);
		members.push({
			name,
			kind: "attribute",
			filePath,
			position: offsetToPosition(source, braceStart + a2ValueOffset(json)),
			children: lookup ? lookupChildren() : undefined,
			detail: lookup ? "entity lookup" : "entity"
		});
	}
	return members;
}

export interface EntityColumnCaption {
	caption?: string;
	description?: string;
}

function localeRank(locale: string): number {
	const lower = locale.toLowerCase();
	if (lower === "ru-ru") {
		return 0;
	}
	if (lower === "en-us") {
		return 1;
	}
	return 2;
}

function unescapeXml(value: string): string {
	return value
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

export function parseEntityResourceCaptions(
	xml: string
): Map<string, EntityColumnCaption> {
	const out = new Map<string, EntityColumnCaption>();
	RESOURCE_ITEM_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = RESOURCE_ITEM_RE.exec(xml))) {
		const name = match[1];
		const field = match[2];
		const value = unescapeXml(match[3]);
		if (!COLUMN_NAME_RE.test(name) || !value) {
			continue;
		}
		const prev = out.get(name) || {};
		if (field === "Caption") {
			prev.caption = prev.caption || value;
		} else {
			prev.description = prev.description || value;
		}
		out.set(name, prev);
	}
	return out;
}

export function collectEntityResourceFiles(resourceDirs: string[]): string[] {
	const ranked: Array<{ rank: number; file: string }> = [];
	for (const dir of resourceDirs) {
		if (!dir || !fs.existsSync(dir)) {
			continue;
		}
		let files: string[];
		try {
			files = fs.readdirSync(dir);
		} catch {
			continue;
		}
		for (const file of files) {
			const match = file.match(RESOURCE_FILE_RE);
			if (!match) {
				continue;
			}
			ranked.push({
				rank: localeRank(match[1]),
				file: path.join(dir, file)
			});
		}
	}
	ranked.sort((a, b) => a.rank - b.rank);
	return ranked.map((item) => item.file);
}

export function loadEntityColumnCaptions(
	resourceDirs: string[]
): Map<string, EntityColumnCaption> {
	const out = new Map<string, EntityColumnCaption>();
	for (const file of collectEntityResourceFiles(resourceDirs)) {
		let xml: string;
		try {
			xml = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const [name, text] of parseEntityResourceCaptions(xml)) {
			const prev = out.get(name) || {};
			if (!prev.caption && text.caption) {
				prev.caption = text.caption;
			}
			if (!prev.description && text.description) {
				prev.description = text.description;
			}
			out.set(name, prev);
		}
	}
	return out;
}

export function entityColumnDocumentation(
	captions: Map<string, EntityColumnCaption>,
	name: string,
	isLookup: boolean
): string | undefined {
	const text = captions.get(name);
	const bits: string[] = [];
	if (text?.caption) {
		bits.push(text.caption);
	}
	if (text?.description) {
		bits.push(text.description);
	}
	if (isLookup) {
		bits.push("fields: value, displayValue");
	}
	return bits.length ? bits.join("\n\n") : undefined;
}
