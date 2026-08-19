import * as fs from "fs";
import * as path from "path";
import * as acorn from "acorn";
import * as walk from "acorn-walk";
import { IndexedMember, MemberKind, SourcePosition } from "../index/types";
import { resolveAppLayouts, collectResourceRoots, uniquePaths } from "../index/workspaceLayout";
import { AnyNode, posFromNode, leadingComment } from "../parse/jsAst";

/**
 * this.sandbox API from the app: define("sandbox") in amd/bootstrap.js
 * plus instance fields from createSandbox in amd/core-base.js.
 * Static list is only a fallback when those files are missing.
 */
export function buildSandboxStubs(workspaceRoots: string[]): {
	members: IndexedMember[];
	origin?: { filePath: string; position: SourcePosition };
} {
	const files = findSandboxSourceFiles(workspaceRoots);
	const byName = new Map<string, IndexedMember>();
	let origin: { filePath: string; position: SourcePosition } | undefined;

	for (const filePath of files.bootstrap) {
		const extracted = extractSandboxPrototype(filePath);
		origin = origin || extracted.origin;
		for (const member of extracted.members) {
			byName.set(member.name, member);
		}
	}
	for (const filePath of files.coreBase) {
		for (const member of extractInjectedSandboxFields(filePath)) {
			const prev = byName.get(member.name);
			if (!prev || member.kind === "method") {
				byName.set(member.name, member);
			} else if (!prev.documentation && member.documentation) {
				byName.set(member.name, { ...prev, documentation: member.documentation });
			}
		}
	}

	if (byName.size) {
		return { members: Array.from(byName.values()), origin };
	}
	return { members: getFallbackSandboxStubs() };
}

function findSandboxSourceFiles(roots: string[]): {
	bootstrap: string[];
	coreBase: string[];
} {
	const layouts = resolveAppLayouts(roots);
	const resourceRoots = collectResourceRoots(layouts, roots);

	const bootstrap: string[] = [];
	const coreBase: string[] = [];
	for (const resourcesRoot of resourceRoots) {
		const amdDir = path.join(resourcesRoot, "ui/BPMSoft/amd");
		const bootstrapExact = path.join(amdDir, "bootstrap.js");
		if (fs.existsSync(bootstrapExact)) {
			bootstrap.push(bootstrapExact);
		} else {
			bootstrap.push(...findAmdFilesWithMarker(amdDir, /define\(\s*["']sandbox["']/));
		}
		const coreExact = path.join(amdDir, "core-base.js");
		if (fs.existsSync(coreExact)) {
			coreBase.push(coreExact);
		} else {
			coreBase.push(...findAmdFilesWithMarker(amdDir, /function\s+createSandbox\s*\(/));
		}
	}
	return {
		bootstrap: uniquePaths(bootstrap),
		coreBase: uniquePaths(coreBase)
	};
}

function findAmdFilesWithMarker(amdDir: string, marker: RegExp): string[] {
	if (!fs.existsSync(amdDir)) {
		return [];
	}
	try {
		return fs
			.readdirSync(amdDir)
			.filter((name) => name.endsWith(".js") && !name.includes(".karma."))
			.map((name) => path.join(amdDir, name))
			.filter((full) => {
				try {
					const head = fs.readFileSync(full, { encoding: "utf8" });
					return marker.test(head);
				} catch {
					return false;
				}
			});
	} catch {
		return [];
	}
}

function extractSandboxPrototype(filePath: string): {
	members: IndexedMember[];
	origin?: { filePath: string; position: SourcePosition };
} {
	const parsed = parseWithComments(filePath);
	if (!parsed) {
		return { members: [] };
	}
	const { ast, comments } = parsed;
	const members: IndexedMember[] = [];
	let origin: { filePath: string; position: SourcePosition } | undefined;

	walk.simple(ast, {
		CallExpression(node: AnyNode) {
			if (!isDefineSandbox(node)) {
				return;
			}
			origin = origin || {
				filePath,
				position: posFromNode(node) || { line: 0, character: 0 }
			};
			const factory = factoryArg(node);
			if (!factory) {
				return;
			}
			const obj = resolveSandboxExportsObject(factory);
			if (!obj) {
				return;
			}
			for (const member of objectMembers(obj, comments, filePath)) {
				members.push(member);
			}
		}
		} as any);

	return { members, origin };
}

function extractInjectedSandboxFields(filePath: string): IndexedMember[] {
	const parsed = parseWithComments(filePath);
	if (!parsed) {
		return [];
	}
	const { ast, comments } = parsed;
	const members: IndexedMember[] = [];

	walk.simple(ast, {
		FunctionDeclaration(node: AnyNode) {
			collectCreateSandboxFields(node, comments, filePath, members);
		},
		FunctionExpression(node: AnyNode) {
			collectCreateSandboxFields(node, comments, filePath, members);
		}
		} as any);

	return members;
}

function collectCreateSandboxFields(
	fn: AnyNode,
	comments: acorn.Comment[],
	filePath: string,
	out: IndexedMember[]
): void {
	const id = fn.id as AnyNode | undefined;
	if (id?.type !== "Identifier" || id.name !== "createSandbox") {
		return;
	}
	const instanceNames = new Set<string>();
	walk.simple(fn, {
		VariableDeclarator(node: AnyNode) {
			const init = node.init as AnyNode | undefined;
			const varId = node.id as AnyNode | undefined;
			if (init?.type === "NewExpression" && varId?.type === "Identifier") {
				instanceNames.add(varId.name as string);
			}
		}
		} as any);
	if (!instanceNames.size) {
		return;
	}

	walk.simple(fn, {
		AssignmentExpression(node: AnyNode) {
			const left = node.left as AnyNode | undefined;
			if (left?.type !== "MemberExpression" || left.computed) {
				return;
			}
			const object = left.object as AnyNode;
			const prop = left.property as AnyNode;
			if (object?.type !== "Identifier" || !instanceNames.has(object.name as string)) {
				return;
			}
			if (prop?.type !== "Identifier") {
				return;
			}
			const name = prop.name as string;
			if (!name || name.startsWith("_")) {
				return;
			}
			out.push({
				name,
				kind: inferSandboxKind(node.right as AnyNode, false),
				detail: `sandbox · ${path.basename(filePath)}`,
				documentation: leadingComment(comments, left, 120),
				filePath,
				position: posFromNode(prop)
			});
		}
		} as any);
}

function isDefineSandbox(node: AnyNode): boolean {
	const callee = node.callee as AnyNode | undefined;
	if (callee?.type !== "Identifier" || callee.name !== "define") {
		return false;
	}
	const args = (node.arguments as AnyNode[]) || [];
	const first = args[0];
	return first?.type === "Literal" && first.value === "sandbox";
}

function factoryArg(node: AnyNode): AnyNode | undefined {
	const args = ((node.arguments as AnyNode[]) || []).slice().reverse();
	return args.find(
		(a) => a.type === "FunctionExpression" || a.type === "ArrowFunctionExpression"
	);
}

function resolveSandboxExportsObject(factory: AnyNode): AnyNode | undefined {
	let prototypeSource: AnyNode | undefined;
	walk.simple(factory, {
		AssignmentExpression(node: AnyNode) {
			const left = node.left as AnyNode | undefined;
			if (left?.type !== "MemberExpression" || left.computed) {
				return;
			}
			const prop = left.property as AnyNode;
			if (prop?.type !== "Identifier" || prop.name !== "prototype") {
				return;
			}
			prototypeSource = node.right as AnyNode;
		}
		} as any);

	if (prototypeSource?.type === "ObjectExpression") {
		return prototypeSource;
	}
	if (prototypeSource?.type === "Identifier") {
		const named = findObjectBinding(factory, prototypeSource.name as string);
		if (named) {
			return named;
		}
	}

	let returned: AnyNode | undefined;
	walk.simple(factory, {
		ReturnStatement(node: AnyNode) {
			const arg = node.argument as AnyNode | undefined;
			if (arg?.type === "ObjectExpression") {
				returned = arg;
			}
		}
		} as any);
	return returned;
}

function findObjectBinding(scope: AnyNode, name: string): AnyNode | undefined {
	let found: AnyNode | undefined;
	walk.simple(scope, {
		VariableDeclarator(node: AnyNode) {
			const id = node.id as AnyNode | undefined;
			const init = node.init as AnyNode | undefined;
			if (id?.type === "Identifier" && id.name === name && init?.type === "ObjectExpression") {
				found = init;
			}
		}
		} as any);
	return found;
}

function objectMembers(
	obj: AnyNode,
	comments: acorn.Comment[],
	filePath: string
): IndexedMember[] {
	const members: IndexedMember[] = [];
	if (obj.type !== "ObjectExpression") {
		return members;
	}
	for (const prop of (obj.properties as AnyNode[]) || []) {
		if (prop.type !== "Property") {
			continue;
		}
		const key = prop.key as AnyNode;
		let name: string | undefined;
		if (key?.type === "Identifier") {
			name = key.name as string;
		} else if (key?.type === "Literal" && typeof key.value === "string") {
			name = key.value;
		}
		if (!name || name.startsWith("_")) {
			continue;
		}
		const value = prop.value as AnyNode;
		members.push({
			name,
			kind: inferSandboxKind(value, true),
			detail: `sandbox · ${path.basename(filePath)}`,
			documentation: memberDocumentation(name, value, leadingComment(comments, prop, 120)),
			filePath,
			position: posFromNode(key)
		});
	}
	return members;
}

function inferSandboxKind(
	value: AnyNode | undefined,
	functionRefsAreMethods: boolean
): MemberKind {
	if (!value) {
		return "property";
	}
	if (
		value.type === "FunctionExpression" ||
		value.type === "ArrowFunctionExpression"
	) {
		return "method";
	}
	if (
		functionRefsAreMethods &&
		(value.type === "MemberExpression" || value.type === "Identifier")
	) {
		return "method";
	}
	return "property";
}

function memberDocumentation(
	name: string,
	value: AnyNode,
	comment?: string
): string | undefined {
	const sig = functionSignature(name, value);
	if (comment && sig) {
		return `${sig}\n\n${comment}`;
	}
	return comment || sig;
}

function functionSignature(name: string, value: AnyNode): string | undefined {
	if (value.type !== "FunctionExpression" && value.type !== "ArrowFunctionExpression") {
		return undefined;
	}
	const params = ((value.params as AnyNode[]) || []).map((p) => {
		if (p.type === "Identifier") {
			return p.name as string;
		}
		if (p.type === "RestElement") {
			const arg = p.argument as AnyNode;
			return arg?.type === "Identifier" ? `...${arg.name}` : "...";
		}
		return "?";
	});
	return `${name}(${params.join(", ")})`;
}

function parseWithComments(
	filePath: string
): { ast: AnyNode; comments: acorn.Comment[] } | undefined {
	try {
		const source = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
		const comments: acorn.Comment[] = [];
		const ast = acorn.parse(source, {
			ecmaVersion: "latest",
			sourceType: "script",
			allowReturnOutsideFunction: true,
			locations: true,
			onComment: comments
		}) as AnyNode;
		return { ast, comments };
	} catch {
		return undefined;
	}
}

function getFallbackSandboxStubs(): IndexedMember[] {
	const method = (name: string, documentation: string): IndexedMember => ({
		name,
		kind: "method",
		detail: "sandbox",
		documentation
	});
	const prop = (name: string, documentation: string): IndexedMember => ({
		name,
		kind: "property",
		detail: "sandbox",
		documentation
	});
	return [
		method("subscribe", "subscribe(eventName, eventHandler, scope, tags)"),
		method("unsubscribePtp", "unsubscribePtp(eventName, tags)"),
		method("publish", "publish(eventName, eventArguments, tags)"),
		method("clearListeners", "clearListeners()"),
		method("getCurrentModuleDynamicMessages", "getCurrentModuleDynamicMessages()"),
		method("getEventDescriptor", "getEventDescriptor(eventName)"),
		method("requireModuleDescriptors", "requireModuleDescriptors(moduleNames, callback, scope)"),
		method("loadModule", "loadModule(moduleName, config)"),
		method("unloadModule", "unloadModule(moduleId)"),
		method("registerMessages", "registerMessages(messageConfig)"),
		method("unRegisterMessages", "unRegisterMessages(messages?)"),
		prop("id", "Идентификатор экземпляра модуля"),
		prop("moduleName", "Имя AMD-модуля"),
		prop("profileKey", "Ключ профиля модуля")
	];
}
