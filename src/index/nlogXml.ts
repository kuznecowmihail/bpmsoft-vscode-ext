/**
 * Minimal positional XML tokenizer for `nlog.config`/`nlog.targets.config`
 * editing (`nlogConfigEditor.ts`). Deliberately not a spec-complete XML
 * parser (no DTD, no real namespace resolution, no CDATA-in-text handling
 * beyond treating it as opaque) — it only needs to do one thing precisely:
 * find the exact character span of each top-level child of a container
 * element (`<targets>`, `<rules>`, `<extensions>`, or `<nlog>` itself for
 * `<variable>`), so an edit can splice just that span and leave the rest of
 * the file byte-for-byte untouched — the same principle `dotnetConfigEditor.ts`
 * and `localizationEditor.ts` already apply at line granularity, extended
 * here to handle genuinely nested elements (a `wrapper-target` containing its
 * own `<target>`, which line-based scanning can't tell apart from a sibling).
 *
 * A commented-out element (`<!-- <target .../> -->`, real and common in
 * BPMSoft's own `nlog.targets.config` — vendor-provided disabled examples for
 * Loki/Syslog/RabbitMQ/Kafka/ElasticSearch/Database) is recognized as the
 * same logical item with `enabled: false`, so the wizard can offer an
 * Enable/Disable toggle instead of only add/delete.
 */

export interface XmlAttr {
	name: string;
	value: string;
}

export interface XmlItem {
	/** Tag name, e.g. "target", "wrapper-target", "logger", "variable", "add". */
	tag: string;
	attrs: XmlAttr[];
	/** false when this item is the sole content of an XML comment. */
	enabled: boolean;
	/** [start, end) offset into the original text of this item's full span —
	 * for an enabled item, the element itself; for a disabled one, the whole
	 * `<!-- ... -->` comment. */
	span: [number, number];
	/** The exact source text of `span` — the element (or commented element)
	 * verbatim, for a "view/edit as raw XML" UI. */
	raw: string;
}

export function escapeXmlAttr(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

export function unescapeXmlAttr(value: string): string {
	return value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

/** Scans forward from `start` for the `>` that closes the current tag,
 * skipping over `>` characters that appear inside a quoted attribute value
 * (technically legal in XML attribute values, so a naive `indexOf(">")`
 * would truncate a tag early on real-world content). Returns the index of
 * that `>`, or -1 if the tag never closes. */
function findTagEnd(text: string, start: number): number {
	let quote: string | undefined;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === quote) {
				quote = undefined;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
		} else if (ch === ">") {
			return i;
		}
	}
	return -1;
}

const TAG_OPEN_RE = /<([A-Za-z_][\w.:-]*)/y;
const ATTR_RE_SOURCE = "\\s*([A-Za-z_][\\w.:-]*)\\s*=\\s*(\"([^\"]*)\"|'([^']*)')";

/** Parses attributes out of `attrRegion` — the exact substring between the
 * tag name and the tag's closing `>` (or `/>`), never a larger surrounding
 * text. A shared/global regex here would keep matching `name="value"`-shaped
 * text arbitrarily far past the actual tag if not bounded this way. */
function parseAttrs(attrRegion: string): XmlAttr[] {
	const attrs: XmlAttr[] = [];
	const re = new RegExp(ATTR_RE_SOURCE, "g");
	let m: RegExpExecArray | null;
	while ((m = re.exec(attrRegion))) {
		attrs.push({ name: m[1], value: unescapeXmlAttr(m[3] !== undefined ? m[3] : m[4]) });
	}
	return attrs;
}

/**
 * Finds `<containerTag>...</containerTag>` (must be a real open/close pair,
 * not self-closing) and returns the offsets of its inner content. `fromIndex`
 * lets a caller search past an earlier, unrelated same-named tag (not needed
 * for nlog.config's own shape, but cheap safety).
 */
export function findContainerSpan(text: string, containerTag: string, fromIndex = 0): [number, number] | undefined {
	const openRe = new RegExp(`<${containerTag}\\b`, "g");
	openRe.lastIndex = fromIndex;
	const m = openRe.exec(text);
	if (!m) {
		return undefined;
	}
	const tagEnd = findTagEnd(text, m.index);
	if (tagEnd < 0 || text[tagEnd - 1] === "/") {
		return undefined;
	}
	const closeIdx = findMatchingClose(text, containerTag, tagEnd + 1);
	if (closeIdx === undefined) {
		return undefined;
	}
	return [tagEnd + 1, closeIdx.contentEnd];
}

/** Depth-aware search for the `</tag>` that matches the opening tag whose
 * content starts at `contentStart` — needed because the same tag name can
 * nest (a `wrapper-target` containing another `target`, or in principle a
 * `<targets>` block containing a same-named child, though that doesn't occur
 * in practice). Also tracks *any* nested element (not just same-named ones)
 * so a foreign `>` inside a sibling's attribute values never confuses depth. */
function findMatchingClose(
	text: string,
	tag: string,
	contentStart: number
): { contentEnd: number } | undefined {
	let depth = 1;
	let i = contentStart;
	while (i < text.length) {
		const lt = text.indexOf("<", i);
		if (lt < 0) {
			return undefined;
		}
		if (text.startsWith("<!--", lt)) {
			const end = text.indexOf("-->", lt + 4);
			if (end < 0) {
				return undefined;
			}
			i = end + 3;
			continue;
		}
		if (text.startsWith("</", lt)) {
			const nameMatch = /^<\/([A-Za-z_][\w.:-]*)\s*>/.exec(text.slice(lt));
			if (!nameMatch) {
				i = lt + 2;
				continue;
			}
			if (nameMatch[1] === tag) {
				depth--;
				if (depth === 0) {
					return { contentEnd: lt };
				}
			}
			i = lt + nameMatch[0].length;
			continue;
		}
		// Opening or self-closing tag of any name.
		TAG_OPEN_RE.lastIndex = lt;
		const nameMatch = TAG_OPEN_RE.exec(text);
		if (!nameMatch || nameMatch.index !== lt) {
			i = lt + 1;
			continue;
		}
		const tagEnd = findTagEnd(text, lt);
		if (tagEnd < 0) {
			return undefined;
		}
		const selfClosing = text[tagEnd - 1] === "/";
		if (!selfClosing && nameMatch[1] === tag) {
			depth++;
		}
		i = tagEnd + 1;
	}
	return undefined;
}

/**
 * Lists the immediate children of `[containerStart, containerEnd)` as
 * `XmlItem`s — only tags matching `itemTags` count as items; anything else
 * (text/whitespace, unrelated elements) is skipped. A `<!-- ... -->` comment
 * whose trimmed content starts with `<` and names one of `itemTags` is
 * reported as that item with `enabled: false`.
 */
export function listTopLevelItems(text: string, [containerStart, containerEnd]: [number, number], itemTags: string[]): XmlItem[] {
	const items: XmlItem[] = [];
	let i = containerStart;
	while (i < containerEnd) {
		const lt = text.indexOf("<", i);
		if (lt < 0 || lt >= containerEnd) {
			break;
		}
		if (text.startsWith("<!--", lt)) {
			const end = text.indexOf("-->", lt + 4);
			if (end < 0 || end > containerEnd) {
				break;
			}
			const commentBody = text.slice(lt + 4, end).trim();
			const parsed = tryParseSingleElementLenient(commentBody);
			if (parsed && itemTags.includes(parsed.tag)) {
				items.push({ tag: parsed.tag, attrs: parsed.attrs, enabled: false, span: [lt, end + 3], raw: text.slice(lt, end + 3) });
			}
			i = end + 3;
			continue;
		}
		TAG_OPEN_RE.lastIndex = lt;
		const nameMatch = TAG_OPEN_RE.exec(text);
		if (!nameMatch || nameMatch.index !== lt) {
			i = lt + 1;
			continue;
		}
		const tag = nameMatch[1];
		const tagEnd = findTagEnd(text, lt);
		if (tagEnd < 0) {
			break;
		}
		const selfClosing = text[tagEnd - 1] === "/";
		if (selfClosing) {
			if (itemTags.includes(tag)) {
				items.push({
					tag,
					attrs: parseAttrs(text.slice(lt + nameMatch[0].length, tagEnd)),
					enabled: true,
					span: [lt, tagEnd + 1],
					raw: text.slice(lt, tagEnd + 1)
				});
			}
			i = tagEnd + 1;
			continue;
		}
		const closed = findMatchingClose(text, tag, tagEnd + 1);
		const end = closed ? closed.contentEnd + `</${tag}>`.length : tagEnd + 1;
		if (itemTags.includes(tag)) {
			items.push({
				tag,
				attrs: parseAttrs(text.slice(lt + nameMatch[0].length, tagEnd)),
				enabled: true,
				span: [lt, end],
				raw: text.slice(lt, end)
			});
		}
		i = end;
	}
	return items;
}

/** Parses `fragment` as exactly one XML element (optionally with children —
 * children aren't inspected, only that the outer tag is well-formed and
 * fully closes within the fragment). Used to validate a user-typed/edited
 * raw XML fragment before writing it. Comments/whitespace before or after
 * the element are tolerated. */
export function tryParseSingleElement(fragment: string): { tag: string; attrs: XmlAttr[] } | undefined {
	const trimmed = fragment.trim();
	const lt = trimmed.indexOf("<");
	if (lt !== 0) {
		return undefined;
	}
	TAG_OPEN_RE.lastIndex = 0;
	const nameMatch = TAG_OPEN_RE.exec(trimmed);
	if (!nameMatch || nameMatch.index !== 0) {
		return undefined;
	}
	const tag = nameMatch[1];
	const tagEnd = findTagEnd(trimmed, 0);
	if (tagEnd < 0) {
		return undefined;
	}
	const attrs = parseAttrs(trimmed.slice(nameMatch[0].length, tagEnd));
	if (trimmed[tagEnd - 1] === "/") {
		return trimmed.length === tagEnd + 1 ? { tag, attrs } : undefined;
	}
	const closed = findMatchingClose(trimmed, tag, tagEnd + 1);
	if (!closed) {
		return undefined;
	}
	const expectedEnd = closed.contentEnd + `</${tag}>`.length;
	return trimmed.length === expectedEnd ? { tag, attrs } : undefined;
}

/** Same as `tryParseSingleElement` but also accepts a fragment with trailing
 * content after the element (used for comment-body sniffing, where the
 * comment might carry more than just the element in principle — real samples
 * never do, but this keeps the check honest rather than assuming). */
function tryParseSingleElementLenient(fragment: string): { tag: string; attrs: XmlAttr[] } | undefined {
	const trimmed = fragment.trim();
	if (!trimmed.startsWith("<")) {
		return undefined;
	}
	TAG_OPEN_RE.lastIndex = 0;
	const nameMatch = TAG_OPEN_RE.exec(trimmed);
	if (!nameMatch || nameMatch.index !== 0) {
		return undefined;
	}
	const tag = nameMatch[1];
	const tagEnd = findTagEnd(trimmed, 0);
	if (tagEnd < 0) {
		return undefined;
	}
	const attrs = parseAttrs(trimmed.slice(nameMatch[0].length, tagEnd));
	return { tag, attrs };
}

export function spliceSpan(text: string, [start, end]: [number, number], replacement: string): string {
	return text.slice(0, start) + replacement + text.slice(end);
}

/** Sets (or inserts) an attribute on the OUTER element's own opening tag of
 * `fragment` only — never touches a same-named attribute belonging to a
 * nested child (e.g. a Database target's own `name=` vs. its child
 * `<parameter name="..."/>` elements). `fragment` must already be a single
 * well-formed element starting at index 0 (as validated by
 * `tryParseSingleElement`). Used for "duplicate target" (rewrite just the
 * outer `name`) without disturbing any nested content. */
export function setRootAttr(fragment: string, attrName: string, newValue: string): string {
	const tagEnd = findTagEnd(fragment, 0);
	if (tagEnd < 0) {
		return fragment;
	}
	const openTag = fragment.slice(0, tagEnd);
	const rest = fragment.slice(tagEnd);
	const attrRe = new RegExp(`(\\s${attrName}\\s*=\\s*)("[^"]*"|'[^']*')`);
	if (attrRe.test(openTag)) {
		return openTag.replace(attrRe, `$1"${escapeXmlAttr(newValue)}"`) + rest;
	}
	TAG_OPEN_RE.lastIndex = 0;
	const nameMatch = TAG_OPEN_RE.exec(openTag);
	const insertPos = nameMatch ? nameMatch[0].length : 0;
	return openTag.slice(0, insertPos) + ` ${attrName}="${escapeXmlAttr(newValue)}"` + openTag.slice(insertPos) + rest;
}

export function attrValue(attrs: XmlAttr[], name: string): string | undefined {
	return attrs.find((a) => a.name === name)?.value;
}
