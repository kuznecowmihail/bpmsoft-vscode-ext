import * as fs from "fs";
import * as path from "path";
import * as acorn from "acorn";
import * as walk from "acorn-walk";
import { PlatformStubMember, MemberKind, SourcePosition } from "../index/types";
import { getStaticPlatformStubs } from "./bpmsoftPlatform";
import { resolveAppLayouts } from "../index/workspaceLayout";

type AnyNode = acorn.Node & Record<string, any>;

/**
 * Build BPMSoft.* completion tree from platform UI enums + conf Structures.
 */
export function buildPlatformStubs(workspaceRoots: string[]): PlatformStubMember[] {
	const layouts = resolveAppLayouts(workspaceRoots);
	const root = new Map<string, PlatformStubMember>();

	for (const stub of getStaticPlatformStubs()) {
		root.set(stub.name, cloneStub(stub));
	}

	const aliasQueue: Array<{ from: string[]; to: string[] }> = [];

	for (const filePath of collectPlatformSourceFiles(layouts, workspaceRoots)) {
		try {
			const source = fs.readFileSync(filePath, "utf8");
			extractAssignments(source, root, aliasQueue, filePath);
		} catch {
			// ignore unreadable / unparsable
		}
	}

	for (const { from, to } of aliasQueue) {
		const sourceNode = getNode(root, from);
		if (!sourceNode) {
			continue;
		}
		const target = ensurePath(root, to);
		if (sourceNode.children?.length) {
			target.kind = sourceNode.kind || "enum";
			target.children = mergeChildren(target.children || [], sourceNode.children);
		} else {
			target.kind = sourceNode.kind || target.kind || "const";
			target.detail = target.detail || sourceNode.detail;
		}
		target.filePath = sourceNode.filePath || target.filePath;
		target.position = sourceNode.position || target.position;
		target.documentation =
			target.documentation ||
			sourceNode.documentation ||
			`alias of BPMSoft.${from.join(".")}`;
	}

	mergeRuntimeSysValues(root, layouts, workspaceRoots);

	const schemaNames = listConfSchemaNames(layouts, workspaceRoots);
	if (schemaNames.length) {
		const structures = ensurePath(root, ["configuration", "Structures"]);
		structures.kind = "namespace";
		structures.documentation = "BPMSoft.configuration.Structures — схемы из conf/content";
		structures.children = schemaNames.map((name) => ({
			name,
			kind: "namespace" as MemberKind,
			detail: "schema",
			documentation: `Structures["${name}"]`
		}));
	}

	ensurePath(root, ["configuration"]).kind = "namespace";

	return Array.from(root.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function collectPlatformSourceFiles(
	layouts: ReturnType<typeof resolveAppLayouts>,
	fallbackRoots: string[]
): string[] {
	const files: string[] = [];
	const relCandidates = [
		"ui/BPMSoft/core/enums/sysenums.js",
		"ui/BPMSoft/core/sys-values.js",
		"ui/BPMSoft/data/constants/data-constants.js",
		"ui/BPMSoft/utils/common/guidutils.js",
		"ui/BPMSoft/data/filters/filter-enums.js",
		"ui/BPMSoft/controls/diagram/diagram-enums.js"
	];

	const resourceRoots = layouts
		.map((l) => l.resourcesRoot)
		.filter((p): p is string => Boolean(p));

	if (!resourceRoots.length) {
		for (const root of fallbackRoots) {
			resourceRoots.push(path.join(root, "Resources"));
		}
	}

	for (const resourcesRoot of resourceRoots) {
		for (const rel of relCandidates) {
			const full = path.join(resourcesRoot, rel);
			if (fs.existsSync(full)) {
				files.push(full);
			}
		}
		const enumsDir = path.join(resourcesRoot, "ui/BPMSoft/core/enums");
		if (fs.existsSync(enumsDir)) {
			try {
				for (const name of fs.readdirSync(enumsDir)) {
					if (name.endsWith(".js")) {
						files.push(path.join(enumsDir, name));
					}
				}
			} catch {
				// ignore
			}
		}
	}
	return Array.from(new Set(files));
}

function listConfSchemaNames(
	layouts: ReturnType<typeof resolveAppLayouts>,
	fallbackRoots: string[]
): string[] {
	const names = new Set<string>();
	const dirs = layouts
		.map((l) => l.confContent)
		.filter((p): p is string => Boolean(p));
	if (!dirs.length) {
		for (const root of fallbackRoots) {
			dirs.push(path.join(root, "conf", "content"));
		}
	}
	for (const dir of dirs) {
		if (!fs.existsSync(dir)) {
			continue;
		}
		try {
			for (const file of fs.readdirSync(dir)) {
				if (!file.endsWith(".js")) {
					continue;
				}
				if (file.endsWith("Resources.js")) {
					continue;
				}
				names.add(file.slice(0, -".js".length));
			}
		} catch {
			// ignore
		}
	}
	return Array.from(names).sort((a, b) => a.localeCompare(b));
}

function extractAssignments(
	source: string,
	root: Map<string, PlatformStubMember>,
	aliasQueue: Array<{ from: string[]; to: string[] }>,
	filePath: string
): void {
	let ast: AnyNode;
	try {
		ast = acorn.parse(source.replace(/^\uFEFF/, ""), {
			ecmaVersion: "latest",
			sourceType: "script",
			allowReturnOutsideFunction: true,
			locations: true
		}) as AnyNode;
	} catch {
		return;
	}

	walk.simple(ast, {
		AssignmentExpression(node: AnyNode) {
			const leftPath = memberPath(node.left as AnyNode);
			if (!leftPath || leftPath[0] !== "BPMSoft" || leftPath.length < 2) {
				return;
			}
			const underBpm = leftPath.slice(1);
			const right = node.right as AnyNode;
			const namePos = posFromNode(assignmentNameNode(node.left as AnyNode));

			if (right.type === "ObjectExpression") {
				const children = objectEnumChildren(right, filePath);
				if (!children.length) {
					return;
				}
				const target = ensurePath(root, underBpm);
				target.kind = "enum";
				target.filePath = target.filePath || filePath;
				target.position = target.position || namePos;
				target.children = mergeChildren(target.children || [], children);
				return;
			}

			const rightPath = memberPath(right);
			if (rightPath && rightPath[0] === "BPMSoft" && rightPath.length >= 2) {
				aliasQueue.push({ from: rightPath.slice(1), to: underBpm });
				return;
			}

			if (underBpm.length >= 1) {
				const name = underBpm[underBpm.length - 1];
				if (name.startsWith("_")) {
					return;
				}
				const kind: MemberKind =
					right.type === "FunctionExpression" ||
					right.type === "ArrowFunctionExpression"
						? "method"
						: "const";
				const params = kind === "method" ? functionParamNames(right) : [];
				const literal =
					right.type === "Literal" &&
					(typeof right.value === "string" || typeof right.value === "number")
						? String(right.value)
						: undefined;
				const stub: PlatformStubMember = {
					name,
					kind,
					detail:
						kind === "method"
							? `(${params.join(", ")})`
							: literal || "enum value",
					documentation: literal ? `\`${literal}\`` : undefined,
					filePath,
					position: namePos
				};
				if (underBpm.length === 1) {
					const prev = root.get(name);
					root.set(name, prev ? mergeChildren([prev], [stub])[0] : stub);
					return;
				}
				const parent = ensurePath(root, underBpm.slice(0, -1));
				parent.children = mergeChildren(parent.children || [], [stub]);
			}
		}
	} as any);
}

function objectEnumChildren(obj: AnyNode, filePath: string): PlatformStubMember[] {
	const out: PlatformStubMember[] = [];
	if (!obj || obj.type !== "ObjectExpression") {
		return out;
	}
	for (const prop of obj.properties as AnyNode[]) {
		if (prop.type !== "Property") {
			continue;
		}
		const key = prop.key as AnyNode;
		let name: string | undefined;
		if (key?.type === "Identifier") {
			name = key.name;
		} else if (key?.type === "Literal" && typeof key.value === "string") {
			name = key.value;
		}
		if (!name || name.startsWith("_")) {
			continue;
		}
		const value = prop.value as AnyNode;
		let kind: MemberKind = "const";
		if (
			value?.type === "FunctionExpression" ||
			value?.type === "ArrowFunctionExpression"
		) {
			kind = "method";
		} else if (value?.type === "ObjectExpression") {
			kind = "enum";
		}
		out.push({
			name,
			kind,
			detail: kind === "method" ? "method" : "enum value",
			filePath,
			position: posFromNode(key)
		});
	}
	return out;
}

function memberPath(node: AnyNode | undefined): string[] | null {
	if (!node) {
		return null;
	}
	if (node.type === "Identifier") {
		return [node.name as string];
	}
	if (node.type !== "MemberExpression" || node.computed) {
		return null;
	}
	const objectPath = memberPath(node.object as AnyNode);
	const prop = node.property as AnyNode;
	if (!objectPath || prop?.type !== "Identifier") {
		return null;
	}
	return [...objectPath, prop.name as string];
}

function assignmentNameNode(node: AnyNode | undefined): AnyNode | undefined {
	if (!node) {
		return undefined;
	}
	if (node.type === "MemberExpression") {
		return (node.property as AnyNode) || node;
	}
	return node;
}

function posFromNode(node: AnyNode | undefined): SourcePosition | undefined {
	const loc = node?.loc?.start;
	if (!loc) {
		return undefined;
	}
	return { line: loc.line - 1, character: loc.column };
}

function functionParamNames(node: AnyNode): string[] {
	const params = (node.params as AnyNode[]) || [];
	const names: string[] = [];
	for (const param of params) {
		if (param?.type === "Identifier") {
			names.push(param.name as string);
			continue;
		}
		if (param?.type === "RestElement" && param.argument?.type === "Identifier") {
			names.push(`...${param.argument.name}`);
			continue;
		}
		if (param?.type === "AssignmentPattern" && param.left?.type === "Identifier") {
			names.push(param.left.name as string);
		}
	}
	return names;
}

function ensurePath(
	root: Map<string, PlatformStubMember>,
	parts: string[]
): PlatformStubMember {
	if (!parts.length) {
		throw new Error("empty path");
	}
	let node: PlatformStubMember = root.get(parts[0]) || {
		name: parts[0],
		kind: "namespace",
		children: []
	};
	if (!root.has(parts[0])) {
		root.set(parts[0], node);
	}
	let children: PlatformStubMember[] = node.children || (node.children = []);
	for (let i = 1; i < parts.length; i++) {
		const part = parts[i];
		let child = children.find((c) => c.name === part);
		if (!child) {
			child = { name: part, kind: "namespace", children: [] };
			children.push(child);
		}
		children = child.children || (child.children = []);
		node = child;
	}
	return node;
}

function getNode(
	root: Map<string, PlatformStubMember>,
	parts: string[]
): PlatformStubMember | undefined {
	if (!parts.length) {
		return undefined;
	}
	let node = root.get(parts[0]);
	for (let i = 1; i < parts.length && node; i++) {
		node = node.children?.find((c) => c.name === parts[i]);
	}
	return node;
}

function mergeChildren(
	existing: PlatformStubMember[],
	incoming: PlatformStubMember[]
): PlatformStubMember[] {
	const map = new Map<string, PlatformStubMember>();
	for (const c of existing) {
		map.set(c.name, c);
	}
	for (const c of incoming) {
		const prev = map.get(c.name);
		if (!prev) {
			map.set(c.name, c);
			continue;
		}
		if (c.children?.length) {
			prev.children = mergeChildren(prev.children || [], c.children);
		}
		prev.kind = prev.kind || c.kind;
		prev.detail = prev.detail || c.detail;
		prev.documentation = prev.documentation || c.documentation;
		prev.filePath = prev.filePath || c.filePath;
		prev.position = prev.position || c.position;
	}
	return Array.from(map.values());
}

/**
 * SysValue keys injected at runtime (ViewModule / SysValuesScriptGenerator),
 * not present in the demo object in ui/BPMSoft/core/sys-values.js.
 */
const RUNTIME_SYSVALUE_FALLBACK: PlatformStubMember[] = [
	{
		name: "CURRENT_FUNCTIONAL_ROLES",
		kind: "const",
		detail: "sys value",
		documentation: "Функциональные роли текущего пользователя (массив lookup: value, displayValue)"
	},
	{
		name: "CURRENT_ORGANIZATIONAL_ROLES",
		kind: "const",
		detail: "sys value",
		documentation: "Организационные роли текущего пользователя (массив lookup: value, displayValue)"
	},
	{
		name: "PRIMARY_LANGUAGE",
		kind: "const",
		detail: "sys value",
		documentation: "Основной язык"
	},
	{
		name: "CUSTOMER",
		kind: "const",
		detail: "sys value",
		documentation: "Код заказчика"
	}
];

function mergeRuntimeSysValues(
	root: Map<string, PlatformStubMember>,
	layouts: ReturnType<typeof resolveAppLayouts>,
	fallbackRoots: string[]
): void {
	const extras = mergeChildren(
		RUNTIME_SYSVALUE_FALLBACK,
		extractSysValueContractKeys(layouts, fallbackRoots)
	);
	for (const parts of [["SysValue"], ["core", "enums", "SysValue"]] as string[][]) {
		const node = ensurePath(root, parts);
		node.kind = node.kind || "enum";
		node.documentation =
			node.documentation ||
			"Системные значения текущего пользователя (JS + runtime ViewModule)";
		node.children = mergeChildren(node.children || [], extras);
	}
}

function extractSysValueContractKeys(
	layouts: ReturnType<typeof resolveAppLayouts>,
	fallbackRoots: string[]
): PlatformStubMember[] {
	const out: PlatformStubMember[] = [];
	const seen = new Set<string>();
	for (const filePath of collectSysValueContractFiles(layouts, fallbackRoots)) {
		let source: string;
		try {
			source = fs.readFileSync(filePath, "utf8");
		} catch {
			continue;
		}
		const re =
			/(?:\/\/\/\s*<summary>\s*([\s\S]*?)\/\/\/\s*<\/summary>\s*)?\[JsonProperty\("([A-Z][A-Z0-9_]*)"\)\]/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(source))) {
			const name = m[2];
			if (seen.has(name)) {
				continue;
			}
			seen.add(name);
			const summary = (m[1] || "")
				.split("\n")
				.map((line) => line.replace(/^\s*\/\/\/\s?/, "").trim())
				.filter((line) => line && line !== "<summary>" && line !== "</summary>")
				.join(" ")
				.trim();
			out.push({
				name,
				kind: "const",
				detail: "sys value",
				documentation: summary || undefined
			});
		}
	}
	return out;
}

function collectSysValueContractFiles(
	layouts: ReturnType<typeof resolveAppLayouts>,
	fallbackRoots: string[]
): string[] {
	const rels = [
		"ResourcesCore/BPMSoft.Web.Common/BPMSoft.Core.ServiceModelContract/SysValues.cs",
		"BPMSoft.Web.Common/BPMSoft.Core.ServiceModelContract/SysValues.cs"
	];
	const roots = new Set<string>();
	for (const layout of layouts) {
		if (layout.appRoot) {
			roots.add(layout.appRoot);
		}
		roots.add(layout.workspaceRoot);
	}
	for (const root of fallbackRoots) {
		roots.add(root);
	}
	const files: string[] = [];
	for (const root of roots) {
		for (const rel of rels) {
			const full = path.join(root, rel);
			if (fs.existsSync(full)) {
				files.push(full);
			}
		}
	}
	return Array.from(new Set(files));
}

function cloneStub(s: PlatformStubMember): PlatformStubMember {
	return {
		name: s.name,
		kind: s.kind,
		detail: s.detail,
		documentation: s.documentation,
		filePath: s.filePath,
		position: s.position,
		children: s.children?.map(cloneStub)
	};
}
