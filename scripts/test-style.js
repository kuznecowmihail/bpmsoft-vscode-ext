/* eslint-disable @typescript-eslint/no-var-requires */
// Standalone unit test harness for the style/format analyzers.
// Does NOT require a real BPMSoft install (unlike scripts/run-smoke.js).
// Run: npm run compile && node scripts/test-style.js

const { collectStyleIssues } = require("../out/parse/styleAnalyzer");
const { collectCsharpStyleIssues } = require("../out/parse/csharpStyleAnalyzer");
const { checkClientSchemaNaming } = require("../out/parse/schemaNamingAnalyzer");
const { checkCsharpSchemaNaming } = require("../out/parse/csharpSchemaAnalyzer");
const { checkSqlScriptNaming } = require("../out/parse/sqlNamingAnalyzer");

let passed = 0;
let failed = 0;

function fail(name, detail) {
	failed++;
	console.error(`FAIL ${name}\n  ${detail}`);
}

function pass(name) {
	passed++;
	console.log(`PASS ${name}`);
}

/**
 * @param {string} name
 * @param {"js"|"cs"} lang
 * @param {string} source
 * @param {string[]} expectKinds kinds that MUST appear at least once
 * @param {string[]} [notExpectKinds] kinds that must NOT appear
 */
function runIssueCase(name, lang, source, expectKinds, notExpectKinds) {
	let issues;
	try {
		issues = lang === "cs" ? collectCsharpStyleIssues(source) : collectStyleIssues(source);
	} catch (e) {
		fail(name, `threw: ${e && e.stack || e}`);
		return;
	}
	const kinds = issues.map((i) => i.kind);
	const missing = expectKinds.filter((k) => !kinds.includes(k));
	const unexpected = (notExpectKinds || []).filter((k) => kinds.includes(k));
	if (missing.length || unexpected.length) {
		fail(
			name,
			`got kinds=[${kinds.join(",")}] missing=[${missing.join(",")}] unexpected=[${unexpected.join(",")}]`
		);
		return;
	}
	pass(name);
}

const cases = [
	// --- Item 1: module-level SCREAMING_SNAKE_CASE const must NOT be flagged camelLocal ---
	{
		name: "js: const SCREAMING_SNAKE_CASE module constant is allowed",
		lang: "js",
		source: `
define("GoClientConstants", [], function () {
	const VERSION_NUMBER = "1.0.1";
	return { VERSION_NUMBER: VERSION_NUMBER };
});
`,
		expect: [],
		notExpect: ["camelLocal"]
	},
	{
		name: "js: const camelCase name still fine",
		lang: "js",
		source: `
define("X", [], function () {
	const notConst = 1;
	return notConst;
});
`,
		expect: [],
		notExpect: ["camelLocal"]
	},
	{
		name: "js: let SCREAMING (not const) is still flagged",
		lang: "js",
		source: `
define("X", [], function () {
	let SCREAMING = 1;
	return SCREAMING;
});
`,
		expect: ["camelLocal"],
		notExpect: []
	},
	{
		name: "js: bad lowercase const local is still flagged",
		lang: "js",
		source: `
define("X", [], function () {
	const Bad_Name = 1;
	return Bad_Name;
});
`,
		expect: ["camelLocal"],
		notExpect: []
	},

	// --- regression sanity: existing rules still work ---
	{
		name: "js: var still flagged",
		lang: "js",
		source: `
define("X", [], function () {
	var x = 1;
	return x;
});
`,
		expect: ["varDecl"],
		notExpect: []
	},
	{
		name: "cs: Allman brace violation still flagged",
		lang: "cs",
		source: `
public class Foo {
	public void Bar() {
		var x = 1;
	}
}
`,
		expect: ["allmanBrace"],
		notExpect: []
	},

	// --- Item 2: Id vs ID ---
	{
		name: "js: leadID local flagged as idSuffix, not camelLocal",
		lang: "js",
		source: `
define("X", [], function () {
	let leadID = 1;
	return leadID;
});
`,
		expect: ["idSuffix"],
		notExpect: ["camelLocal"]
	},
	{
		name: "js: apiUrl (no ID suffix) is clean",
		lang: "js",
		source: `
define("X", [], function () {
	let apiUrl = "";
	return apiUrl;
});
`,
		expect: [],
		notExpect: ["idSuffix", "camelLocal"]
	},
	{
		name: "cs: LeadID field flagged as idSuffix",
		lang: "cs",
		source: `
public class Foo
{
	public int LeadID { get; set; }
}
`,
		expect: ["idSuffix"],
		notExpect: ["pascalProperty"]
	},
	{
		name: "cs: private _leadID field flagged as idSuffix",
		lang: "cs",
		source: `
public class Foo
{
	private int _leadID;
}
`,
		expect: ["idSuffix"],
		notExpect: ["privateField"]
	},
	{
		name: "cs: GetByID method flagged as idSuffix",
		lang: "cs",
		source: `
public class Foo
{
	public void GetByID()
	{
	}
}
`,
		expect: ["idSuffix"],
		notExpect: ["pascalMethod"]
	},
	{
		name: "cs: RecordGUID (GUID, not standalone ID) is clean",
		lang: "cs",
		source: `
public class Foo
{
	public int RecordGUID { get; set; }
}
`,
		expect: [],
		notExpect: ["idSuffix"]
	},

	// --- Item 3: [Flags] enum + delegate suffix ---
	{
		name: "cs: [Flags] enum with a non-power-of-two value is flagged",
		lang: "cs",
		source: `
[Flags]
public enum X
{
	None = 0,
	A = 1,
	B = 2,
	C = 3
}
`,
		expect: ["flagsEnumValue"],
		notExpect: []
	},
	{
		name: "cs: [Flags] enum with all powers of two is clean",
		lang: "cs",
		source: `
[Flags]
public enum Y
{
	None = 0,
	A = 1,
	B = 2
}
`,
		expect: [],
		notExpect: ["flagsEnumValue"]
	},
	{
		name: "cs: plain enum (no [Flags]) with sequential values is clean",
		lang: "cs",
		source: `
public enum Z
{
	A,
	B
}
`,
		expect: [],
		notExpect: ["flagsEnumValue"]
	},
	{
		name: "cs: delegate without EventHandler/Callback suffix is flagged",
		lang: "cs",
		source: `
public delegate void FooHandler();
`,
		expect: ["delegateSuffix"],
		notExpect: []
	},
	{
		name: "cs: delegate with EventHandler suffix is clean",
		lang: "cs",
		source: `
public delegate void FooEventHandler(object sender, EventArgs e);
`,
		expect: [],
		notExpect: ["delegateSuffix"]
	},
	{
		name: "cs: delegate with Callback suffix is clean",
		lang: "cs",
		source: `
public delegate int FooCallback();
`,
		expect: [],
		notExpect: ["delegateSuffix"]
	},

	// --- Item 4: comment spacing / xmlDoc / trailing comment (analyzer always emits, provider-level gating tested separately) ---
	{
		name: "cs: '//bad' missing space after slashes is flagged",
		lang: "cs",
		source: `
public class Foo
{
	//bad
	public void Bar()
	{
	}
}
`,
		expect: ["commentSpacing"],
		notExpect: []
	},
	{
		name: "cs: '// good' spaced comment is clean",
		lang: "cs",
		source: `
public class Foo
{
	// good
	public void Bar()
	{
	}
}
`,
		expect: [],
		notExpect: ["commentSpacing"]
	},
	{
		name: "cs: '//----' divider comment is not flagged for spacing",
		lang: "cs",
		source: `
//----------
public class Foo
{
}
`,
		expect: [],
		notExpect: ["commentSpacing"]
	},
	{
		name: "cs: public method without /// doc is flagged xmlDocMissing",
		lang: "cs",
		source: `
public class Foo
{
	public void Bar()
	{
	}
}
`,
		expect: ["xmlDocMissing"],
		notExpect: []
	},
	{
		name: "cs: public method with /// doc is clean",
		lang: "cs",
		source: `
public class Foo
{
	/// <summary>Does the thing.</summary>
	public void Bar()
	{
	}
}
`,
		expect: [],
		notExpect: ["xmlDocMissing"]
	},
	{
		name: "cs: private method is not checked for xmlDoc",
		lang: "cs",
		source: `
public class Foo
{
	private void Bar()
	{
	}
}
`,
		expect: [],
		notExpect: ["xmlDocMissing"]
	},
	{
		name: "cs: trailing comment at end of code line is flagged",
		lang: "cs",
		source: `
public class Foo
{
	public void Bar()
	{
		var x = 1; // trailing note
	}
}
`,
		expect: ["trailingComment"],
		notExpect: []
	},
	{
		name: "js: trailing comment at end of code line is flagged",
		lang: "js",
		source: `
define("X", [], function () {
	var x = 1; // trailing note
	return x;
});
`,
		expect: ["trailingComment"],
		notExpect: []
	},
	{
		name: "js: comment already on its own line is clean",
		lang: "js",
		source: `
define("X", [], function () {
	// own line note
	var x = 1;
	return x;
});
`,
		expect: [],
		notExpect: ["trailingComment"]
	},

	// --- Item 5: select-all-columns hint + suppression ---
	{
		name: "cs: AddAllSchemaColumns() is flagged as an info hint",
		lang: "cs",
		source: `
public class Foo
{
	public void Bar()
	{
		esq.AddAllSchemaColumns();
	}
}
`,
		expect: ["selectAllColumnsHint"],
		notExpect: []
	},
	{
		name: "cs: AddAllSchemaColumns() is suppressed by bpmsoft-ignore comment",
		lang: "cs",
		source: `
public class Foo
{
	public void Bar()
	{
		// bpmsoft-ignore: select-all-columns
		esq.AddAllSchemaColumns();
	}
}
`,
		expect: [],
		notExpect: ["selectAllColumnsHint"]
	},
	{
		name: "cs: FetchFromDB with explicit column list is clean",
		lang: "cs",
		source: `
public class Foo
{
	public void Bar()
	{
		FetchFromDB(false, new[] { "Id", "Name" });
	}
}
`,
		expect: [],
		notExpect: ["selectAllColumnsHint"]
	},
	{
		name: "cs: FetchFromDB with no column list is flagged",
		lang: "cs",
		source: `
public class Foo
{
	public void Bar()
	{
		FetchFromDB(false);
	}
}
`,
		expect: ["selectAllColumnsHint"],
		notExpect: []
	},
	{
		name: "js: esq.allColumns = true assignment is flagged",
		lang: "js",
		source: `
define("X", [], function () {
	let esq = Ext.create("BPMSoft.EntitySchemaQuery", { rootSchemaName: "Lead" });
	esq.allColumns = true;
	return esq;
});
`,
		expect: ["selectAllColumnsHint"],
		notExpect: []
	},
	{
		name: "js: allColumns: true in Ext.create config is flagged",
		lang: "js",
		source: `
define("X", [], function () {
	let esq = Ext.create("BPMSoft.EntitySchemaQuery", { rootSchemaName: "Lead", allColumns: true });
	return esq;
});
`,
		expect: ["selectAllColumnsHint"],
		notExpect: []
	},
	{
		name: "js: esq.allColumns = true suppressed by bpmsoft-ignore comment",
		lang: "js",
		source: `
define("X", [], function () {
	let esq = Ext.create("BPMSoft.EntitySchemaQuery", { rootSchemaName: "Lead" });
	// bpmsoft-ignore: select-all-columns
	esq.allColumns = true;
	return esq;
});
`,
		expect: [],
		notExpect: ["selectAllColumnsHint"]
	},
	{
		name: "js: rootSchemaName without allColumns is clean",
		lang: "js",
		source: `
define("X", [], function () {
	let esq = Ext.create("BPMSoft.EntitySchemaQuery", { rootSchemaName: "Lead" });
	return esq;
});
`,
		expect: [],
		notExpect: ["selectAllColumnsHint"]
	}
];

function runNamingCase(name, actual, expectCount) {
	if (actual.length !== expectCount) {
		fail(
			name,
			`expected ${expectCount} issue(s), got ${actual.length}: ${JSON.stringify(actual.map((i) => i.message))}`
		);
		return;
	}
	pass(name);
}

const namingCases = [
	{
		name: "naming(schema): Section-typed schema with correct suffix is clean",
		expect: 0,
		run: () => checkClientSchemaNaming("GoTicketSection", "MODULE_VIEW_MODEL_SCHEMA", [])
	},
	{
		name: "naming(schema): Section-typed schema with wrong suffix is flagged",
		expect: 1,
		run: () => checkClientSchemaNaming("GoTicketRowItemWrong", "MODULE_VIEW_MODEL_SCHEMA", [])
	},
	{
		name: "naming(schema): Page-typed schema with PageV2 suffix is clean",
		expect: 0,
		run: () => checkClientSchemaNaming("GoTicketPageV2", "EDIT_VIEW_MODEL_SCHEMA", [])
	},
	{
		name: "naming(schema): Detail-typed schema with correct suffix is clean",
		expect: 0,
		run: () => checkClientSchemaNaming("GoAccessToTicketsDetail", "GRID_DETAIL_VIEW_MODEL_SCHEMA", [])
	},
	{
		name: "naming(schema): ambiguous plain MODULE type is never flagged for suffix",
		expect: 0,
		run: () => checkClientSchemaNaming("GoAnythingAtAll", "MODULE", [])
	},
	{
		name: "naming(schema): unknown schema type is never flagged for suffix",
		expect: 0,
		run: () => checkClientSchemaNaming("GoAnythingAtAll", undefined, [])
	},
	{
		name: "naming(schema): configured prefix missing is flagged",
		expect: 1,
		run: () => checkClientSchemaNaming("AccountPageV2", "EDIT_VIEW_MODEL_SCHEMA", ["Nau"])
	},
	{
		name: "naming(schema): configured prefix present is clean",
		expect: 0,
		run: () => checkClientSchemaNaming("NauAccountPageV2", "EDIT_VIEW_MODEL_SCHEMA", ["Nau"])
	},
	{
		name: "naming(schema): EDIT_VIEW_MODEL_SCHEMA with a Page-suffixed parent is still flagged when missing suffix",
		expect: 1,
		run: () => checkClientSchemaNaming("GoTicketWrongName", "EDIT_VIEW_MODEL_SCHEMA", [], "BaseModulePageV2")
	},
	{
		name: "naming(schema): EDIT_VIEW_MODEL_SCHEMA with a non-Page-suffixed parent is not flagged (real GoYaMessengerTemplateContentEditSchema case)",
		expect: 0,
		run: () =>
			checkClientSchemaNaming(
				"GoYaMessengerTemplateContentEditSchema",
				"EDIT_VIEW_MODEL_SCHEMA",
				[],
				"GoSMSTemplateContentEditSchema"
			)
	},
	{
		name: "naming(schema): EDIT_VIEW_MODEL_SCHEMA with unknown parent still enforces suffix (safe default)",
		expect: 1,
		run: () => checkClientSchemaNaming("GoTicketWrongName", "EDIT_VIEW_MODEL_SCHEMA", [], undefined)
	},
	{
		name: "naming(cs): BaseService-derived class without Service suffix is flagged",
		expect: 1,
		run: () =>
			checkCsharpSchemaNaming(
				"public class NauAccountHandler : BaseService\n{\n}\n",
				[]
			)
	},
	{
		name: "naming(cs): BaseService-derived class with Service suffix is clean",
		expect: 0,
		run: () =>
			checkCsharpSchemaNaming(
				"public class NauAccountService : BaseService\n{\n}\n",
				[]
			)
	},
	{
		name: "naming(cs): [EntityEventListener] class without EventListener suffix is flagged",
		expect: 1,
		run: () =>
			checkCsharpSchemaNaming(
				'[EntityEventListener(SchemaName = "Account")]\npublic class NauAccountHandler : BaseEntityEventListener\n{\n}\n',
				[]
			)
	},
	{
		name: "naming(cs): [EntityEventListener] class with EventListener suffix is clean",
		expect: 0,
		run: () =>
			checkCsharpSchemaNaming(
				'[EntityEventListener(SchemaName = "Account")]\npublic class NauAccountEventListener : BaseEntityEventListener\n{\n}\n',
				[]
			)
	},
	{
		name: "naming(cs): plain class with no recognizable role is never flagged for suffix",
		expect: 0,
		run: () => checkCsharpSchemaNaming("public class NauSomethingPlain\n{\n}\n", [])
	},
	{
		name: "naming(sql): guide's two-underscore example is clean",
		expect: 0,
		run: () => checkSqlScriptNaming("Account_Alter_AddStatus")
	},
	{
		name: "naming(sql): guide's one-underscore example is clean",
		expect: 0,
		run: () => checkSqlScriptNaming("VwAccount_CreateView")
	},
	{
		name: "naming(sql): real-world Remove-operation script is clean",
		expect: 0,
		run: () => checkSqlScriptNaming("GoTicketFile_RemoveGoTicketIdFKConstraint")
	},
	{
		name: "naming(sql): _Temp suffix on a valid pattern is clean",
		expect: 0,
		run: () => checkSqlScriptNaming("SysSettings_Delete_CountryCode_Temp")
	},
	{
		name: "naming(sql): name with no recognizable operation is flagged",
		expect: 1,
		run: () => checkSqlScriptNaming("RandomScriptName")
	}
];

const { formatJsSource } = require("../out/parse/jsFormatter");
const { formatCsharpSource } = require("../out/parse/csharpFormatter");
const { formatSqlSource } = require("../out/parse/sqlFormatter");

function runFormatCase(name, actual, expected) {
	if (actual !== expected) {
		fail(name, `expected=${JSON.stringify(expected)}\n  actual=  ${JSON.stringify(actual)}`);
		return;
	}
	pass(name);
}

function runMustContainCase(name, actual, mustContain) {
	const missing = mustContain.filter((needle) => !actual.includes(needle));
	if (missing.length) {
		fail(name, `missing=${JSON.stringify(missing)}\n  actual=${JSON.stringify(actual)}`);
		return;
	}
	pass(name);
}

const formatCases = [
	{
		name: "format(cs): K&R braces become Allman + blank line before if",
		lang: "cs",
		source: [
			"public class Foo {",
			"\tpublic void Bar() {",
			"\t\tvar x = 1;",
			"\t\tif (x == 1) {",
			"\t\t\treturn;",
			"\t\t}",
			"\t}",
			"}",
			""
		].join("\n"),
		expected: [
			"public class Foo",
			"{",
			"\tpublic void Bar()",
			"\t{",
			"\t\tvar x = 1;",
			"",
			"\t\tif (x == 1)",
			"\t\t{",
			"\t\t\treturn;",
			"\t\t}",
			"\t}",
			"}",
			""
		].join("\n")
	},
	{
		name: "format(cs): blank line inserted between two methods",
		lang: "cs",
		source: [
			"public class Foo",
			"{",
			"\tpublic void Bar()",
			"\t{",
			"\t}",
			"\tpublic void Baz()",
			"\t{",
			"\t}",
			"}",
			""
		].join("\n"),
		expected: [
			"public class Foo",
			"{",
			"\tpublic void Bar()",
			"\t{",
			"\t}",
			"",
			"\tpublic void Baz()",
			"\t{",
			"\t}",
			"}",
			""
		].join("\n")
	},
	{
		name: "format(cs): all-space-indented file is left alone (not tab-dominant)",
		lang: "cs",
		source: ["public class Foo", "{", "    public void Bar()", "    {", "    }", "}", ""].join(
			"\n"
		),
		expected: ["public class Foo", "{", "    public void Bar()", "    {", "    }", "}", ""].join(
			"\n"
		)
	},
	{
		name: "format(cs): a stray space-indented line in a tab-file is converted to tabs",
		lang: "cs",
		source: ["public class Foo", "{", "\tpublic void Bar()", "\t{", "    var x = 1;", "\t}", "}", ""].join(
			"\n"
		),
		expected: ["public class Foo", "{", "\tpublic void Bar()", "\t{", "\tvar x = 1;", "\t}", "}", ""].join(
			"\n"
		)
	},
	{
		name: "format(js): var/== fixed and K&R spacing normalized by Prettier",
		lang: "js",
		source: 'define("X", [], function () {\n\tvar x=1;\n\tif(x==1){\n\t\treturn x\n\t}\n\treturn x;\n});\n',
		expected:
			'define("X", [], function () {\n\tconst x = 1;\n\tif (x === 1) {\n\t\treturn x;\n\t}\n\treturn x;\n});\n'
	},
	{
		name: "format(sql): keywords/indentation normalized",
		lang: "sql",
		source: 'select id, name from "Account" where "Id" = 1;',
		expected: 'select\n\tid,\n\tname\nfrom\n\t"Account"\nwhere\n\t"Id" = 1;'
	},
	{
		// Safety regression: the formatter must NEVER auto-delete an
		// "unused" method/console.log/debugger, and must NEVER rename a
		// declaration in place, since neither is safe to batch-apply
		// without a human reviewing each occurrence (see AUTO_FORMAT_SAFE_KINDS).
		name: "format(js): does not delete an apparently-unused schema method",
		lang: "js",
		source: [
			'define("X", [], function () {',
			"\treturn {",
			"\t\tmethods: {",
			"\t\t\tunusedHelper: function () {",
			"\t\t\t\treturn 1;",
			"\t\t\t}",
			"\t\t}",
			"\t};",
			"});",
			""
		].join("\n"),
		mustContain: ["unusedHelper"]
	},
	{
		name: "format(js): does not strip console.log or debugger",
		lang: "js",
		source: [
			'define("X", [], function () {',
			"\tconsole.log('hi');",
			"\tdebugger;",
			"\treturn 1;",
			"});",
			""
		].join("\n"),
		mustContain: ["console.log", "debugger"]
	},
	{
		name: "format(js): does not rename a badly-cased local declaration",
		lang: "js",
		source: [
			'define("X", [], function () {',
			"\tlet Bad_Name = 1;",
			"\treturn Bad_Name;",
			"});",
			""
		].join("\n"),
		mustContain: ["Bad_Name"]
	},
	{
		name: "format(cs): does not rename a badly-cased method declaration",
		lang: "cs",
		source: [
			"public class Foo",
			"{",
			"\tpublic void bar()",
			"\t{",
			"\t}",
			"}",
			""
		].join("\n"),
		mustContain: ["public void bar()"]
	}
];

async function runFormatCases() {
	for (const c of formatCases) {
		let actual;
		try {
			actual =
				c.lang === "cs"
					? formatCsharpSource(c.source)
					: c.lang === "sql"
						? formatSqlSource(c.source)
						: await formatJsSource(c.source);
		} catch (e) {
			fail(c.name, `threw: ${(e && e.stack) || e}`);
			continue;
		}
		if (c.mustContain) {
			runMustContainCase(c.name, actual, c.mustContain);
		} else {
			runFormatCase(c.name, actual, c.expected);
		}
	}
}

async function main() {
	for (const c of cases) {
		runIssueCase(c.name, c.lang, c.source, c.expect, c.notExpect);
	}
	for (const c of namingCases) {
		let actual;
		try {
			actual = c.run();
		} catch (e) {
			fail(c.name, `threw: ${(e && e.stack) || e}`);
			continue;
		}
		runNamingCase(c.name, actual, c.expect);
	}
	await runFormatCases();
	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) {
		process.exit(1);
	}
}

main();
