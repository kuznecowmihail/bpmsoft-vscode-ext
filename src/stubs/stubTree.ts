import { PlatformStubMember } from "../index/types";

export function cloneStub(s: PlatformStubMember): PlatformStubMember {
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

function stubByName(items: PlatformStubMember[]): Map<string, PlatformStubMember> {
	const map = new Map<string, PlatformStubMember>();
	for (const child of items) {
		map.set(child.name, child);
	}
	return map;
}

/** Existing name wins; incoming children/metadata fill gaps. */
export function mergeStubDeep(
	existing: PlatformStubMember[],
	incoming: PlatformStubMember[]
): PlatformStubMember[] {
	const map = stubByName(existing);
	for (const child of incoming) {
		const prev = map.get(child.name);
		if (!prev) {
			map.set(child.name, child);
			continue;
		}
		if (child.children?.length) {
			prev.children = mergeStubDeep(prev.children || [], child.children);
		}
		prev.kind = prev.kind || child.kind;
		prev.detail = prev.detail || child.detail;
		prev.documentation = prev.documentation || child.documentation;
		prev.filePath = prev.filePath || child.filePath;
		prev.position = prev.position || child.position;
	}
	return Array.from(map.values());
}

/** First name wins; later duplicates ignored. */
export function mergeStubFirstWins(
	existing: PlatformStubMember[],
	incoming: PlatformStubMember[]
): PlatformStubMember[] {
	const map = stubByName(existing);
	for (const child of incoming) {
		if (!map.has(child.name)) {
			map.set(child.name, child);
		}
	}
	return Array.from(map.values());
}
