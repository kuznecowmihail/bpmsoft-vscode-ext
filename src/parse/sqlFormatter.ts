import { format } from "sql-formatter";

/** No vscode dependency — reused by tests. */
export function formatSqlSource(original: string): string {
	try {
		return format(original, { language: "postgresql", tabWidth: 4, useTabs: true });
	} catch {
		return original;
	}
}
