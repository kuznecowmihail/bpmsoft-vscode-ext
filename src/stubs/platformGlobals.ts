import * as fs from "fs";
import * as path from "path";
import * as acorn from "acorn";
import * as walk from "acorn-walk";
import { PlatformStubMember, MemberKind } from "../index/types";
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
			extractAssignments(source, root, aliasQueue);
		} catch {
			// ignore unreadable / unparsable
		}
	}

	for (const { from, to } of aliasQueue) {
		const sourceNode = getNode(root, from);
		if (!sourceNode?.children?.length) {
			continue;
		}
		const target = ensurePath(root, to);
		target.kind = sourceNode.kind || "enum";
		target.documentation =
			target.documentation || sourceNode.documentation || `alias of ${from.join(".")}`;
		target.children = mergeChildren(target.children || [], sourceNode.children);
	}

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
	aliasQueue: Array<{ from: string[]; to: string[] }>
): void {
	let ast: AnyNode;
	try {
		ast = acorn.parse(source.replace(/^\uFEFF/, ""), {
			ecmaVersion: "latest",
			sourceType: "script",
			allowReturnOutsideFunction: true
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

			if (right.type === "ObjectExpression") {
				const children = objectEnumChildren(right);
				if (!children.length) {
					return;
				}
				const target = ensurePath(root, underBpm);
				target.kind = "enum";
				target.children = mergeChildren(target.children || [], children);
				return;
			}

			const rightPath = memberPath(right);
			if (rightPath && rightPath[0] === "BPMSoft" && rightPath.length >= 2) {
				aliasQueue.push({ from: rightPath.slice(1), to: underBpm });
			}
		}
	} as any);
}

function objectEnumChildren(obj: AnyNode): PlatformStubMember[] {
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
			detail: kind === "method" ? "method" : "enum value"
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
	}
	return Array.from(map.values());
}

function cloneStub(s: PlatformStubMember): PlatformStubMember {
	return {
		name: s.name,
		kind: s.kind,
		detail: s.detail,
		documentation: s.documentation,
		children: s.children?.map(cloneStub)
	};
}
