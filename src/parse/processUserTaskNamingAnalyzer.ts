import { hasTechnicalAffix, stripPrefix } from "./entityNamingAnalyzer";
import { pascalCaseSegments } from "./namingCommon";

export interface NamingIssue {
	message: string;
}

export interface ProcessUserTaskNamingSettings {
	/** Same `bpmsoft.namingPrefixes` used everywhere else. */
	prefixes: string[];
	/** Curated whitelist (not a morphology heuristic — English has no
	 * reliable ending marker for "this is a verb" the way Russian infinitives
	 * do) of verbs a UserTask's own code is expected to start with, e.g.
	 * `GoChangeDataUserTask` → "Change". Configurable via
	 * `bpmsoft.processUserTask.actionVerbs`. */
	actionVerbs: string[];
	/** naming-guidelines.md §8's "Input"/"Output" parameter-suffix
	 * recommendation is real but, confirmed against 176 real parameters
	 * across two installs, has 0% adoption in existing code — enforcing it
	 * flags nearly every multi-parameter UserTask. Off unless explicitly
	 * turned on (`bpmsoft.processUserTask.checkParameterDirectionSuffix`). */
	checkParameterDirectionSuffix: boolean;
}

/**
 * Checks a `ProcessUserTaskSchemaManager` schema's own Code against
 * naming-guidelines.md §8 — PascalCase, English-only, team prefix, the
 * mandatory `UserTask` suffix, and a verb-first business name. Doesn't check
 * the Title (see `checkProcessUserTaskCaptionCoverage`).
 */
export function checkProcessUserTaskCodeNaming(
	name: string,
	settings: ProcessUserTaskNamingSettings
): NamingIssue[] {
	const issues: NamingIssue[] = [];
	if (!/^[A-Za-z0-9]+$/.test(name)) {
		issues.push({ message: `UserTask "${name}": code must contain only English letters and digits` });
	} else if (!/^[A-Z]/.test(name)) {
		issues.push({ message: `UserTask "${name}": code must be PascalCase` });
	}
	if (settings.prefixes.length && !settings.prefixes.some((p) => name.startsWith(p))) {
		issues.push({ message: `UserTask "${name}": expected prefix (${settings.prefixes.join("/")})` });
	}
	if (!name.endsWith("UserTask")) {
		issues.push({ message: `UserTask "${name}": code must end with the suffix "UserTask"` });
	}
	if (settings.actionVerbs.length) {
		const businessName = stripPrefix(name, settings.prefixes);
		const firstSegment = pascalCaseSegments(businessName)[0];
		if (firstSegment && !settings.actionVerbs.includes(firstSegment)) {
			issues.push({
				message: `UserTask "${name}": code should start with a verb reflecting its purpose (configured: ${settings.actionVerbs.join("/")})`
			});
		}
	}
	return issues;
}

/** UserTask has (or is missing) its own ru-RU/en-US `Caption` — same
 * mechanism as a Process's own Title. */
export function checkProcessUserTaskCaptionCoverage(
	name: string,
	hasRuCaption: boolean,
	hasEnCaption: boolean
): NamingIssue[] {
	const issues: NamingIssue[] = [];
	if (!hasRuCaption) {
		issues.push({ message: `UserTask "${name}": missing a Russian title (ru-RU Caption)` });
	}
	if (!hasEnCaption) {
		issues.push({ message: `UserTask "${name}": missing an English title (en-US Caption)` });
	}
	return issues;
}

/** Checks one parameter's own Code — no technical affix (`Tbl`/`Entity`/
 * `Field`, same list as an Object's columns). The Input/Output suffix
 * recommendation is checked separately, at the whole-schema level (see
 * `checkProcessUserTaskParameterDirectionSuffix`) since it only makes sense
 * to ask "does *any* parameter here indicate direction", not per-parameter. */
export function checkProcessUserTaskParameterNaming(parameterName: string): NamingIssue[] {
	const issues: NamingIssue[] = [];
	const affix = hasTechnicalAffix(parameterName);
	if (affix) {
		issues.push({ message: `Parameter "${parameterName}": avoid the technical affix "${affix}"` });
	}
	return issues;
}

/**
 * naming-guidelines.md §8: "хорошая практика — указывать направление в
 * коде, если параметров несколько" (Input/Output suffix). One finding for
 * the whole schema, not per-parameter — the recommendation is about the
 * parameter *set* having no direction markers at all, not about any single
 * parameter's own name. Off by default (`settings.checkParameterDirectionSuffix`)
 * — see that field's own doc for why.
 */
export function checkProcessUserTaskParameterDirectionSuffix(
	parameterNames: string[],
	settings: ProcessUserTaskNamingSettings
): NamingIssue[] {
	if (!settings.checkParameterDirectionSuffix || parameterNames.length <= 1) {
		return [];
	}
	const hasAnyDirectionSuffix = parameterNames.some((name) => /(Input|Output)$/.test(name));
	if (hasAnyDirectionSuffix) {
		return [];
	}
	return [
		{
			message: `UserTask has ${parameterNames.length} parameters, none named with an Input/Output suffix — recommended when there's more than one, to indicate direction`
		}
	];
}
