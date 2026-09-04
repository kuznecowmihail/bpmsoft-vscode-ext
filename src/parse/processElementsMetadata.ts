/**
 * `ProcessSchemaManager` schemas (naming-guidelines.md §7 "Бизнес-процессы")
 * store their diagram as plain JSON in `metadata.json` — confirmed real,
 * unlike a `ClientUnitSchema`'s diff-DSL `SchemaDifferences` text (see
 * CLAUDE.md §4a) or an `EntitySchemaManager` extension's `+ MetaData.Schema.D2
 * { ... }` diff blocks (`entityMetadata.ts`): `JSON.parse` on the whole file
 * succeeds directly. `MetaData.Schema` has several array-valued keys (their
 * exact names vary — `BK4`/`BK15`/… — not worth depending on), each holding a
 * flat list of diagram elements plus non-diagram bookkeeping records
 * (`ProcessSchemaParameter`/`ProcessSchemaMapping`, the bulk of the file's
 * real content). An element's type is its `BL1` field (the full C# class
 * name, e.g. `BPMSoft.Core.Process.ProcessSchemaUserTask`) — scanning every
 * array-valued key and filtering by a known `BL1` allowlist avoids having to
 * guess which key holds the diagram on a given schema/version.
 */

export type ProcessElementCategory =
	| "action"
	| "event"
	| "eventTimer"
	| "gatewayExclusive"
	| "gatewayParallel"
	| "flowSequence"
	| "flowConditional";

const CLASS_PREFIX = "BPMSoft.Core.Process.";

/** Confirmed exhaustive over real `BL1` values across two installs (256
 * process schemas) — anything not in this table (Lane/LaneSet/Label/
 * Parameter/Mapping/SubProcess-internals, …) isn't a diagram element this
 * guideline has naming rules for and is silently skipped. */
const CATEGORY_BY_CLASS_NAME: Record<string, ProcessElementCategory> = {
	ProcessSchemaUserTask: "action",
	ProcessSchemaFormulaTask: "action",
	ProcessSchemaScriptTask: "action",
	ProcessSchemaWebService: "action",
	ProcessSchemaSubProcess: "action",
	ProcessSchemaStartEvent: "event",
	ProcessSchemaStartSignalEvent: "event",
	ProcessSchemaEndEvent: "event",
	ProcessSchemaTerminateEvent: "event",
	// Excluded from the "event" past-tense-fact rule per the guideline's own
	// carve-out ("для таймеров и условных событий используйте конкретные
	// условия: Каждый день в 10:00, ...") — timers use schedule/condition
	// wording instead.
	ProcessSchemaStartTimerEvent: "eventTimer",
	ProcessSchemaIntermediateCatchTimerEvent: "eventTimer",
	ProcessSchemaExclusiveGateway: "gatewayExclusive",
	ProcessSchemaParallelGateway: "gatewayParallel",
	ProcessSchemaSequenceFlow: "flowSequence",
	ProcessSchemaConditionalFlow: "flowConditional"
};

export interface ProcessElementInfo {
	/** `A2` — the element's own technical/internal name (e.g.
	 * `"TerminateEvent1"`), not its (optional) caption. */
	name: string;
	category: ProcessElementCategory;
}

interface RawProcessMetadataItem {
	className: string;
	name: string;
}

/** Scans every array-valued `MetaData.Schema` key for `BL1`+`A2`-bearing
 * items (see module doc) — the shared low-level step both diagram-element
 * parsing (`parseProcessSchemaElements`) and class-filtered lookups
 * (`parseProcessMetadataItemsByClassName`, used for a `ProcessUserTask`
 * schema's own `ProcessSchemaParameter` items) build on. Returns `[]` on any
 * parse failure — this is a best-effort diagnostic feed, not a build step. */
function parseRawProcessMetadataItems(metadataText: string): RawProcessMetadataItem[] {
	let root: unknown;
	try {
		root = JSON.parse(metadataText);
	} catch {
		return [];
	}
	const schema = (root as { MetaData?: { Schema?: unknown } })?.MetaData?.Schema;
	if (!schema || typeof schema !== "object") {
		return [];
	}
	const out: RawProcessMetadataItem[] = [];
	for (const key of Object.keys(schema as Record<string, unknown>)) {
		const arr = (schema as Record<string, unknown>)[key];
		if (!Array.isArray(arr)) {
			continue;
		}
		for (const item of arr) {
			if (!item || typeof item !== "object") {
				continue;
			}
			const record = item as Record<string, unknown>;
			const classRef = record.BL1;
			const name = record.A2;
			if (typeof classRef !== "string" || !classRef.startsWith(CLASS_PREFIX)) {
				continue;
			}
			if (typeof name !== "string" || !name) {
				continue;
			}
			out.push({ className: classRef.slice(CLASS_PREFIX.length), name });
		}
	}
	return out;
}

/** Parses every diagram element from a Process schema's `metadata.json`
 * (already-loaded file text). */
export function parseProcessSchemaElements(metadataText: string): ProcessElementInfo[] {
	const out: ProcessElementInfo[] = [];
	for (const item of parseRawProcessMetadataItems(metadataText)) {
		const category = CATEGORY_BY_CLASS_NAME[item.className];
		if (category) {
			out.push({ name: item.name, category });
		}
	}
	return out;
}

/** All items of one specific `BL1` class (its short name, without the
 * `BPMSoft.Core.Process.` prefix) — used for a `ProcessUserTaskSchemaManager`
 * schema's own `ProcessSchemaParameter` items, which share the exact same
 * plain-JSON `metadata.json` shape as a Process schema's diagram. */
export function parseProcessMetadataItemsByClassName(metadataText: string, className: string): string[] {
	return parseRawProcessMetadataItems(metadataText)
		.filter((item) => item.className === className)
		.map((item) => item.name);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Best-effort offset of an element's `"A2": "<name>"` occurrence in the raw
 * `metadata.json` text, for positioning the diagnostic squiggly — same
 * approach as `locateJsonNameOffset` elsewhere in this codebase. `A2` values
 * are the diagram's own internal element ids, unique within one schema in
 * practice. */
export function locateProcessElementOffset(metadataText: string, elementName: string): number {
	const re = new RegExp(`"A2"\\s*:\\s*"${escapeRegExp(elementName)}"`);
	const match = re.exec(metadataText);
	if (!match) {
		return 0;
	}
	return match.index + match[0].lastIndexOf(`"${elementName}"`) + 1;
}

/** `<Item Name="{namespace}.{itemName}.Caption" Value="..." />` — the
 * resource-XML shape shared by a Process diagram element's own title
 * (`namespace: "BaseElements"`, in `Resources/{Process}.Process/
 * resource.{culture}.xml`, alongside the process's own top-level `Caption`)
 * and a ProcessUserTask's own parameter title (`namespace: "Parameters"`, in
 * `Resources/{UserTask}.ProcessUserTask/resource.{culture}.xml` — confirmed
 * real, e.g. `GoChangeDataUserTask.ProcessUserTask`'s own resource.ru-RU.xml
 * has `Parameters.RecordColumnValues.Caption`). */
export function findResourceItemCaption(xmlText: string, namespace: string, itemName: string): string | undefined {
	const marker = `${namespace}.${itemName}.Caption" Value="`;
	const idx = xmlText.indexOf(marker);
	if (idx === -1) {
		return undefined;
	}
	const start = idx + marker.length;
	const end = xmlText.indexOf('"', start);
	if (end === -1) {
		return undefined;
	}
	return unescapeXml(xmlText.slice(start, end));
}

/** `findResourceItemCaption` pinned to the `BaseElements` namespace — a
 * Process diagram element's own title. */
export function findProcessElementCaption(xmlText: string, elementName: string): string | undefined {
	return findResourceItemCaption(xmlText, "BaseElements", elementName);
}

function unescapeXml(value: string): string {
	return value
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}
