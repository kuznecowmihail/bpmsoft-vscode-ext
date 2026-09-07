import * as fs from "fs";
import * as path from "path";
import { IndexedMember } from "./types";
import { offsetToLineCharacter } from "../textOffset";

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

/**
 * `S2` in a `MetaData.Schema.D2` column block is the column's own
 * `DataValueType`, but stored as an opaque GUID (a foreign key into the
 * platform's own data-type catalog), not a readable enum value — unlike a
 * schema/entity `.js` source, where `dataValueType: BPMSoft.DataValueType.X`
 * is right there as a symbolic constant. This table decodes it, confirmed
 * against real column blocks (`GoTicket.metadata.json`'s `GoName` S2 →
 * MaxSizeText, `GoStatus` S2 → Lookup, `GoKey` S2 → ShortText — all exact
 * matches) plus the platform's own C# `DataValueTypeUId` constants (the
 * source the exact GUID values below came from). Keys lowercase, no braces,
 * matching how the metadata JSON actually stores them. Two C# constants
 * (`DbObjectName`, `Binary`) have no corresponding entry in the client-side
 * `BPMSoft.DataValueType` enum (`sysenums.js`) — kept under their own literal
 * names so lookups still succeed, but they won't resolve to a control via
 * `ViewControlsIndex` since nothing in `DATA_VALUE_TYPE_CLASS_NAMES` names
 * them either.
 */
const DATA_VALUE_TYPE_GUID_NAMES: Record<string, string> = {
	"90b65bf8-0ffc-4141-8779-2420877af907": "BOOLEAN",
	"325a73b8-0f47-44a0-8412-7606f78003ac": "SHORT_TEXT",
	"ddb3a1ee-07e8-4d62-b7a9-d0e618b00fbd": "MEDIUM_TEXT",
	"5ca35f10-a101-4c67-a96a-383da6afacfc": "LONG_TEXT",
	"c0f04627-4620-4bc0-84e5-9419dc8516b1": "MAXSIZE_TEXT",
	"8b3f29bb-ea14-4ce5-a5c5-293a929b6ba2": "TEXT",
	"3509b9dd-2c90-4540-b82e-8f6ae85d8248": "SECURE_TEXT",
	"ecbcce18-2a17-4ead-829a-9d02fa9578a4": "HASH_TEXT",
	"0eaaa70f-2a5a-444e-bdf1-98b37895c820": "DB_OBJECT_NAME",
	"95c6e6c4-2cc8-46be-a1cb-96f942655f86": "LOCALIZABLE_STRING",
	"6b6b74e2-820d-490e-a017-2b73d4ccf2b0": "INTEGER",
	"57ee4c31-5ec4-45fa-b95d-3a2868aa89a8": "FLOAT",
	"07ba84ce-0bf7-44b4-9f2c-7b15032eb98c": "FLOAT1",
	"5cc8060d-6d10-4773-89fc-8c12d6f659a6": "FLOAT2",
	"3f62414e-6c25-4182-bcef-a73c9e396f31": "FLOAT3",
	"ff22e049-4d16-46ee-a529-92d8808932dc": "FLOAT4",
	"a4aaf398-3531-4a0d-9d75-a587f5b5b59e": "FLOAT8",
	"969093e2-2b4e-463b-883a-3d3b8c61f0cd": "MONEY",
	"b295071f-7ea9-4e62-8d1a-919bf3732ff2": "LOOKUP",
	"23018567-a13c-4320-8687-fd6f9e3699bd": "GUID",
	"d21e9ef4-c064-4012-b286-fa1a8171da44": "DATE_TIME",
	"603d4960-a1a2-45e9-b232-206a54421b01": "DATE",
	"b7342b7a-5dde-40de-aa7c-24d2a57b3202": "BINARY",
	"04cc757b-8f06-482c-8a1a-0c0e171d2410": "TIME",
	"51fb23ba-3eb2-11e2-b7d5-b0c76188709b": "ENTITY_COLLECTION",
	"b53eaa2a-4bb7-4a6b-9f4f-58ccab293e31": "ENTITY_COLUMN_MAPPING_COLLECTION",
	"cffc4762-c5c7-44bc-8cc6-cb55aba6e06b": "LOCALIZABLE_PARAMETER_VALUES_LIST",
	"394e160f-c8e0-46fa-9c0d-75d97e9e9169": "METADATA_TEXT",
	"4b51a8b5-1ee9-4437-9d58-f35e083cbcdf": "OBJECT_LIST",
	"651ec16f-d140-46db-b9e2-825c985a8ac2": "COMPOSITE_OBJECT_LIST",
	"a33c9252-d401-453e-949d-169157067ed9": "FILE_LOCATOR"
};

function decodeDataValueType(s2: unknown): string | undefined {
	if (typeof s2 !== "string") {
		return undefined;
	}
	const name = DATA_VALUE_TYPE_GUID_NAMES[s2.toLowerCase()];
	return name ? `BPMSoft.DataValueType.${name}` : undefined;
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
			position: offsetToLineCharacter(source, braceStart + a2ValueOffset(json)),
			children: lookup ? lookupChildren() : undefined,
			detail: lookup ? "entity lookup" : "entity",
			dataValueType: decodeDataValueType(obj.S2)
		});
	}
	return members;
}

export interface EntityColumnCaption {
	caption?: string;
	description?: string;
}

export function localeRank(locale: string): number {
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

/** Description + lookup note only - deliberately excludes the column's own
 * `caption` (unlike its earlier shape), since callers now surface that
 * separately as `IndexedMember.caption` (shown prominently in a hover's own
 * header/subtitle) rather than folded into the general documentation body,
 * where it would otherwise be repeated. */
export function entityColumnDocumentation(
	captions: Map<string, EntityColumnCaption>,
	name: string,
	isLookup: boolean
): string | undefined {
	const text = captions.get(name);
	const bits: string[] = [];
	if (text?.description) {
		bits.push(text.description);
	}
	if (isLookup) {
		bits.push("fields: value, displayValue");
	}
	return bits.length ? bits.join("\n\n") : undefined;
}

const SCHEMA_CAPTION_RE = /<Item\s+Name="Caption"\s+Value="([^"]*)"\s*\/>/;

/** `<Item Name="Caption" Value="..." />` at the top level of an entity's own
 * `Resources/{Entity}.Entity/resource.{culture}.xml` - the entity's own
 * human-readable title, as opposed to the per-column `Columns.X.Caption`
 * items `parseEntityResourceCaptions` reads from the same file. */
export function parseEntitySchemaCaption(xml: string): string | undefined {
	const match = SCHEMA_CAPTION_RE.exec(xml);
	const value = match?.[1] ? unescapeXml(match[1]) : undefined;
	return value?.trim() ? value : undefined;
}

export function loadEntitySchemaCaption(resourceDirs: string[]): string | undefined {
	for (const file of collectEntityResourceFiles(resourceDirs)) {
		let xml: string;
		try {
			xml = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const caption = parseEntitySchemaCaption(xml);
		if (caption) {
			return caption;
		}
	}
	return undefined;
}
