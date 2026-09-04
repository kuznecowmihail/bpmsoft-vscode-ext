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

/** Parses every diagram element from a Process schema's `metadata.json`
 * (already-loaded file text). Returns `[]` on any parse failure — this is a
 * best-effort diagnostic feed, not a build step. */
export function parseProcessSchemaElements(metadataText: string): ProcessElementInfo[] {
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
	const out: ProcessElementInfo[] = [];
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
			if (typeof classRef !== "string" || !classRef.startsWith(CLASS_PREFIX)) {
				continue;
			}
			const category = CATEGORY_BY_CLASS_NAME[classRef.slice(CLASS_PREFIX.length)];
			if (!category) {
				continue;
			}
			const name = record.A2;
			if (typeof name !== "string" || !name) {
				continue;
			}
			out.push({ name, category });
		}
	}
	return out;
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

/** `<Item Name="BaseElements.{A2}.Caption" Value="..." />` — an element's own
 * title, in the same `Resources/{ProcessName}.Process/resource.{culture}.xml`
 * file as the process's own top-level `Caption` (confirmed real, e.g.
 * `GoActivitySendAssignmentNotificationProcess.Process`'s own resource.ru-RU.xml). */
export function findProcessElementCaption(xmlText: string, elementName: string): string | undefined {
	const marker = `BaseElements.${elementName}.Caption" Value="`;
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

function unescapeXml(value: string): string {
	return value
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}
