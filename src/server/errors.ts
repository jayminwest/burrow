/**
 * Map thrown errors to `{ status, ErrorEnvelope }`. Each `BurrowError` subclass
 * has a known HTTP mapping; unknown errors fall through to 500. The CLI's
 * exitCodeFor() in src/cli/main.ts is the sister table — keep them aligned.
 */

import {
	AgentNotInstalled,
	AgentRuntimeError,
	BurrowError,
	CredentialError,
	NotFoundError,
	SandboxError,
	SecretResolutionError,
	ToolchainMismatch,
	ValidationError,
	WorkspaceMaterializationError,
} from "../core/errors.ts";
import type { ErrorEnvelope } from "./types.ts";

interface RenderedError {
	readonly status: number;
	readonly envelope: ErrorEnvelope;
}

export function renderError(err: unknown): RenderedError {
	if (err instanceof BurrowError) {
		const envelope: ErrorEnvelope = { error: { code: err.code, message: err.message } };
		if (err.recoveryHint !== undefined) envelope.error.hint = err.recoveryHint;
		return { status: statusFor(err), envelope };
	}
	if (err instanceof Error) {
		return {
			status: 500,
			envelope: { error: { code: "internal_error", message: err.message } },
		};
	}
	return {
		status: 500,
		envelope: { error: { code: "internal_error", message: String(err) } },
	};
}

export function notImplemented(route: string): RenderedError {
	return {
		status: 501,
		envelope: {
			error: {
				code: "not_implemented",
				message: `route ${route} is scaffolded but has no handler yet`,
				hint: "no Client.burrows.create analogue exists in src/lib/client.ts",
			},
		},
	};
}

export function notFound(pathname: string): RenderedError {
	return {
		status: 404,
		envelope: {
			error: {
				code: "not_found",
				message: `no route matches ${pathname}`,
			},
		},
	};
}

export function methodNotAllowed(method: string, pathname: string): RenderedError {
	return {
		status: 405,
		envelope: {
			error: {
				code: "method_not_allowed",
				message: `${method} not allowed on ${pathname}`,
			},
		},
	};
}

function statusFor(err: BurrowError): number {
	if (err instanceof NotFoundError) return 404;
	if (err instanceof ValidationError) return 400;
	if (err instanceof CredentialError) return 401;
	if (err instanceof AgentNotInstalled) return 424;
	if (err instanceof AgentRuntimeError) return 502;
	if (err instanceof SandboxError) return 502;
	if (err instanceof WorkspaceMaterializationError) return 500;
	if (err instanceof ToolchainMismatch) return 409;
	if (err instanceof SecretResolutionError) return 502;
	return 500;
}
