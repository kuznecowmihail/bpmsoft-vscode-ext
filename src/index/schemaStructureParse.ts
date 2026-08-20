export interface SchemaStructure {
	schemaName: string;
	innerHierarchyStack: string[];
	structureParent?: string;
	/** `BPMSoft.SchemaType.EDIT_VIEW_MODEL_SCHEMA` → `EDIT_VIEW_MODEL_SCHEMA`. */
	schemaType?: string;
}

const STRUCTURES_RE =
	/BPMSoft\.configuration\.Structures\["([^"]+)"\]\s*=\s*\{([^}]*)\}/;

export function packageFromStackEntry(
	schemaName: string,
	entry: string
): string | undefined {
	if (!entry) {
		return undefined;
	}
	if (entry === schemaName) {
		return undefined;
	}
	if (entry.startsWith(schemaName)) {
		const pkg = entry.slice(schemaName.length);
		return pkg || undefined;
	}
	return undefined;
}

export function parseStructuresLine(
	source: string,
	expectedSchema?: string
): SchemaStructure | null {
	const text = source.replace(/^\uFEFF/, "");
	const match = text.match(STRUCTURES_RE);
	if (!match) {
		return null;
	}
	const schemaName = match[1];
	if (expectedSchema && schemaName !== expectedSchema) {
		return null;
	}
	const body = match[2];
	const stackMatch = body.match(/innerHierarchyStack\s*:\s*\[([^\]]*)\]/);
	if (!stackMatch) {
		return null;
	}
	const innerHierarchyStack = Array.from(
		stackMatch[1].matchAll(/"([^"]+)"/g),
		(m) => m[1]
	);
	const parentMatch = body.match(/structureParent\s*:\s*"([^"]*)"/);
	return {
		schemaName,
		innerHierarchyStack,
		structureParent: parentMatch?.[1] || undefined,
		schemaType: parseClientSchemaType(text)
	};
}

/** `type:BPMSoft.SchemaType.EDIT_VIEW_MODEL_SCHEMA` in conf/content `{Schema}.js`. */
export function parseClientSchemaType(source: string): string | undefined {
	const match = source.match(/type:\s*BPMSoft\.SchemaType\.([A-Z0-9_]+)/);
	return match?.[1];
}

/** `EditViewModelSchema` from Pkg `properties.json` → `EDIT_VIEW_MODEL_SCHEMA`. */
export function pascalSchemaTypeToEnum(value: string): string {
	const trimmed = value.trim();
	if (/^[A-Z0-9_]+$/.test(trimmed)) {
		return trimmed;
	}
	return trimmed.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

/**
 * Schema type from Pkg `properties.json`.
 * Creatio wraps fields in `Properties`; some dumps keep a top-level `SchemaType`.
 */
export function parsePkgPropertiesSchemaType(jsonText: string): string | undefined {
	try {
		const parsed = JSON.parse(jsonText.replace(/^\uFEFF/, "")) as {
			SchemaType?: unknown;
			Properties?: { SchemaType?: unknown };
		};
		const nested = parsed?.Properties?.SchemaType;
		const top = parsed?.SchemaType;
		const raw =
			(typeof nested === "string" ? nested : undefined) ||
			(typeof top === "string" ? top : undefined);
		const trimmed = raw?.trim();
		if (trimmed) {
			return pascalSchemaTypeToEnum(trimmed);
		}
	} catch {
		// ignore
	}
	return undefined;
}

/**
 * First Structure `extend: "BPMSoft.…"` / `Ext.…` in a conf/content schema file.
 * Schema-to-schema extend (extend: "BaseDataViewNUI") is ignored.
 */
export function parseStructurePlatformExtend(source: string): string | undefined {
	const text = source.replace(/^\uFEFF/, "");
	const match = text.match(
		/\bextend\s*:\s*['"]((?:BPMSoft|Ext)\.[\w.]+)['"]/
	);
	return match?.[1];
}

/**
 * Whether to follow descriptor/structure parent.
 * Same-name Parent is a replacement from another package — do not walk it
 * (that would recurse forever). Already visited names are also skipped.
 */
export function shouldWalkDescriptorParent(
	currentSchema: string,
	parentName: string | undefined,
	visitedSchemas: Set<string>
): parentName is string {
	return Boolean(
		parentName &&
			parentName !== currentSchema &&
			!visitedSchemas.has(parentName)
	);
}

/**
 * Parent.Name from a client schema descriptor.json.
 */
export function parseDescriptorParent(source: string): string | undefined {
	try {
		const json = JSON.parse(source.replace(/^\uFEFF/, ""));
		const root = json?.Descriptor && typeof json.Descriptor === "object"
			? json.Descriptor
			: json;
		const name = root?.Parent?.Name;
		if (typeof name === "string" && /^[A-Za-z_][\w]*$/.test(name)) {
			return name;
		}
	} catch {
		// ignore
	}
	return undefined;
}
