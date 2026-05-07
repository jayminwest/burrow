/**
 * Raw-text parser. Each non-empty stdout line becomes a single `text` event.
 *
 * Used by runtimes that emit unstructured agent output (e.g. one-shot codex
 * with `--prompt-file`) and by declarative adapters with
 * `outputFormat: 'raw-text'`.
 */

import type { RuntimeEvent } from "../runtime.ts";

export function parseRawText(line: string): RuntimeEvent[] {
	if (line.length === 0) return [];
	return [
		{
			kind: "text",
			stream: "stdout",
			payload: { text: line },
		},
	];
}
