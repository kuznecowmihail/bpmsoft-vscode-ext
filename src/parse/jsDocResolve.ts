/**
 * Turns a raw, already-de-starred JSDoc comment body (`IndexedMember.documentation`,
 * as produced by `leadingComment` in jsAst.ts - `*` gutter stripped, still one
 * `\n`-joined string) into a description + `@tag` list, and resolves the
 * team's `@inheritdoc Owner#member` convention (see `amdOverride.ts`'s
 * `formatOverrideSnippet` and CLAUDE.md's docTagCheck.ts notes on
 * `@overriden`/`@overridden`) into the nearest real description up the
 * chain. Deliberately vscode-free so it's usable from both `HoverProvider`
 * and `CompletionProvider`, and directly testable from scripts/run-smoke.js.
 */

export interface ParsedJsDocTag {
	tag: string;
	text: string;
}

export interface ParsedJsDoc {
	description?: string;
	tags: ParsedJsDocTag[];
}

const OVERRIDE_TAGS = new Set(["override", "overriden", "overridden"]);

/**
 * Splits into free-text description and `@tag text` entries. A tag's text
 * continues onto following non-`@`-prefixed lines until the next tag or the
 * end of the comment.
 */
export function parseJsDocComment(raw: string | undefined): ParsedJsDoc {
	if (!raw) {
		return { tags: [] };
	}
	const descLines: string[] = [];
	const tags: ParsedJsDocTag[] = [];
	let current: ParsedJsDocTag | undefined;
	// Real schemas are commonly CRLF (confirmed against a real file) - a
	// bare split("\n") would leave a stray "\r" at the end of every line
	// but the last, invisible in a single-line description but embedded
	// mid-paragraph for a multi-line one.
	for (const line of raw.split(/\r\n|\r|\n/)) {
		const m = /^\s*@(\S+)\s*(.*)$/.exec(line);
		if (m) {
			current = { tag: m[1], text: m[2].trim() };
			tags.push(current);
			continue;
		}
		if (current) {
			const cont = line.trim();
			if (cont) {
				current.text = current.text ? `${current.text} ${cont}` : cont;
			}
			continue;
		}
		descLines.push(line);
	}
	const description = descLines.join("\n").trim();
	return { description: description || undefined, tags };
}

export interface InheritDocTarget {
	owner: string;
	name: string;
}

/** `@inheritdoc Owner#member` (case-insensitive tag name) - the only shape
 * real schemas and this extension's own override-snippet generator
 * (`amdOverride.ts`) ever write. A bare `@inheritdoc` with no `Owner#member`
 * target has nothing to resolve against. */
export function findInheritDocTarget(tags: ParsedJsDocTag[]): InheritDocTarget | undefined {
	const tag = tags.find((t) => t.tag.toLowerCase() === "inheritdoc");
	if (!tag?.text) {
		return undefined;
	}
	const m = /^([\w.]+)#(\w+)$/.exec(tag.text);
	return m ? { owner: m[1], name: m[2] } : undefined;
}

export function hasOverrideTag(tags: ParsedJsDocTag[]): boolean {
	return tags.some((t) => OVERRIDE_TAGS.has(t.tag.toLowerCase()));
}

/** Tags worth showing verbatim once `@inheritdoc`/`@override` have already
 * been folded into their own styled lines. */
export function otherTags(tags: ParsedJsDocTag[]): ParsedJsDocTag[] {
	return tags.filter((t) => {
		const lower = t.tag.toLowerCase();
		return lower !== "inheritdoc" && !OVERRIDE_TAGS.has(lower);
	});
}

export interface ResolvedJsDoc {
	/** Best available description - the member's own, or (when its comment
	 * is only an `@inheritdoc` pointer) the nearest ancestor's. */
	description?: string;
	/** True when the *original* comment carried `@override`/`@overriden`/
	 * `@overridden`. */
	overridden: boolean;
	/** `Owner#member` hops actually walked while resolving `@inheritdoc`, in
	 * order; empty when the comment had no `@inheritdoc` pointer. */
	chain: string[];
	/** Last `Owner#member` in the chain that couldn't be found in the index,
	 * when resolution dead-ends before reaching a real description. */
	unresolved?: string;
	/** Hit the resolution depth cap or a repeat hop (cycle) before finding a
	 * description. */
	truncated?: boolean;
	/** Remaining tags (`@param`, `@deprecated`, team-specific ones, ...). */
	extraTags: ParsedJsDocTag[];
	/** The real base implementation this member shadows, found by walking
	 * the schema's actual mixin/inheritance chain (`SymbolIndex.
	 * findOverriddenMember`) rather than parsing an explicit `@inheritdoc
	 * Owner#member` pointer out of the text - real schemas overwhelmingly
	 * write a bare `@override`/`@overriden` with their *own* description,
	 * not a pointer, so this is what actually answers "what does @override
	 * override" in practice. Populated by the caller (`HoverProvider`,
	 * which has the file/member context this module doesn't), not by
	 * `SymbolIndex.resolveJsDoc` itself. */
	base?: {
		owner: string;
		description?: string;
	};
}

/** Markdown paragraphs - one array entry per paragraph, join with a blank
 * line between each (`markdownHover`'s own `\n\n`-join convention) - for a
 * `ResolvedJsDoc`. Kept separate from `SymbolIndex.resolveJsDoc` so it stays
 * pure/vscode-free. */
export function formatResolvedJsDoc(resolved: ResolvedJsDoc | undefined): string[] {
	if (!resolved) {
		return [];
	}
	const lines: string[] = [];
	if (resolved.description) {
		lines.push(resolved.description);
	}
	if (resolved.chain.length) {
		const chainPath = resolved.chain.map((hop) => `\`${hop}\``).join(" → ");
		if (resolved.description) {
			lines.push(`*Комментарий унаследован от* ${chainPath}`);
		} else if (resolved.unresolved) {
			lines.push(`*@inheritdoc: не удалось найти* \`${resolved.unresolved}\``);
		} else if (resolved.truncated) {
			lines.push(`*@inheritdoc: цепочка наследования слишком длинная -* ${chainPath}`);
		} else {
			lines.push(`*@inheritdoc:* ${chainPath} *(без описания)*`);
		}
	}
	if (resolved.base) {
		lines.push(`**Переопределяет** \`${resolved.base.owner}\``);
		if (resolved.base.description) {
			lines.push(resolved.base.description);
		}
	} else if (resolved.overridden) {
		lines.push(
			resolved.chain.length
				? `**Переопределяет** \`${resolved.chain[0]}\``
				: "**Переопределяет** родительскую реализацию"
		);
	}
	for (const tag of resolved.extraTags) {
		lines.push(tag.text ? `**@${tag.tag}** ${tag.text}` : `**@${tag.tag}**`);
	}
	return lines;
}
