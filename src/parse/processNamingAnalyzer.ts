import { ProcessElementCategory } from "./processElementsMetadata";

export interface NamingIssue {
	message: string;
}

export interface ProcessNamingSettings {
	/** Same `bpmsoft.namingPrefixes` used everywhere else — the guideline
	 * treats the process code prefix as the same team/stream convention. */
	prefixes: string[];
}

const TEMP_DESIGNATION_WORDS = ["New", "Test", "Temp", "Copy"];

/** Splits a PascalCase code into its capitalized segments (`"NauApprovalProcessV2"`
 * → `["Nau", "Approval", "Process", "V2"]`) — digits after the capital are
 * kept with it so a trailing `"V2"`-style version marker comes out as one
 * segment, not split into `"V"` + `"2"`. */
function pascalCaseSegments(name: string): string[] {
	return name.match(/[A-Z][a-z0-9]*/g) || [name];
}

function findTemporaryDesignationSegment(name: string): string | undefined {
	return pascalCaseSegments(name).find(
		(segment) => TEMP_DESIGNATION_WORDS.includes(segment) || /^V\d+$/.test(segment)
	);
}

const TEMP_WORD_RE = /\b(New|Test|Temp|Copy|V\d+)\b/;

function findTemporaryDesignationWord(text: string): string | undefined {
	return TEMP_WORD_RE.exec(text)?.[1];
}

/**
 * Checks a process's own Code against naming-guidelines.md §7 — PascalCase,
 * English-only, team prefix, the mandatory `Process` suffix, and no temporary
 * designation (`New`/`Test`/`Temp`/`Copy`/`V2`, …) baked into the code.
 * Doesn't check the Title (see `checkProcessCaptionCoverage`).
 */
export function checkProcessCodeNaming(name: string, settings: ProcessNamingSettings): NamingIssue[] {
	const issues: NamingIssue[] = [];
	if (!/^[A-Za-z0-9]+$/.test(name)) {
		issues.push({ message: `Process "${name}": code must contain only English letters and digits` });
	} else if (!/^[A-Z]/.test(name)) {
		issues.push({ message: `Process "${name}": code must be PascalCase` });
	}
	if (settings.prefixes.length && !settings.prefixes.some((p) => name.startsWith(p))) {
		issues.push({ message: `Process "${name}": expected prefix (${settings.prefixes.join("/")})` });
	}
	if (!name.endsWith("Process")) {
		issues.push({ message: `Process "${name}": code must end with the suffix "Process"` });
	}
	const tempSegment = findTemporaryDesignationSegment(name);
	if (tempSegment) {
		issues.push({ message: `Process "${name}": avoid the temporary designation "${tempSegment}" in the code` });
	}
	return issues;
}

/** Process has (or is missing) its own ru-RU/en-US `Caption` — same
 * mechanism as an Object's Title (`checkEntityCaptionCoverage`), just under
 * `Resources/{Process}.Process/resource.{culture}.xml` instead of
 * `.../{Entity}.Entity/...`. */
export function checkProcessCaptionCoverage(
	name: string,
	hasRuCaption: boolean,
	hasEnCaption: boolean
): NamingIssue[] {
	const issues: NamingIssue[] = [];
	if (!hasRuCaption) {
		issues.push({ message: `Process "${name}": missing a Russian title (ru-RU Caption)` });
	}
	if (!hasEnCaption) {
		issues.push({ message: `Process "${name}": missing an English title (en-US Caption)` });
	}
	return issues;
}

function stripPunctuation(word: string): string {
	return word.replace(/["'«»().,;:!?]/g, "");
}

// Weak heuristics, deliberately — real Russian morphology needs a proper
// dictionary/analyzer (pymorphy2-class), which this codebase doesn't have.
// Verified against ~1150-1650 real Action/Event titles per install before
// picking these endings; still flags plenty of legitimate titles the wrong
// word order or an unlisted ending trips up. Accepted as noisy-but-useful,
// same call as the SQL script pattern check.
const INFINITIVE_ENDING_RE = /(ться|тись|чься|ть|ти|чь)$/i;
const PAST_PASSIVE_ENDING_RE = /(ен|ена|ено|ены|ан|ана|ано|аны|та|то|ты)$/i;

function startsWithInfinitiveVerb(caption: string): boolean {
	const firstWord = stripPunctuation(caption.trim().split(/\s+/)[0] || "");
	return INFINITIVE_ENDING_RE.test(firstWord);
}

/** Guideline's own examples are "object + past-tense verb" (verb last:
 * "Заявка зарегистрирована"), but real captions often invert that
 * ("Создана активность...") — checking both the first and last word cuts
 * down on that specific false-positive source. */
function looksLikePastTenseFact(caption: string): boolean {
	const words = caption.trim().split(/\s+/).map(stripPunctuation);
	const first = words[0] || "";
	const last = words[words.length - 1] || "";
	return PAST_PASSIVE_ENDING_RE.test(first) || PAST_PASSIVE_ENDING_RE.test(last);
}

export interface ProcessElementNamingInput {
	/** `A2` technical id — only used to identify the element in a message
	 * when it has no caption at all. */
	name: string;
	category: ProcessElementCategory;
	caption?: string;
}

/**
 * Checks one diagram element's title against naming-guidelines.md §7's
 * per-element-type rules. An element with no caption at all is only checked
 * for the flow-shouldn't-be-named rule (nothing else has text to evaluate).
 */
export function checkProcessElementNaming(element: ProcessElementNamingInput): NamingIssue[] {
	const issues: NamingIssue[] = [];
	const caption = element.caption?.trim();

	if (caption) {
		const tempWord = findTemporaryDesignationWord(caption);
		if (tempWord) {
			issues.push({
				message: `Element "${caption}": avoid the temporary designation "${tempWord}" in its title`
			});
		}
	}

	switch (element.category) {
		case "action":
			if (caption && !startsWithInfinitiveVerb(caption)) {
				issues.push({
					message: `Action "${caption}": title should start with a verb, e.g. "Позвонить клиенту"`
				});
			}
			break;
		case "event":
			if (caption && !looksLikePastTenseFact(caption)) {
				issues.push({
					message: `Event "${caption}": title should describe an already-happened fact (object + past-tense verb), e.g. "Договор подписан"`
				});
			}
			break;
		case "gatewayExclusive":
			if (caption && !caption.endsWith("?")) {
				issues.push({
					message: `Exclusive gateway "${caption}": recommended as a closed question, e.g. "Документы заполнены?"`
				});
			}
			break;
		case "flowSequence":
			if (caption) {
				issues.push({
					message: `Sequence flow "${caption}": a flow without a transition condition is normally left unnamed`
				});
			}
			break;
		default:
			break;
	}

	return issues;
}
