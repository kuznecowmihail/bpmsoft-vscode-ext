import { PlatformStubMember } from "../index/types";

/**
 * Hand-written stubs for frequently used BPMSoft.* APIs
 * (merged with dynamically extracted enums / Structures).
 */
export function getStaticPlatformStubs(): PlatformStubMember[] {
	return [
		{
			name: "emptyString",
			kind: "const",
			detail: "string",
			documentation: "Пустая строка BPMSoft"
		},
		{
			name: "GUID_EMPTY",
			kind: "const",
			detail: "string",
			documentation:
				"Пустой GUID: `00000000-0000-0000-0000-000000000000` (alias BPMSoft.data.constants.GUID_EMPTY)"
		},
		{
			name: "generateGUID",
			kind: "method",
			detail: "(format?)",
			documentation:
				"Генерирует GUID. format: `N` | `D` | `B` | `P` (по умолчанию `D`). Alias: `BPMSoft.utils.guid.generateGUID`"
		},
		{
			name: "each",
			kind: "method",
			detail: "(collection, iterator, scope?)",
			documentation: "Итерация по коллекции / объекту"
		},
		{
			name: "chain",
			kind: "method",
			detail: "(…fns)",
			documentation: "Цепочка асинхронных вызовов"
		},
		{
			name: "isEmpty",
			kind: "method",
			detail: "(value)"
		},
		{
			name: "createFilterGroup",
			kind: "method",
			detail: "() → FilterGroup"
		},
		{
			name: "createColumnFilterWithParameter",
			kind: "method",
			detail: "(comparisonType, columnPath, value)"
		},
		{
			name: "utils",
			kind: "namespace",
			children: [
				{
					name: "inputBox",
					kind: "method",
					detail: "(caption, callback, buttons, scope, controls, config?)",
					documentation: "Модальное окно ввода"
				}
			]
		},
		{
			name: "MessageBox",
			kind: "namespace",
			documentation: "Глобальный MessageBox",
			children: [
				{ name: "controlArray", kind: "property" },
				{ name: "showConfirmation", kind: "method" },
				{ name: "showInformation", kind: "method" }
			]
		},
		{
			name: "MessageBoxButtons",
			kind: "enum",
			children: [
				{ name: "YES", kind: "const" },
				{ name: "NO", kind: "const" },
				{ name: "CANCEL", kind: "const" },
				{ name: "OK", kind: "const" },
				{ name: "CLOSE", kind: "const" }
			]
		},
		{
			name: "configuration",
			kind: "namespace",
			children: [
				{
					name: "mixins",
					kind: "namespace",
					documentation: "Пространство миксинов конфигурации"
				},
				{
					name: "Structures",
					kind: "namespace",
					documentation: "Иерархии схем (заполняется из conf/content)"
				}
			]
		},
		{
			name: "controls",
			kind: "namespace",
			documentation: "BPMSoft.controls.*"
		},
		{
			name: "core",
			kind: "namespace",
			documentation: "BPMSoft.core.*"
		},
		{
			name: "data",
			kind: "namespace",
			documentation: "BPMSoft.data.*"
		}
	];
}
