/* eslint-disable @typescript-eslint/no-var-requires */
// Standalone unit test harness for the localization wizards' editor logic.
// Writes real temp files under os.tmpdir() (no real BPMSoft install needed).
// Run: npm run compile && node scripts/test-localization.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
	upsertResourceItem,
	removeResourceItem,
	listLocalizedStrings,
	listLocalizedImages,
	addLocalizedStringKey,
	renameLocalizedStringKey,
	deleteLocalizedStringKey,
	addLocalizedImage
} = require("../out/index/localizationEditor");
const { parseMetadataNameRegistrations } = require("../out/index/localizationLookup");
const { findSchemaDirForAnyPath } = require("../out/index/schemaResourceLookup");

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

function check(name, condition, detail) {
	if (condition) {
		pass(name);
	} else {
		fail(name, detail || "condition was false");
	}
}

function makeTempSchema() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bpmsoft-loc-test-"));
	// Nested under a literal "Pkg" folder, matching the real
	// `BPMSoft.Configuration/Pkg/{Package}/...` layout - `findOwningSchemaDescriptor`
	// (used by `findSchemaDirForAnyPath`) requires that marker segment.
	const pkgDir = path.join(root, "Pkg", "GoTestPkg");
	const schemaDir = path.join(pkgDir, "Schemas", "GoTestPage");
	const resourceDir = path.join(pkgDir, "Resources", "GoTestPage.ClientUnit");
	fs.mkdirSync(schemaDir, { recursive: true });
	fs.mkdirSync(resourceDir, { recursive: true });
	fs.writeFileSync(
		path.join(schemaDir, "descriptor.json"),
		JSON.stringify({ ManagerName: "ClientUnitSchemaManager" }),
		"utf8"
	);
	fs.writeFileSync(path.join(schemaDir, "GoTestPage.js"), "define('GoTestPage', [], function () { return {}; });", "utf8");
	fs.writeFileSync(
		path.join(resourceDir, "resource.ru-RU.xml"),
		[
			'<?xml version="1.0" encoding="utf-8"?>',
			'<Resources Culture="ru-RU">',
			"\t<Group Type=\"String\">",
			"\t\t<Items>",
			'\t\t\t<Item Name="Caption" Value="Тест" />',
			'\t\t\t<Item Name="LocalizableStrings.BravoCaption.Value" Value="Браво" />',
			'\t\t\t<Item Name="LocalizableStrings.DeltaCaption.Value" Value="Дельта" />',
			"\t\t</Items>",
			"\t</Group>",
			"</Resources>"
		].join("\n"),
		"utf8"
	);
	fs.writeFileSync(
		path.join(resourceDir, "resource.en-US.xml"),
		[
			'<?xml version="1.0" encoding="utf-8"?>',
			'<Resources Culture="en-US">',
			"\t<Group Type=\"String\">",
			"\t\t<Items>",
			'\t\t\t<Item Name="Caption" Value="Test" />',
			'\t\t\t<Item Name="LocalizableStrings.BravoCaption.Value" Value="Bravo" />',
			"\t\t</Items>",
			"\t</Group>",
			"</Resources>"
		].join("\n"),
		"utf8"
	);
	return { root, schemaDir, ruFile: path.join(resourceDir, "resource.ru-RU.xml"), enFile: path.join(resourceDir, "resource.en-US.xml") };
}

function readItems(filePath) {
	const { parseResourceItems } = require("../out/index/localizationLookup");
	return parseResourceItems(fs.readFileSync(filePath, "utf8"));
}

// --- upsertResourceItem: update in place, preserve indentation ---
(() => {
	const { ruFile } = makeTempSchema();
	upsertResourceItem(ruFile, "LocalizableStrings.BravoCaption.Value", { Value: "Браво2" });
	const items = readItems(ruFile);
	check("upsert: updates existing value", items.get("LocalizableStrings.BravoCaption.Value").value === "Браво2");
	check(
		"upsert: preserves 3-tab indentation",
		fs.readFileSync(ruFile, "utf8").includes('\t\t\t<Item Name="LocalizableStrings.BravoCaption.Value" Value="Браво2" />')
	);
})();

// --- upsertResourceItem: insert in ordinal-alpha position ---
(() => {
	const { ruFile } = makeTempSchema();
	upsertResourceItem(ruFile, "LocalizableStrings.CharlieCaption.Value", { Value: "Чарли" });
	const text = fs.readFileSync(ruFile, "utf8");
	const lines = text.split("\n").filter((l) => l.includes("LocalizableStrings"));
	check(
		"upsert: inserts between Bravo and Delta alphabetically",
		lines[0].includes("BravoCaption") && lines[1].includes("CharlieCaption") && lines[2].includes("DeltaCaption"),
		lines.join(" | ")
	);
})();

// --- upsertResourceItem: XML-escapes the value ---
(() => {
	const { ruFile } = makeTempSchema();
	upsertResourceItem(ruFile, "LocalizableStrings.BravoCaption.Value", { Value: 'A & B <C> "D"' });
	const text = fs.readFileSync(ruFile, "utf8");
	check("upsert: escapes & < > \"", text.includes('Value="A &amp; B &lt;C&gt; &quot;D&quot;"'), text);
	check("upsert: round-trips back through the reader", readItems(ruFile).get("LocalizableStrings.BravoCaption.Value").value === 'A & B <C> "D"');
})();

// --- upsertResourceItem: insert-before-a-sibling matches THAT sibling's real
// indentation, not a hardcoded guess (a file indented differently than the
// common 3-tab convention must still come out consistent) ---
(() => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bpmsoft-loc-indent-"));
	const file = path.join(dir, "resource.ru-RU.xml");
	fs.writeFileSync(
		file,
		[
			'<?xml version="1.0" encoding="utf-8"?>',
			'<Resources Culture="ru-RU">',
			"\t<Group Type=\"String\">",
			"\t\t<Items>",
			'\t\t<Item Name="LocalizableStrings.AlphaCaption.Value" Value="A" />',
			'\t\t<Item Name="LocalizableStrings.DeltaCaption.Value" Value="D" />',
			"\t\t</Items>",
			"\t</Group>",
			"</Resources>"
		].join("\n"),
		"utf8"
	);
	upsertResourceItem(file, "LocalizableStrings.CharlieCaption.Value", { Value: "C" });
	const text = fs.readFileSync(file, "utf8");
	check(
		"upsert: inserted-before-sibling line matches that sibling's own (2-tab) indentation",
		text.includes('\t\t<Item Name="LocalizableStrings.CharlieCaption.Value" Value="C" />'),
		text
	);
})();

// --- removeResourceItem ---
(() => {
	const { ruFile } = makeTempSchema();
	removeResourceItem(ruFile, "LocalizableStrings.BravoCaption.Value");
	check("remove: item gone", !readItems(ruFile).has("LocalizableStrings.BravoCaption.Value"));
	check("remove: sibling item untouched", readItems(ruFile).get("LocalizableStrings.DeltaCaption.Value").value === "Дельта");
})();

// --- listLocalizedStrings: union across cultures, sorted ---
(() => {
	const { schemaDir } = makeTempSchema();
	const rows = listLocalizedStrings(schemaDir, "GoTestPage");
	check("list: finds both keys", rows.map((r) => r.key).join(",") === "BravoCaption,DeltaCaption", JSON.stringify(rows));
	const delta = rows.find((r) => r.key === "DeltaCaption");
	check("list: DeltaCaption only has ru-RU (en-US never had it)", delta.values["ru-RU"] === "Дельта" && delta.values["en-US"] === undefined);
})();

// --- addLocalizedStringKey: validation + write-through + duplicate rejection ---
(() => {
	const { schemaDir, ruFile, enFile } = makeTempSchema();
	const bad = addLocalizedStringKey(schemaDir, "GoTestPage", "1BadKey", {});
	check("add: rejects key starting with a digit", bad.ok === false);

	const ok = addLocalizedStringKey(schemaDir, "GoTestPage", "EchoCaption", { "ru-RU": "Эхо", "en-US": "Echo" });
	check("add: accepts a valid new key", ok.ok === true, JSON.stringify(ok));
	check("add: written to ru-RU", readItems(ruFile).get("LocalizableStrings.EchoCaption.Value").value === "Эхо");
	check("add: written to en-US", readItems(enFile).get("LocalizableStrings.EchoCaption.Value").value === "Echo");

	const dup = addLocalizedStringKey(schemaDir, "GoTestPage", "EchoCaption", {});
	check("add: rejects a duplicate key", dup.ok === false);
})();

// --- renameLocalizedStringKey / deleteLocalizedStringKey ---
(() => {
	const { schemaDir, ruFile } = makeTempSchema();
	renameLocalizedStringKey(schemaDir, "GoTestPage", "BravoCaption", "BravoRenamed");
	const items = readItems(ruFile);
	check("rename: old name gone", !items.has("LocalizableStrings.BravoCaption.Value"));
	check("rename: new name carries the old value", items.get("LocalizableStrings.BravoRenamed.Value").value === "Браво");

	deleteLocalizedStringKey(schemaDir, "GoTestPage", "DeltaCaption");
	check("delete: item removed", !readItems(ruFile).has("LocalizableStrings.DeltaCaption.Value"));
})();

// --- addLocalizedImage: writes Image + Caption (only to the first culture), resolvable via listLocalizedImages ---
(() => {
	const { schemaDir } = makeTempSchema();
	const svg = Buffer.from("<svg></svg>", "utf8");
	const result = addLocalizedImage(schemaDir, "GoTestPage", "FoxtrotIcon", svg, ".svg");
	check("addImage: succeeds", result.ok === true, JSON.stringify(result));
	const rows = listLocalizedImages(schemaDir, "GoTestPage");
	const row = rows.find((r) => r.name === "FoxtrotIcon");
	check("addImage: shows up by name in listLocalizedImages", !!row, JSON.stringify(rows));
	check("addImage: canRename is true (Caption-sourced, no metadata.json)", row && row.canRename === true);
	check("addImage: ru-RU has the bytes", row && row.values["ru-RU"] && row.values["ru-RU"].base64 === svg.toString("base64"));
})();

// --- parseMetadataNameRegistrations: both metadata.json shapes ---
(() => {
	const fullJsonMetadata = JSON.stringify({
		MetaData: {
			Schema: {
				B2: [{ UId: "11111111-1111-1111-1111-111111111111", A2: "GolfCaption", A3: "x", A4: "x", A5: "x" }],
				HD8: [{ UId: "22222222-2222-2222-2222-222222222222", A2: "GolfIcon", A3: "x", A4: "x" }]
			}
		}
	});
	const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), "bpmsoft-loc-meta-json-"));
	fs.writeFileSync(path.join(dir1, "metadata.json"), fullJsonMetadata, "utf8");
	const b2json = parseMetadataNameRegistrations(dir1, "B2");
	check("metadata(full JSON): finds B2 entry", b2json.length === 1 && b2json[0].name === "GolfCaption", JSON.stringify(b2json));
	const hd8json = parseMetadataNameRegistrations(dir1, "HD8");
	check("metadata(full JSON): finds HD8 entry", hd8json.length === 1 && hd8json[0].uid === "22222222-2222-2222-2222-222222222222");

	const diffDslMetadata = [
		'= MetaData.Schema.UId "00000000-0000-0000-0000-000000000000"',
		"+ MetaData.Schema.B2 {",
		'  "UId": "33333333-3333-3333-3333-333333333333",',
		'  "A2": "HotelCaption",',
		'  "A3": "x",',
		'  "A4": "x",',
		'  "A5": "x"',
		"}",
		"~ MetaData.Schema.B2 [\"33333333-3333-3333-3333-333333333333\"]"
	].join("\n");
	const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "bpmsoft-loc-meta-dsl-"));
	fs.writeFileSync(path.join(dir2, "metadata.json"), diffDslMetadata, "utf8");
	const b2dsl = parseMetadataNameRegistrations(dir2, "B2");
	check("metadata(diff-DSL): finds B2 entry, ignores the ~ aggregate line", b2dsl.length === 1 && b2dsl[0].name === "HotelCaption", JSON.stringify(b2dsl));
})();

// --- findSchemaDirForAnyPath: resolves a resource.*.xml file directly, not
// just the schema's own .js/.cs (the toolbar button/context menu need this
// for a resource file opened on its own, e.g. from the Packages tree) ---
(() => {
	const { schemaDir, ruFile } = makeTempSchema();
	const resolved = findSchemaDirForAnyPath(ruFile);
	check(
		"findSchemaDirForAnyPath: resolves resource.ru-RU.xml back to the owning schema",
		resolved && resolved.schemaName === "GoTestPage" && path.resolve(resolved.schemaDir) === path.resolve(schemaDir),
		JSON.stringify(resolved)
	);
})();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
