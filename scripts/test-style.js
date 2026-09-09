/* eslint-disable @typescript-eslint/no-var-requires */
// Standalone unit test harness for the style/format analyzers.
// Does NOT require a real BPMSoft install (unlike scripts/run-smoke.js).
// Run: npm run compile && node scripts/test-style.js

const { collectStyleIssues } = require("../out/parse/styleAnalyzer");
const { collectCsharpStyleIssues } = require("../out/parse/csharpStyleAnalyzer");
const { checkClientSchemaNaming } = require("../out/parse/schemaNamingAnalyzer");
const { checkCsharpSchemaNaming, DEFAULT_ROLE_SUFFIXES } = require("../out/parse/csharpSchemaAnalyzer");
const { checkSqlScriptNaming } = require("../out/parse/sqlNamingAnalyzer");
const {
	checkEntityCodeNaming,
	checkEntityColumnNaming,
	findEntityCodeCollisions
} = require("../out/parse/entityNamingAnalyzer");
const { checkProcessCodeNaming, checkProcessElementNaming } = require("../out/parse/processNamingAnalyzer");
const {
	checkProcessUserTaskCodeNaming,
	checkProcessUserTaskParameterNaming
} = require("../out/parse/processUserTaskNamingAnalyzer");
const { checkDataSchemaCodeNaming, findSysSettingsPairingIssues } = require("../out/parse/dataSchemaNamingAnalyzer");
const { checkPackageOwnership } = require("../out/index/packageOwnershipCheck");
const { checkCaptionCoverage, extractNamingSubject } = require("../out/parse/namingCommon");
const { classifyGitFlowBranch } = require("../out/index/gitFlowCheck");

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

const defaultClientNamingSettings = { prefixes: [] };
const defaultCsharpNamingSettings = {
	prefixes: [],
	roleSuffixes: []
};
const defaultEntityNamingSettings = {
	prefixes: [],
	checkSingularName: true,
	singularExceptions: ["Settings", "Permissions", "Statistics"],
	dateSuffixes: ["On", "Date"],
	booleanPrefixes: ["Is", "Has", "Can"]
};
const gitFlowSettings = { mainBranch: "main", developBranch: "develop", checkBranchParent: true };

const namingCases = [
	{
		name: "naming(schema): Section-typed schema with correct suffix is clean",
		expect: 0,
		run: () =>
			checkClientSchemaNaming("GoTicketSection", defaultClientNamingSettings, {
				schemaType: "MODULE_VIEW_MODEL_SCHEMA"
			})
	},
	{
		name: "naming(schema): Section-typed schema with wrong suffix is flagged",
		expect: 1,
		run: () =>
			checkClientSchemaNaming("GoTicketRowItemWrong", defaultClientNamingSettings, {
				schemaType: "MODULE_VIEW_MODEL_SCHEMA",
				parentName: "AccountSectionV2"
			})
	},
	{
		name: "naming(schema): Page-typed schema with PageV2 suffix is clean",
		expect: 0,
		run: () =>
			checkClientSchemaNaming("GoTicketPageV2", defaultClientNamingSettings, {
				schemaType: "EDIT_VIEW_MODEL_SCHEMA"
			})
	},
	{
		name: "naming(schema): Detail-typed schema with correct suffix is clean",
		expect: 0,
		run: () =>
			checkClientSchemaNaming("GoAccessToTicketsDetail", defaultClientNamingSettings, {
				schemaType: "GRID_DETAIL_VIEW_MODEL_SCHEMA"
			})
	},
	{
		name: "naming(schema): ambiguous plain MODULE type is never flagged for suffix",
		expect: 0,
		run: () =>
			checkClientSchemaNaming("GoAnythingAtAll", defaultClientNamingSettings, { schemaType: "MODULE" })
	},
	{
		name: "naming(schema): unknown schema type is never flagged for suffix",
		expect: 0,
		run: () => checkClientSchemaNaming("GoAnythingAtAll", defaultClientNamingSettings, {})
	},
	{
		name: "naming(schema): configured prefix missing is flagged",
		expect: 1,
		run: () =>
			checkClientSchemaNaming(
				"AccountPageV2",
				{ prefixes: ["Nau"] },
				{ schemaType: "EDIT_VIEW_MODEL_SCHEMA" }
			)
	},
	{
		name: "naming(schema): configured prefix present is clean",
		expect: 0,
		run: () =>
			checkClientSchemaNaming(
				"NauAccountPageV2",
				{ prefixes: ["Nau"] },
				{ schemaType: "EDIT_VIEW_MODEL_SCHEMA" }
			)
	},
	{
		name: "naming(schema): EDIT_VIEW_MODEL_SCHEMA with a Page-suffixed parent is still flagged when missing suffix",
		expect: 1,
		run: () =>
			checkClientSchemaNaming("GoTicketWrongName", defaultClientNamingSettings, {
				schemaType: "EDIT_VIEW_MODEL_SCHEMA",
				parentName: "BaseModulePageV2"
			})
	},
	{
		name: "naming(schema): EDIT_VIEW_MODEL_SCHEMA with a non-Page-suffixed parent is not flagged (real GoYaMessengerTemplateContentEditSchema case)",
		expect: 0,
		run: () =>
			checkClientSchemaNaming("GoYaMessengerTemplateContentEditSchema", defaultClientNamingSettings, {
				schemaType: "EDIT_VIEW_MODEL_SCHEMA",
				parentName: "GoSMSTemplateContentEditSchema"
			})
	},
	{
		name: "naming(schema): EDIT_VIEW_MODEL_SCHEMA with no parent is not flagged for suffix",
		expect: 0,
		run: () =>
			checkClientSchemaNaming("GoTicketWrongName", defaultClientNamingSettings, {
				schemaType: "EDIT_VIEW_MODEL_SCHEMA"
			})
	},
	{
		name: "naming(cs): BaseService-derived class without Service suffix is flagged",
		expect: 1,
		run: () =>
			checkCsharpSchemaNaming(
				"public class NauAccountHandler : BaseService\n{\n}\n",
				defaultCsharpNamingSettings
			)
	},
	{
		name: "naming(cs): BaseService-derived class with Service suffix is clean",
		expect: 0,
		run: () =>
			checkCsharpSchemaNaming(
				"public class NauAccountService : BaseService\n{\n}\n",
				defaultCsharpNamingSettings
			)
	},
	{
		name: "naming(cs): [EntityEventListener] class without EventListener suffix is flagged",
		expect: 1,
		run: () =>
			checkCsharpSchemaNaming(
				'[EntityEventListener(SchemaName = "Account")]\npublic class NauAccountHandler : BaseEntityEventListener\n{\n}\n',
				defaultCsharpNamingSettings
			)
	},
	{
		name: "naming(cs): [EntityEventListener] class with EventListener suffix is clean",
		expect: 0,
		run: () =>
			checkCsharpSchemaNaming(
				'[EntityEventListener(SchemaName = "Account")]\npublic class NauAccountEventListener : BaseEntityEventListener\n{\n}\n',
				defaultCsharpNamingSettings
			)
	},
	{
		name: "naming(cs): plain class with no recognizable role is never flagged for suffix",
		expect: 0,
		run: () => checkCsharpSchemaNaming("public class NauSomethingPlain\n{\n}\n", defaultCsharpNamingSettings)
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
	},
	{
		name: "naming(schema): MiniPage parent requires MiniPage suffix",
		expect: 1,
		run: () =>
			checkClientSchemaNaming("GoTicketPageV2", defaultClientNamingSettings, {
				schemaType: "EDIT_VIEW_MODEL_SCHEMA",
				parentName: "AccountMiniPage"
			})
	},
	{
		name: "naming(schema): MiniPage parent with MiniPage suffix is clean",
		expect: 0,
		run: () =>
			checkClientSchemaNaming("GoTicketMiniPage", defaultClientNamingSettings, {
				schemaType: "EDIT_VIEW_MODEL_SCHEMA",
				parentName: "AccountMiniPage"
			})
	},
	{
		name: "naming(schema): ModalPage parent requires ModalPage suffix",
		expect: 1,
		run: () =>
			checkClientSchemaNaming("GoTicketPageV2", defaultClientNamingSettings, {
				schemaType: "EDIT_VIEW_MODEL_SCHEMA",
				parentName: "AccountModalPage"
			})
	},
	{
		name: "naming(schema): CSS structurally without Css suffix is flagged",
		expect: 1,
		run: () =>
			checkClientSchemaNaming("GoTheme", defaultClientNamingSettings, {
				schemaType: "MODULE",
				moduleSource: { js: "\n", less: ".a { color: red; }" }
			})
	},
	{
		name: "naming(schema): CSS named Css with empty js and real less is clean",
		expect: 0,
		run: () =>
			checkClientSchemaNaming("GoThemeCss", defaultClientNamingSettings, {
				schemaType: "MODULE",
				moduleSource: { js: "\n", less: ".a { color: red; }" }
			})
	},
	{
		name: "naming(schema): named Css but js not empty is flagged",
		expect: 1,
		run: () =>
			checkClientSchemaNaming("GoThemeCss", defaultClientNamingSettings, {
				schemaType: "MODULE",
				moduleSource: {
					js: 'define("GoThemeCss", [], function () { return {}; });\n'
				}
			})
	},
	{
		name: "naming(schema): define() name mismatch is flagged",
		expect: 1,
		run: () =>
			checkClientSchemaNaming("GoDateFilterModule", defaultClientNamingSettings, {
				schemaType: "MODULE",
				moduleSource: {
					js: 'define("GoDateFilterViewModel", [], function () {});\n'
				}
			})
	},
	{
		name: "naming(schema): helper without Module/Mixin suffix is clean (regression)",
		expect: 0,
		run: () =>
			checkClientSchemaNaming("GoFooHelper", defaultClientNamingSettings, {
				schemaType: "MODULE",
				moduleSource: {
					js: 'define("GoFooHelper", [], function () {});\n'
				}
			})
	},
	{
		name: "naming(schema): GUID tail is flagged",
		expect: 1,
		run: () =>
			checkClientSchemaNaming("NauAccount213312123Section", defaultClientNamingSettings, {
				schemaType: "MODULE_VIEW_MODEL_SCHEMA",
				parentName: "AccountSectionV2"
			})
	},
	{
		name: "naming(schema): temp designation New is flagged",
		expect: 1,
		run: () =>
			checkClientSchemaNaming("GoNewTicketPageV2", defaultClientNamingSettings, {
				schemaType: "EDIT_VIEW_MODEL_SCHEMA",
				parentName: "BaseModulePageV2"
			})
	},
	{
		name: "naming(cs): SourceCode suffix is flagged",
		expect: 1,
		run: () =>
			checkCsharpSchemaNaming("public class NauFooSourceCode\n{\n}\n", defaultCsharpNamingSettings)
	},
	{
		name: "naming(cs): temp New in class name is flagged",
		expect: 1,
		run: () => checkCsharpSchemaNaming("public class NauNewAccount\n{\n}\n", defaultCsharpNamingSettings)
	},
	{
		name: "naming(cs): prefix missing with Nau is flagged",
		expect: 1,
		run: () =>
			checkCsharpSchemaNaming(
				"public class AccountService : BaseService\n{\n}\n",
				{ prefixes: ["Nau"], roleSuffixes: [] }
			)
	},
	{
		name: "naming(cs): schema name not in file is flagged",
		expect: 1,
		run: () =>
			checkCsharpSchemaNaming(
				"public class NauOther\n{\n}\n",
				defaultCsharpNamingSettings,
				"NauAccount"
			)
	},
	{
		name: "naming(cs): chained ServiceHelper is flagged",
		expect: 1,
		run: () =>
			checkCsharpSchemaNaming("public class NauAccountServiceHelper\n{\n}\n", {
				prefixes: [],
				roleSuffixes: DEFAULT_ROLE_SUFFIXES
			})
	},
	{
		name: "naming(cs): two top-level classes are not flagged (regression)",
		expect: 0,
		run: () =>
			checkCsharpSchemaNaming(
				"public class NauFoo\n{\n}\npublic class NauFooDto\n{\n}\n",
				{ prefixes: [], roleSuffixes: DEFAULT_ROLE_SUFFIXES },
				"NauFoo"
			)
	},
	{
		name: "naming(entity): plural entity code is flagged",
		expect: 1,
		run: () => checkEntityCodeNaming("GoTickets", defaultEntityNamingSettings)
	},
	{
		name: "naming(entity): Settings exception is clean",
		expect: 0,
		run: () => checkEntityCodeNaming("Settings", defaultEntityNamingSettings)
	},
	{
		name: "naming(entity): checkSingularName off skips plural",
		expect: 0,
		run: () =>
			checkEntityCodeNaming("GoTickets", {
				...defaultEntityNamingSettings,
				checkSingularName: false
			})
	},
	{
		name: "naming(entity): Tbl affix is flagged",
		expect: 1,
		run: () => checkEntityCodeNaming("GoLeadTbl", defaultEntityNamingSettings)
	},
	{
		name: "naming(entity): prefix missing is flagged",
		expect: 1,
		run: () =>
			checkEntityCodeNaming("Lead", {
				...defaultEntityNamingSettings,
				prefixes: ["Go"]
			})
	},
	{
		name: "naming(entity): boolean without verb prefix is flagged",
		expect: 1,
		run: () =>
			checkEntityColumnNaming(
				"Account",
				{ name: "GoActive", dataValueType: "BOOLEAN", isLookup: false },
				{ ...defaultEntityNamingSettings, prefixes: ["Go"] }
			)
	},
	{
		name: "naming(entity): boolean IsActive is clean",
		expect: 0,
		run: () =>
			checkEntityColumnNaming(
				"Account",
				{ name: "GoIsActive", dataValueType: "BOOLEAN", isLookup: false },
				{ ...defaultEntityNamingSettings, prefixes: ["Go"] }
			)
	},
	{
		name: "naming(entity): date without suffix is flagged",
		expect: 1,
		run: () =>
			checkEntityColumnNaming(
				"Account",
				{ name: "GoStart", dataValueType: "DATE", isLookup: false },
				{ ...defaultEntityNamingSettings, prefixes: ["Go"] }
			)
	},
	{
		name: "naming(entity): date CreatedOn is clean",
		expect: 0,
		run: () =>
			checkEntityColumnNaming(
				"Account",
				{ name: "GoCreatedOn", dataValueType: "DATE_TIME", isLookup: false },
				{ ...defaultEntityNamingSettings, prefixes: ["Go"] }
			)
	},
	{
		name: "naming(entity): lookup Id suffix is flagged",
		expect: 1,
		run: () =>
			checkEntityColumnNaming(
				"Lead",
				{ name: "GoAccountId", dataValueType: "LOOKUP", isLookup: true },
				{ ...defaultEntityNamingSettings, prefixes: ["Go"] }
			)
	},
	{
		name: "naming(entity): lookup without Id is clean",
		expect: 0,
		run: () =>
			checkEntityColumnNaming(
				"Account",
				{ name: "GoAccount", isLookup: true, dataValueType: "LOOKUP" },
				{ ...defaultEntityNamingSettings, prefixes: ["Go"] }
			)
	},
	{
		name: "naming(entity): redundant entity name in column is flagged",
		expect: 1,
		run: () =>
			checkEntityColumnNaming(
				"Customer",
				{ name: "GoCustomerName", isLookup: false },
				{ ...defaultEntityNamingSettings, prefixes: ["Go"] }
			)
	},
	{
		name: "naming(entity): two originals with same name are collisions",
		expect: 2,
		run: () =>
			findEntityCodeCollisions([
				{ name: "Lead", filePath: "a", isSubstitution: false },
				{ name: "Lead", filePath: "b", isSubstitution: false }
			])
	},
	{
		name: "naming(entity): substitution is not a collision",
		expect: 0,
		run: () =>
			findEntityCodeCollisions([
				{ name: "Lead", filePath: "a", isSubstitution: false },
				{ name: "Lead", filePath: "b", isSubstitution: true }
			])
	},
	{
		name: "naming(process): missing Process suffix is flagged",
		expect: 1,
		run: () => checkProcessCodeNaming("GoSendPayment", { prefixes: ["Go"] })
	},
	{
		name: "naming(process): prefix missing is flagged",
		expect: 1,
		run: () => checkProcessCodeNaming("SendPaymentProcess", { prefixes: ["Go"] })
	},
	{
		name: "naming(process): temp Temp in code is flagged",
		expect: 1,
		run: () => checkProcessCodeNaming("GoTempSendProcess", { prefixes: ["Go"] })
	},
	{
		name: "naming(process): action infinitive caption is clean",
		expect: 0,
		run: () =>
			checkProcessElementNaming({
				name: "a1",
				category: "action",
				caption: "Позвонить клиенту"
			})
	},
	{
		name: "naming(process): action without verb is flagged",
		expect: 1,
		run: () =>
			checkProcessElementNaming({
				name: "a1",
				category: "action",
				caption: "Клиенту звонок"
			})
	},
	{
		name: "naming(process): event past-tense caption is clean",
		expect: 0,
		run: () =>
			checkProcessElementNaming({
				name: "e1",
				category: "event",
				caption: "Договор подписан"
			})
	},
	{
		name: "naming(process): event not past tense is flagged",
		expect: 1,
		run: () =>
			checkProcessElementNaming({
				name: "e1",
				category: "event",
				caption: "Подписать договор"
			})
	},
	{
		name: "naming(process): exclusive gateway with ? is clean",
		expect: 0,
		run: () =>
			checkProcessElementNaming({
				name: "g1",
				category: "gatewayExclusive",
				caption: "Документы заполнены?"
			})
	},
	{
		name: "naming(process): exclusive gateway without ? is flagged",
		expect: 1,
		run: () =>
			checkProcessElementNaming({
				name: "g1",
				category: "gatewayExclusive",
				caption: "Документы заполнены"
			})
	},
	{
		name: "naming(process): sequence flow with caption is flagged",
		expect: 1,
		run: () =>
			checkProcessElementNaming({
				name: "f1",
				category: "flowSequence",
				caption: "Далее"
			})
	},
	{
		name: "naming(process): sequence flow unnamed is clean",
		expect: 0,
		run: () =>
			checkProcessElementNaming({
				name: "f1",
				category: "flowSequence"
			})
	},
	{
		name: "naming(process): eventTimer not checked for past tense",
		expect: 0,
		run: () =>
			checkProcessElementNaming({
				name: "t1",
				category: "eventTimer",
				caption: "Каждый день"
			})
	},
	{
		name: "naming(userTask): missing UserTask suffix is flagged",
		expect: 1,
		run: () =>
			checkProcessUserTaskCodeNaming("GoChangeData", {
				prefixes: ["Go"],
				actionVerbs: ["Change"]
			})
	},
	{
		name: "naming(userTask): verb not in list is flagged",
		expect: 1,
		run: () =>
			checkProcessUserTaskCodeNaming("GoFooDataUserTask", {
				prefixes: ["Go"],
				actionVerbs: ["Change", "Get"]
			})
	},
	{
		name: "naming(userTask): verb Change is clean",
		expect: 0,
		run: () =>
			checkProcessUserTaskCodeNaming("GoChangeDataUserTask", {
				prefixes: ["Go"],
				actionVerbs: ["Change", "Get"]
			})
	},
	{
		name: "naming(userTask): parameter Tbl affix is flagged",
		expect: 1,
		run: () => checkProcessUserTaskParameterNaming("AccountTbl")
	},
	{
		name: "naming(userTask): parameter clean name is clean",
		expect: 0,
		run: () => checkProcessUserTaskParameterNaming("AccountName")
	},
	{
		name: "naming(data): code not starting with table is flagged",
		expect: 1,
		run: () => checkDataSchemaCodeNaming("City_Main", "Lookup")
	},
	{
		name: "naming(data): Lookup_GoPaymentStatus is clean",
		expect: 0,
		run: () => checkDataSchemaCodeNaming("Lookup_GoPaymentStatus", "Lookup")
	},
	{
		name: "naming(data): GUID segment is flagged",
		expect: 1,
		run: () =>
			checkDataSchemaCodeNaming(
				"SysModuleEdit_1ecde34cf83743188a3f82763a8ed267",
				"SysModuleEdit"
			)
	},
	{
		name: "naming(data): pairing missing value",
		expect: 1,
		run: () => {
			const r = findSysSettingsPairingIssues(
				[{ code: "S1", filePath: "a", rowId: "id-1" }],
				[]
			);
			return r.missingValue;
		}
	},
	{
		name: "naming(data): pairing missing settings",
		expect: 1,
		run: () => {
			const r = findSysSettingsPairingIssues(
				[],
				[{ code: "V1", filePath: "b", referencedSysSettingsId: "id-1" }]
			);
			return r.missingSettings;
		}
	},
	{
		name: "naming(data): paired settings and value is clean",
		expect: 0,
		run: () => {
			const r = findSysSettingsPairingIssues(
				[{ code: "S1", filePath: "a", rowId: "id-1" }],
				[{ code: "V1", filePath: "b", referencedSysSettingsId: "id-1" }]
			);
			return [...r.missingValue, ...r.missingSettings];
		}
	},
	{
		name: "naming(ownership): empty prefixes and maintainers is clean",
		expect: 0,
		run: () =>
			checkPackageOwnership(
				{ name: "GoRestaurantsMain", maintainer: "YandexGo" },
				{ prefixes: [], expectedMaintainers: [] }
			)
	},
	{
		name: "naming(ownership): wrong prefix is flagged",
		expect: 1,
		run: () =>
			checkPackageOwnership(
				{ name: "GoRestaurantsMain", maintainer: "YandexGo" },
				{ prefixes: ["Nau"], expectedMaintainers: ["YandexGo"] }
			)
	},
	{
		name: "naming(ownership): wrong maintainer is flagged",
		expect: 1,
		run: () =>
			checkPackageOwnership(
				{ name: "GoRestaurantsMain", maintainer: "YandexGo" },
				{ prefixes: ["Go"], expectedMaintainers: ["OtherCorp"] }
			)
	},
	{
		name: "naming(ownership): empty maintainers skips maintainer check",
		expect: 0,
		run: () =>
			checkPackageOwnership(
				{ name: "GoRestaurantsMain", maintainer: "YandexGo" },
				{ prefixes: ["Go"], expectedMaintainers: [] }
			)
	},
	{
		name: "naming(caption): missing RU caption is flagged",
		expect: 1,
		run: () => checkCaptionCoverage("Object", "Lead", false, true)
	},
	{
		name: "naming(caption): both captions missing is flagged twice",
		expect: 2,
		run: () => checkCaptionCoverage("Object", "Lead", false, false)
	},
	{
		name: "naming(caption): both captions present is clean",
		expect: 0,
		run: () => checkCaptionCoverage("Object", "Lead", true, true)
	},
	{
		name: "naming(subject): guillemet form extracts schema name",
		expect: 0,
		run: () => {
			const s = extractNamingSubject('Схема «LeadPageV2»: хвост');
			return s === "LeadPageV2" ? [] : [{ message: "bad " + s }];
		}
	},
	{
		name: "naming(subject): quotes form extracts schema name",
		expect: 0,
		run: () => {
			const s = extractNamingSubject('Object "Lead": code must be PascalCase');
			return s === "Lead" ? [] : [{ message: "bad " + s }];
		}
	},
	{
		name: "naming(sql): PascalCase segment after operation is flagged",
		expect: 1,
		run: () => checkSqlScriptNaming("Account_Alter_addStatus")
	},
	{
		name: "naming(gitFlow): main branch classified as main",
		expect: 0,
		run: () =>
			classifyGitFlowBranch("main", gitFlowSettings) === "main" ? [] : [{ message: "not main" }]
	},
	{
		name: "naming(gitFlow): develop branch classified as develop",
		expect: 0,
		run: () =>
			classifyGitFlowBranch("develop", gitFlowSettings) === "develop"
				? []
				: [{ message: "not develop" }]
	},
	{
		name: "naming(gitFlow): sprint/x.y.z classified as sprint",
		expect: 0,
		run: () =>
			classifyGitFlowBranch("sprint/1.2.3", gitFlowSettings) === "sprint"
				? []
				: [{ message: "not sprint" }]
	},
	{
		name: "naming(gitFlow): release/x.y.z classified as release",
		expect: 0,
		run: () =>
			classifyGitFlowBranch("release/2.0.0", gitFlowSettings) === "release"
				? []
				: [{ message: "not release" }]
	},
	{
		name: "naming(gitFlow): feature/foo classified as feature",
		expect: 0,
		run: () =>
			classifyGitFlowBranch("feature/foo", gitFlowSettings) === "feature"
				? []
				: [{ message: "not feature" }]
	},
	{
		name: "naming(gitFlow): bugfix/bar classified as bugfix",
		expect: 0,
		run: () =>
			classifyGitFlowBranch("bugfix/bar", gitFlowSettings) === "bugfix"
				? []
				: [{ message: "not bugfix" }]
	},
	{
		name: "naming(gitFlow): hotfix/x is unknown",
		expect: 0,
		run: () =>
			classifyGitFlowBranch("hotfix/x", gitFlowSettings) ? [{ message: "should be unknown" }] : []
	},
	{
		name: "naming(gitFlow): master with mainBranch master classified as main",
		expect: 0,
		run: () =>
			classifyGitFlowBranch("master", { ...gitFlowSettings, mainBranch: "master" }) === "main"
				? []
				: [{ message: "not main" }]
	},
	{
		name: "naming(gitFlow): sprint/1.2 without patch is unknown",
		expect: 0,
		run: () =>
			classifyGitFlowBranch("sprint/1.2", gitFlowSettings)
				? [{ message: "should be unknown" }]
				: []
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
