import * as fs from "fs";
import * as path from "path";
import * as walk from "acorn-walk";
import { AnyNode, parseJs } from "../parse/jsAst";
import { resolveAppLayouts, walkJsFiles } from "./workspaceLayout";

export interface ViewControlInfo {
	/** Real Ext class name, e.g. "BPMSoft.controls.Button". */
	className: string;
	/** Short alias `ViewGeneratorV2` actually assigns as `values.itemType`'s
	 * target, e.g. "BPMSoft.Button" — kept for debugging/tooltips. */
	alternateClassName?: string;
	filePath: string;
	extend?: string;
	/** Own literal-valued (non-function) prototype properties declared
	 * directly on this class — NOT walked up `extend`, so a control's
	 * properties inherited from its base class (e.g. everything
	 * `BPMSoft.controls.Component` gives every control) aren't included yet.
	 * See CLAUDE.md for why this scope was chosen for a first pass. */
	ownProperties: string[];
}

// Authoritative, straight from the enum's own source —
// `Resources/ui/BPMSoft/core/enums/sysenums.js`'s `BPMSoft.DataValueType = {...}`.
// Exported for reuse by `enumHints.ts` (numeric `dataValueType` inlay
// hints/hover) — keep this the one source of truth rather than duplicating
// the table.
export const DATA_VALUE_TYPE_NAMES: Record<number, string> = {
	0: "GUID",
	1: "TEXT",
	4: "INTEGER",
	5: "FLOAT",
	6: "MONEY",
	7: "DATE_TIME",
	8: "DATE",
	9: "TIME",
	10: "LOOKUP",
	11: "ENUM",
	12: "BOOLEAN",
	13: "BLOB",
	14: "IMAGE",
	15: "CUSTOM_OBJECT",
	16: "IMAGELOOKUP",
	17: "COLLECTION",
	18: "COLOR",
	19: "LOCALIZABLE_STRING",
	20: "ENTITY",
	21: "ENTITY_COLLECTION",
	22: "ENTITY_COLUMN_MAPPING_COLLECTION",
	23: "HASH_TEXT",
	24: "SECURE_TEXT",
	25: "FILE",
	26: "MAPPING",
	27: "SHORT_TEXT",
	28: "MEDIUM_TEXT",
	29: "MAXSIZE_TEXT",
	30: "LONG_TEXT",
	31: "FLOAT1",
	32: "FLOAT2",
	33: "FLOAT3",
	34: "FLOAT4",
	35: "LOCALIZABLE_PARAMETER_VALUES_LIST",
	36: "METADATA_TEXT",
	37: "STAGE_INDICATOR",
	38: "OBJECT_LIST",
	39: "COMPOSITE_OBJECT_LIST",
	40: "FLOAT8",
	41: "FILE_LOCATOR"
};

// Confirmed straight from `ViewGeneratorV2.generateEditControl`'s own
// switch (conf/content/ViewGeneratorV2.js) — see CLAUDE.md §4b. The TEXT
// family (GUID/TEXT/SHORT_TEXT/MEDIUM_TEXT/LONG_TEXT/MAXSIZE_TEXT) all
// resolve here to the plain default ("BPMSoft.TextEdit"); the real code
// sub-dispatches LONG_TEXT/RICH_TEXT by `contentType`, which this extension
// doesn't track. `DATE_TIME` (a composite two-control result) is
// deliberately absent rather than arbitrarily mapped to one of its parts.
const DATA_VALUE_TYPE_CLASS_NAMES: Record<string, string> = {
	GUID: "BPMSoft.TextEdit",
	TEXT: "BPMSoft.TextEdit",
	SHORT_TEXT: "BPMSoft.TextEdit",
	MEDIUM_TEXT: "BPMSoft.TextEdit",
	LONG_TEXT: "BPMSoft.TextEdit",
	MAXSIZE_TEXT: "BPMSoft.TextEdit",
	INTEGER: "BPMSoft.IntegerEdit",
	FLOAT: "BPMSoft.FloatEdit",
	FLOAT1: "BPMSoft.FloatEdit",
	FLOAT2: "BPMSoft.FloatEdit",
	FLOAT3: "BPMSoft.FloatEdit",
	FLOAT4: "BPMSoft.FloatEdit",
	FLOAT8: "BPMSoft.FloatEdit",
	MONEY: "BPMSoft.MoneyEdit",
	DATE: "BPMSoft.DateEdit",
	TIME: "BPMSoft.TimeEdit",
	LOOKUP: "BPMSoft.LookupEdit",
	MAPPING: "BPMSoft.MappingEdit",
	ENUM: "BPMSoft.ComboBoxEdit",
	BOOLEAN: "BPMSoft.CheckBoxEdit",
	STAGE_INDICATOR: "BPMSoft.BaseProgressBar"
};

/** Resolves `dataValueType` (an `IndexedMember.dataValueType` value —
 * either a symbolic `BPMSoft.DataValueType.X` preview string or, if a schema
 * ever authors the bare number the way some do for `itemType`, that numeric
 * form) to its canonical enum name. */
function normalizeDataValueType(dataValueType: string | undefined): string | undefined {
	if (!dataValueType) {
		return undefined;
	}
	const numeric = Number(dataValueType);
	if (Number.isInteger(numeric) && DATA_VALUE_TYPE_NAMES[numeric]) {
		return DATA_VALUE_TYPE_NAMES[numeric];
	}
	const tail = dataValueType.slice(dataValueType.lastIndexOf(".") + 1);
	return DATA_VALUE_TYPE_CLASS_NAMES[tail] ? tail : undefined;
}

const CONTROLS_SUBPATH = ["ui", "BPMSoft", "controls"];
const NON_DATA_KEYS = new Set([
	"extend",
	"alternateClassName",
	"mixins",
	"xtype",
	"singleton",
	"statics",
	"requires",
	"uses",
	"override",
	"config"
]);

/**
 * Maps a `diff` item's `values.itemType` (e.g.
 * `BPMSoft.ViewItemType.BUTTON`) to the real Ext control class that
 * `ViewGeneratorV2.js` ultimately builds for it, and — for that class — the
 * config properties it declares on its own prototype. Used to power the
 * Outline's "available but unfilled" properties list for diff nodes.
 *
 * Two-stage, both stages lazy + cached (mirrors `SchemaHierarchyResolver`):
 * 1. Parse `conf/content/ViewGeneratorV2.js` once for its `case
 *    BPMSoft.ViewItemType.X: result = this.generateY(config);` dispatch
 *    table, then for each referenced `generateY` method's own function body,
 *    pull the first literal `className: "BPMSoft.Z"` it assigns — this is
 *    exhaustive for itemTypes whose generator method assigns a fixed
 *    className (~26 of them; the handful that compute `className`
 *    dynamically, e.g. `generateComponent`, are left unmapped rather than
 *    guessed at).
 * 2. Resolve that className to its real `Ext.define(...)` source under
 *    `Resources/ui/BPMSoft/controls/**` (a top-level `Resources/` at the
 *    install root — distinct from any package's own `Resources/`), then read
 *    off its own declared prototype properties.
 */
export class ViewControlsIndex {
	private confContentDirs: string[] = [];
	private resourcesRoots: string[] = [];
	private itemTypeToClassName = new Map<string, string>();
	private dispatchParsed = false;
	/** className (real or alternate) -> control source file, filled once by
	 * scanning every file under `Resources/ui/BPMSoft/controls/**`. */
	private classNameToFile = new Map<string, string>();
	private controlsScanned = false;
	private controlCache = new Map<string, ViewControlInfo | null>();

	setWorkspaceRoots(roots: string[]): void {
		this.clear();
		const layouts = resolveAppLayouts(roots);
		for (const layout of layouts) {
			if (layout.confContent) {
				this.confContentDirs.push(layout.confContent);
			}
			if (layout.resourcesRoot) {
				this.resourcesRoots.push(layout.resourcesRoot);
			}
		}
	}

	clear(): void {
		this.confContentDirs = [];
		this.resourcesRoots = [];
		this.itemTypeToClassName.clear();
		this.dispatchParsed = false;
		this.classNameToFile.clear();
		this.controlsScanned = false;
		this.controlCache.clear();
	}

	/** `itemType` is the preview string already produced for diff `values`,
	 * e.g. `"BPMSoft.ViewItemType.BUTTON"`. */
	resolveControl(itemType: string | undefined): ViewControlInfo | undefined {
		if (!itemType) {
			return undefined;
		}
		this.ensureDispatchParsed();
		const className = this.itemTypeToClassName.get(itemType);
		if (!className) {
			return undefined;
		}
		return this.resolveClassName(className);
	}

	/**
	 * A `diff` item with no `itemType` at all (the common case for an
	 * ordinary attribute-bound field — just `bindTo`+`layout`) never goes
	 * through `resolveControl` above; its real control comes from a second,
	 * separate dispatch table, `ViewGeneratorV2.generateEditControl`, keyed
	 * on the *bound attribute's own* `dataValueType` (via
	 * `findViewModelColumn`/`getColumnByName(bindTo)`) rather than the diff
	 * item's own config. `dataValueType` here is that attribute's value —
	 * look it up from the Outline's own attribute list (`IndexedMember.
	 * dataValueType`) and pass it here; the caller resolves the join, this
	 * only resolves dataValueType → control. Confirmed exhaustively against
	 * `generateEditControl`'s own switch — see CLAUDE.md §4b — except the
	 * TEXT family, which really sub-dispatches on `contentType`
	 * (LONG_TEXT→MemoEdit, RICH_TEXT→HtmlEdit, else→TextEdit); `contentType`
	 * isn't tracked anywhere in this extension yet, so this always resolves
	 * the TEXT family to the plain-TextEdit default. `DATE_TIME` produces
	 * *two* controls (a date edit and a time edit) — deliberately left
	 * unresolved rather than arbitrarily picking one.
	 */
	resolveControlByDataValueType(dataValueType: string | undefined): ViewControlInfo | undefined {
		const name = normalizeDataValueType(dataValueType);
		const className = name ? DATA_VALUE_TYPE_CLASS_NAMES[name] : undefined;
		return className ? this.resolveClassName(className) : undefined;
	}

	private ensureDispatchParsed(): void {
		if (this.dispatchParsed) {
			return;
		}
		this.dispatchParsed = true;
		for (const dir of this.confContentDirs) {
			const filePath = path.join(dir, "ViewGeneratorV2.js");
			if (fs.existsSync(filePath)) {
				this.parseDispatchFile(filePath);
				return;
			}
		}
	}

	private parseDispatchFile(filePath: string): void {
		let source: string;
		try {
			source = fs.readFileSync(filePath, "utf8");
		} catch {
			return;
		}
		const ast = parseJs(source);
		if (!ast) {
			return;
		}

		const itemTypeToMethod = new Map<string, string>();
		walk.simple(ast, {
			SwitchCase: (node: AnyNode) => {
				const test = node.test as AnyNode | undefined;
				const itemType = memberExpressionPreview(test);
				if (!itemType || !itemType.startsWith("BPMSoft.ViewItemType.")) {
					return;
				}
				const method = findDispatchedGenerateMethod(node.consequent as AnyNode[]);
				if (method) {
					itemTypeToMethod.set(itemType, method);
				}
			}
		} as any);

		// Every `name: function(...) {...}` in the file, not just the
		// generateY dispatch targets — several of those (generateContainer,
		// generateDetail, generateModule, …) don't assign `className`
		// themselves, they delegate to a shared helper like
		// `getDefaultContainerConfig` that does. First occurrence per name
		// wins (the real top-level definition, not some nested nested
		// closure that happens to reuse the name).
		const allMethods = new Map<string, AnyNode>();
		walk.simple(ast, {
			Property: (node: AnyNode) => {
				const key = node.key as AnyNode | undefined;
				const name = key?.type === "Identifier" ? (key.name as string) : undefined;
				const value = node.value as AnyNode | undefined;
				if (name && value?.type === "FunctionExpression" && !allMethods.has(name)) {
					allMethods.set(name, value);
				}
			}
		} as any);

		const methodToClassName = new Map<string, string>();
		for (const method of new Set(itemTypeToMethod.values())) {
			const fn = allMethods.get(method);
			if (!fn) {
				continue;
			}
			const className = findClassNameWithOneHop(fn, allMethods);
			if (className) {
				methodToClassName.set(method, className);
			}
		}

		for (const [itemType, method] of itemTypeToMethod) {
			const className = methodToClassName.get(method);
			if (className) {
				this.itemTypeToClassName.set(itemType, className);
			}
		}
	}

	private resolveClassName(className: string): ViewControlInfo | undefined {
		const cached = this.controlCache.get(className);
		if (cached !== undefined) {
			return cached || undefined;
		}
		this.ensureControlsScanned();
		const filePath = this.classNameToFile.get(className);
		if (!filePath) {
			this.controlCache.set(className, null);
			return undefined;
		}
		const info = this.parseControlFile(filePath);
		this.controlCache.set(className, info || null);
		return info;
	}

	private ensureControlsScanned(): void {
		if (this.controlsScanned) {
			return;
		}
		this.controlsScanned = true;
		for (const resourcesRoot of this.resourcesRoots) {
			const controlsDir = path.join(resourcesRoot, ...CONTROLS_SUBPATH);
			if (!fs.existsSync(controlsDir)) {
				continue;
			}
			for (const filePath of walkJsFiles(controlsDir, () => true)) {
				this.indexControlFileNames(filePath);
			}
		}
	}

	/** Cheap pre-pass: record every `Ext.define("X", {..., alternateClassName:
	 * "Y" | ["Y", ...]})` name in this file against the file path, without a
	 * full parse — most files here are tiny, but the controls dir has a lot
	 * of them (mobile variants, sub-controls) and only the classes actually
	 * referenced by `ViewGeneratorV2.js` end up fully parsed later. */
	private indexControlFileNames(filePath: string): void {
		let source: string;
		try {
			source = fs.readFileSync(filePath, "utf8");
		} catch {
			return;
		}
		const defineRe = /Ext\.define\(\s*["']([^"']+)["']/g;
		let m: RegExpExecArray | null;
		while ((m = defineRe.exec(source))) {
			this.recordClassNameFile(m[1], filePath);
		}
		const aliasRe = /alternateClassName:\s*(\[[^\]]*\]|["'][^"']+["'])/g;
		while ((m = aliasRe.exec(source))) {
			for (const name of extractStringLiterals(m[1])) {
				this.recordClassNameFile(name, filePath);
			}
		}
	}

	/** A `.mobile.js`/`.mobile.` variant redeclares the same class name as
	 * the desktop control it overrides for a different render target — pure
	 * scan order would let whichever file happens to be walked last win,
	 * which found the wrong (much smaller) property set once already. Always
	 * prefer the desktop file when both exist; a mobile-only file is still
	 * used as a fallback if no desktop file declares the name. */
	private recordClassNameFile(name: string, filePath: string): void {
		const existing = this.classNameToFile.get(name);
		if (!existing || (isMobileVariant(existing) && !isMobileVariant(filePath))) {
			this.classNameToFile.set(name, filePath);
		}
	}

	private parseControlFile(filePath: string): ViewControlInfo | undefined {
		let source: string;
		try {
			source = fs.readFileSync(filePath, "utf8");
		} catch {
			return undefined;
		}
		const ast = parseJs(source);
		if (!ast) {
			return undefined;
		}
		let result: ViewControlInfo | undefined;
		walk.simple(ast, {
			CallExpression: (node: AnyNode) => {
				if (result) {
					return;
				}
				const callee = node.callee as AnyNode | undefined;
				if (
					callee?.type !== "MemberExpression" ||
					(callee.object as AnyNode)?.type !== "Identifier" ||
					(callee.object as AnyNode).name !== "Ext" ||
					(callee.property as AnyNode)?.type !== "Identifier" ||
					(callee.property as AnyNode).name !== "define"
				) {
					return;
				}
				const args = node.arguments as AnyNode[];
				const nameArg = args[0];
				const configArg = args[1];
				if (nameArg?.type !== "Literal" || configArg?.type !== "ObjectExpression") {
					return;
				}
				result = buildControlInfo(nameArg.value as string, configArg, filePath);
			}
		} as any);
		return result;
	}
}

function buildControlInfo(className: string, config: AnyNode, filePath: string): ViewControlInfo {
	const ownProperties: string[] = [];
	let extend: string | undefined;
	let alternateClassName: string | undefined;
	for (const prop of config.properties as AnyNode[]) {
		if (prop.type !== "Property") {
			continue;
		}
		const key = prop.key as AnyNode;
		const name = key?.type === "Identifier" ? (key.name as string) : key?.type === "Literal" ? String(key.value) : undefined;
		if (!name) {
			continue;
		}
		if (name === "extend") {
			const value = prop.value as AnyNode;
			extend = value?.type === "Literal" ? (value.value as string) : undefined;
			continue;
		}
		if (name === "alternateClassName") {
			const literals = extractStringLiteralsFromNode(prop.value as AnyNode);
			alternateClassName = literals[0];
			continue;
		}
		if (NON_DATA_KEYS.has(name)) {
			continue;
		}
		const value = prop.value as AnyNode;
		if (value?.type === "FunctionExpression" || value?.type === "ArrowFunctionExpression") {
			continue;
		}
		ownProperties.push(name);
	}
	return { className, alternateClassName, filePath, extend, ownProperties };
}

function extractStringLiteralsFromNode(node: AnyNode | undefined): string[] {
	if (!node) {
		return [];
	}
	if (node.type === "Literal" && typeof node.value === "string") {
		return [node.value];
	}
	if (node.type === "ArrayExpression") {
		return (node.elements as AnyNode[])
			.filter((e) => e && e.type === "Literal" && typeof e.value === "string")
			.map((e) => e.value as string);
	}
	return [];
}

function isMobileVariant(filePath: string): boolean {
	return /\.mobile\.js$/i.test(filePath);
}

function extractStringLiterals(text: string): string[] {
	const out: string[] = [];
	const re = /["']([^"']+)["']/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		out.push(m[1]);
	}
	return out;
}

/** `BPMSoft.ViewItemType.BUTTON` style member expression, source-text form. */
function memberExpressionPreview(node: AnyNode | undefined): string | undefined {
	if (!node) {
		return undefined;
	}
	if (node.type === "Identifier") {
		return node.name as string;
	}
	if (node.type === "MemberExpression" && !node.computed) {
		const obj = memberExpressionPreview(node.object as AnyNode);
		const prop = (node.property as AnyNode)?.name as string | undefined;
		return obj && prop ? `${obj}.${prop}` : undefined;
	}
	return undefined;
}

/** Within one `case` block's statements, find `result = this.generateY(...)`
 * (the real shape in `ViewGeneratorV2.js`) or a bare `return
 * this.generateY(...)` fallback. */
function findDispatchedGenerateMethod(statements: AnyNode[]): string | undefined {
	for (const stmt of statements) {
		let call: AnyNode | undefined;
		if (stmt.type === "ExpressionStatement") {
			const expr = stmt.expression as AnyNode;
			call = expr?.type === "AssignmentExpression" ? (expr.right as AnyNode) : expr;
		} else if (stmt.type === "ReturnStatement") {
			call = stmt.argument as AnyNode | undefined;
		}
		if (call?.type !== "CallExpression") {
			continue;
		}
		const callee = call.callee as AnyNode | undefined;
		if (
			callee?.type === "MemberExpression" &&
			(callee.object as AnyNode)?.type === "ThisExpression" &&
			(callee.property as AnyNode)?.type === "Identifier"
		) {
			return (callee.property as AnyNode).name as string;
		}
	}
	return undefined;
}

/** First literal `className: "..."` assigned directly in this function's own
 * body (not in a nested function). If none is found, follows the first
 * `this.someHelper(...)` call in the body one level (e.g.
 * `generateContainer`/`generateDetail`/`generateModule` all delegate their
 * whole result object to `getDefaultContainerConfig`, which sets `className`
 * itself) — one hop is enough for every case observed across both installs;
 * a handful of generators compute `className` dynamically
 * (`className: config.className`) and are deliberately left unresolved
 * rather than guessed at. */
function findClassNameWithOneHop(fn: AnyNode, allMethods: Map<string, AnyNode>): string | undefined {
	const direct = findOwnClassNameLiteral(fn.body as AnyNode);
	if (direct) {
		return direct;
	}
	// Not every `this.X(...)` call in the body is the one that builds the
	// result object (e.g. `generateContainer` calls `this.getControlId(...)`
	// first, purely to compute an id string, before the real
	// `this.getDefaultContainerConfig(...)` that sets `className`) — try
	// each candidate in call order until one actually has the literal.
	for (const helperName of findThisCallCallees(fn.body as AnyNode)) {
		const helperFn = allMethods.get(helperName);
		const className = helperFn && findOwnClassNameLiteral(helperFn.body as AnyNode);
		if (className) {
			return className;
		}
	}
	return undefined;
}

function findOwnClassNameLiteral(body: AnyNode): string | undefined {
	let found: string | undefined;
	walk.simple(body, {
		Property: (node: AnyNode) => {
			if (found) {
				return;
			}
			const key = node.key as AnyNode;
			if (key?.type !== "Identifier" || key.name !== "className") {
				return;
			}
			const value = node.value as AnyNode;
			if (value?.type === "Literal" && typeof value.value === "string") {
				found = value.value;
			}
		}
	} as any);
	return found;
}

function findThisCallCallees(body: AnyNode): string[] {
	const found: string[] = [];
	walk.simple(body, {
		CallExpression: (node: AnyNode) => {
			const callee = node.callee as AnyNode | undefined;
			if (
				callee?.type === "MemberExpression" &&
				(callee.object as AnyNode)?.type === "ThisExpression" &&
				(callee.property as AnyNode)?.type === "Identifier"
			) {
				found.push((callee.property as AnyNode).name as string);
			}
		}
	} as any);
	return found;
}
