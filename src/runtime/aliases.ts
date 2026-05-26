/**
 * Short aliases for built-in agent ids.
 *
 * Keeps `bw init claude` and `bw agents add cc` ergonomic without forcing
 * users to remember the canonical hyphenated id. Aliases collapse to the
 * canonical id used in `burrow.toml [[agents]]` and the registry.
 */

export const AGENT_ALIASES: Readonly<Record<string, string>> = {
	"claude-code": "claude-code",
	claude: "claude-code",
	cc: "claude-code",
	sapling: "sapling",
	sp: "sapling",
	codex: "codex",
	cx: "codex",
	pi: "pi",
};

/**
 * Resolve a CLI-supplied agent token (alias or canonical id) to its
 * canonical id. Returns null when the token isn't recognized.
 */
export function resolveAgentAlias(token: string): string | null {
	const trimmed = token.trim().toLowerCase();
	return AGENT_ALIASES[trimmed] ?? null;
}

/** Canonical ids of the built-ins, in display order. */
export function knownBuiltInIds(): string[] {
	return ["claude-code", "sapling", "codex", "pi"];
}
