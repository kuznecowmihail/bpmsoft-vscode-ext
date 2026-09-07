import { execFile } from "child_process";

export interface GitFlowIssue {
	message: string;
}

export interface GitFlowSettings {
	mainBranch: string;
	developBranch: string;
	/** Heuristic (merge-base based), can false-positive on complex/rebased
	 * history — kept as its own toggle so it can be turned off independently
	 * of the cheap, reliable checks. */
	checkBranchParent: boolean;
}

type BranchKind = "main" | "develop" | "sprint" | "release" | "feature" | "bugfix";

const SPRINT_RE = /^sprint\/\d+\.\d+\.\d+$/;
const RELEASE_RE = /^release\/\d+\.\d+\.\d+$/;
const FEATURE_RE = /^feature\/.+$/;
const BUGFIX_RE = /^bugfix\/.+$/;

function git(args: string[], cwd: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("git", args, { cwd }, (error, stdout) => {
			resolve(error ? undefined : stdout.trim());
		});
	});
}

export function getCurrentBranch(gitRoot: string): Promise<string | undefined> {
	return git(["rev-parse", "--abbrev-ref", "HEAD"], gitRoot).then((branch) =>
		// Detached HEAD reports literally "HEAD" — nothing meaningful to check.
		branch && branch !== "HEAD" ? branch : undefined
	);
}

function branchKind(branch: string, settings: GitFlowSettings): BranchKind | undefined {
	if (branch === settings.mainBranch) {
		return "main";
	}
	if (branch === settings.developBranch) {
		return "develop";
	}
	if (SPRINT_RE.test(branch)) {
		return "sprint";
	}
	if (RELEASE_RE.test(branch)) {
		return "release";
	}
	if (FEATURE_RE.test(branch)) {
		return "feature";
	}
	if (BUGFIX_RE.test(branch)) {
		return "bugfix";
	}
	return undefined;
}

async function refExists(gitRoot: string, ref: string): Promise<boolean> {
	return (await git(["rev-parse", "--verify", "--quiet", ref], gitRoot)) !== undefined;
}

/** A dev's checkout very often has `develop`/`main`/`sprint/x.x.x` only as
 * `origin/<name>` remote-tracking refs, not local branches — confirmed
 * against a real repo (`lavka`'s own `Pkg`: `develop` exists only as
 * `remotes/origin/develop`). Resolves to whichever form actually exists,
 * local first. */
async function resolveRef(gitRoot: string, name: string): Promise<string | undefined> {
	if (await refExists(gitRoot, name)) {
		return name;
	}
	const remote = `origin/${name}`;
	return (await refExists(gitRoot, remote)) ? remote : undefined;
}

/** Same local-or-remote-tracking fallback as `resolveRef`, but for a whole
 * name pattern (sprint/*, release/*) rather than one fixed name — used to
 * find candidate parent branches for the feature/bugfix check. Local and
 * remote copies of the same branch are deduplicated by name, local
 * preferred. */
async function listBranchesMatching(gitRoot: string, pattern: RegExp): Promise<string[]> {
	const [localOut, remoteOut] = await Promise.all([
		git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"], gitRoot),
		git(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/"], gitRoot)
	]);
	const local = (localOut || "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const remoteNames = (remoteOut || "")
		.split("\n")
		.map((line) => line.trim())
		.filter((name) => name && name !== "origin/HEAD")
		.map((name) => name.replace(/^origin\//, ""));

	const seen = new Set<string>();
	const result: string[] = [];
	for (const name of [...local, ...remoteNames]) {
		if (!pattern.test(name) || seen.has(name)) {
			continue;
		}
		seen.add(name);
		result.push(local.includes(name) ? name : `origin/${name}`);
	}
	return result;
}

/** True when `branch`'s history includes commits from `candidate` that
 * aren't reachable from `developBranch` — i.e. `branch` looks like it was
 * created from (or later incorporated) `candidate`, not branched directly
 * off develop. This is the closest a post-hoc git-history read can get to
 * "was this feature/bugfix branch created from the right parent" — it
 * can't see intent, only shared history, so a branch created correctly but
 * never rebased/updated from its parent can still read as unrelated. */
async function sharesHistoryBeyondDevelop(
	gitRoot: string,
	branch: string,
	candidate: string,
	developBranch: string
): Promise<boolean> {
	const [baseDevelop, baseCandidate] = await Promise.all([
		git(["merge-base", branch, developBranch], gitRoot),
		git(["merge-base", branch, candidate], gitRoot)
	]);
	if (!baseDevelop || !baseCandidate || baseCandidate === baseDevelop) {
		return false;
	}
	const isAncestor = await git(["merge-base", "--is-ancestor", baseDevelop, baseCandidate], gitRoot);
	// `--is-ancestor` has no stdout either way — success (exit 0) is what
	// we're after, and the `git()` helper already collapses a non-zero exit
	// to `undefined`, so a defined (empty-string) result means "yes".
	return isAncestor !== undefined;
}

/**
 * Best-effort Git Flow conformance check for the branch's own commit graph
 * (see CLAUDE.md's Git Flow model — main/develop/sprint/release/feature/
 * bugfix). Deliberately scoped to what a post-hoc read of git history can
 * actually answer:
 * - branch naming (cheap, reliable)
 * - `main` never carries commits `develop` doesn't have — the model only
 *   ever merges develop → main, never the reverse, so any such commit means
 *   something was pushed to main outside the flow (reliable, as long as
 *   both branches exist locally)
 * - feature/* branched from a sprint/* branch, bugfix/* from a release/*
 *   branch, rather than straight off develop/main (heuristic, see
 *   `sharesHistoryBeyondDevelop`)
 * What it can't check: whether the documented step *order* was followed
 * (e.g. sprint merged to develop before release was cut) — that's not
 * recoverable from history alone, and rebasing can rewrite it entirely.
 */
export async function checkGitFlow(gitRoot: string, settings: GitFlowSettings): Promise<GitFlowIssue[]> {
	const issues: GitFlowIssue[] = [];
	const branch = await getCurrentBranch(gitRoot);
	if (!branch) {
		return issues;
	}

	const kind = branchKind(branch, settings);
	if (!kind) {
		issues.push({ message: `Branch name incorrect: ${branch}` });
	}

	const [mainRef, developRef] = await Promise.all([
		resolveRef(gitRoot, settings.mainBranch),
		resolveRef(gitRoot, settings.developBranch)
	]);

	if (mainRef && developRef) {
		// `--no-merges` matters here, confirmed against a real repo: an
		// ordinary "merge develop into main" merge commit only ever exists
		// on `main` (it's *created* there), so a plain `develop..main` count
		// picks up one such commit per historical release and never settles
		// at zero even when the flow was followed perfectly (34 vs. 3 on a
		// real repo checked while building this). Excluding merges leaves
		// only commits that genuinely originated on `main` and were never
		// propagated back — the real "someone bypassed the flow" signal.
		const aheadCount = await git(
			["rev-list", "--count", "--no-merges", `${developRef}..${mainRef}`],
			gitRoot
		);
		if (aheadCount && Number(aheadCount) > 0) {
			issues.push({
				message: `${settings.mainBranch} has ${aheadCount} commit(s) not present in ${settings.developBranch}`
			});
		}
	}

	if (settings.checkBranchParent && developRef && (kind === "feature" || kind === "bugfix")) {
		const candidatePattern = kind === "feature" ? SPRINT_RE : RELEASE_RE;
		const candidates = await listBranchesMatching(gitRoot, candidatePattern);
		let foundParent = false;
		for (const candidate of candidates) {
			if (await sharesHistoryBeyondDevelop(gitRoot, branch, candidate, developRef)) {
				foundParent = true;
				break;
			}
		}
		if (candidates.length > 0 && !foundParent) {
			const parentKind = kind === "feature" ? "sprint" : "release";
			issues.push({
				message: `Branch ${branch} does not appear to be based on a ${parentKind}/* branch`
			});
		}
	}

	return issues;
}
