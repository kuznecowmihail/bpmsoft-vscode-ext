import * as fs from "fs";
import * as path from "path";
import { DevDotnetProject } from "../index/workspaceLayout";

/** SDK-style C# project type GUID */
const SLN_PROJECT_TYPE = "{9A19103F-16F7-4668-BE54-9A1E7A4F7556}";
const SLN_PROJECT_GUID = "{BB7DCC7F-FBFC-4FCA-90EC-27F2264DD667}";

export const DEV_SLN_NAME = "BPMSoft.Configuration.Dev.sln";

/** Minimal .sln that C# Dev Kit / OmniSharp will load. */
export function formatDevDotnetSln(csprojFileName: string): string {
	const projectName = csprojFileName.replace(/\.csproj$/i, "");
	const lines = [
		"",
		"Microsoft Visual Studio Solution File, Format Version 12.00",
		"# Visual Studio Version 17",
		`Project("${SLN_PROJECT_TYPE}") = "${projectName}", "${csprojFileName}", "${SLN_PROJECT_GUID}"`,
		"EndProject",
		"Global",
		"	GlobalSection(SolutionConfigurationPlatforms) = preSolution",
		"		Debug|Any CPU = Debug|Any CPU",
		"		Release|Any CPU = Release|Any CPU",
		"	EndGlobalSection",
		"	GlobalSection(ProjectConfigurationPlatforms) = postSolution",
		`		${SLN_PROJECT_GUID}.Debug|Any CPU.ActiveCfg = Debug|Any CPU`,
		`		${SLN_PROJECT_GUID}.Debug|Any CPU.Build.0 = Debug|Any CPU`,
		`		${SLN_PROJECT_GUID}.Release|Any CPU.ActiveCfg = Release|Any CPU`,
		`		${SLN_PROJECT_GUID}.Release|Any CPU.Build.0 = Release|Any CPU`,
		"	EndGlobalSection",
		"EndGlobal"
	];
	return `\uFEFF${lines.join("\r\n")}\r\n`;
}

/**
 * C# language service needs a .sln. If Dev.sln is missing, write a
 * one-project solution next to the csproj and return that path.
 */
export function ensureDevDotnetSln(project: DevDotnetProject): string {
	const slnPath =
		project.slnPath || path.join(project.configurationRoot, DEV_SLN_NAME);
	if (fs.existsSync(slnPath)) {
		return slnPath;
	}
	fs.writeFileSync(
		slnPath,
		formatDevDotnetSln(path.basename(project.csprojPath))
	);
	return slnPath;
}
