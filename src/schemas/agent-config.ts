/**
 * Zod schema for declarative agent definitions (SPEC §12.3).
 *
 * `AgentConfig` is the long-tail seam: a user adds an agent (Gemini CLI,
 * aider, custom shell agent) by writing a config block instead of code.
 * `agentConfigToRuntime` (in ./declarative.ts) lifts a parsed config into
 * the same `AgentRuntime` surface the built-ins implement.
 *
 * Token substitution (in args + promptFile): `{{prompt}}`, `{{workspace}}`,
 * `{{run_id}}`, `{{burrow_id}}`. Unrecognised tokens are left literal so a
 * malformed template surfaces as the agent's own error rather than a silent
 * substitution.
 */

import { z } from "zod";

export const AGENT_OUTPUT_FORMATS = ["raw-text", "stream-json", "jsonl-claude"] as const;
export type AgentOutputFormat = (typeof AGENT_OUTPUT_FORMATS)[number];

export const AGENT_PROMPT_DELIVERIES = ["arg", "stdin", "file"] as const;
export type AgentPromptDelivery = (typeof AGENT_PROMPT_DELIVERIES)[number];

export const AGENT_INBOX_DELIVERIES = ["stdin-ndjson", "file", "none"] as const;
export type AgentInboxDelivery = (typeof AGENT_INBOX_DELIVERIES)[number];

export const AgentInstallCheckSchema = z.object({
	command: z.string().min(1),
	args: z.array(z.string()).default([]),
	exitCode: z.number().int().default(0),
});

export const AgentHooksSchema = z.object({
	settingsLocalJson: z.string().optional(),
});

export const AgentConfigSchema = z.object({
	id: z.string().min(1),
	displayName: z.string().min(1),
	command: z.string().min(1),
	args: z.array(z.string()).default([]),
	promptDelivery: z.enum(AGENT_PROMPT_DELIVERIES),
	promptFile: z.string().optional(),
	outputFormat: z.enum(AGENT_OUTPUT_FORMATS),
	supportsResume: z.boolean().default(false),
	resumeArgs: z.array(z.string()).optional(),
	inboxDelivery: z.enum(AGENT_INBOX_DELIVERIES).default("none"),
	requiredEnv: z.array(z.string()).optional(),
	optionalEnv: z.array(z.string()).optional(),
	installCheck: AgentInstallCheckSchema.optional(),
	hooks: AgentHooksSchema.optional(),
	/**
	 * Opt out of host credential forwarding for this agent (SPEC §17.4).
	 * Implicit default is "forward": `burrow up` calls the runtime's
	 * `credentialPaths()` and folds the result into
	 * `SandboxProfile.readOnlyMounts`. Set `forwardCredentials = false` to
	 * skip this for the agent (e.g. CI workers that ship their own creds).
	 */
	forwardCredentials: z.boolean().optional(),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type AgentInstallCheck = z.infer<typeof AgentInstallCheckSchema>;
export type AgentHooks = z.infer<typeof AgentHooksSchema>;

export interface AgentConfigParseError {
	path: (string | number)[];
	message: string;
}

export interface AgentConfigParseResult {
	ok: boolean;
	config?: AgentConfig;
	errors?: AgentConfigParseError[];
}

export function parseAgentConfig(input: unknown): AgentConfigParseResult {
	const res = AgentConfigSchema.safeParse(input);
	if (res.success) return { ok: true, config: res.data };
	return {
		ok: false,
		errors: res.error.issues.map((i) => ({
			path: [...i.path] as (string | number)[],
			message: i.message,
		})),
	};
}
