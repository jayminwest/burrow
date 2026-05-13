/**
 * Error hierarchy with stable codes and recovery hints.
 *
 * The CLI renderer (formatError) prints `[<code>] <message>\n  → <hint>` and
 * sets the exit code. Library callers can catch by class or switch on `code`.
 */

export abstract class BurrowError extends Error {
	abstract readonly code: string;
	readonly recoveryHint?: string;

	constructor(message: string, options?: { cause?: unknown; recoveryHint?: string }) {
		super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
		this.name = this.constructor.name;
		if (options?.recoveryHint !== undefined) {
			this.recoveryHint = options.recoveryHint;
		}
	}
}

export class SandboxError extends BurrowError {
	readonly code: string = "sandbox_error";
}

export class SandboxPrimitiveMissing extends SandboxError {
	override readonly code = "bwrap_or_sb_missing";
}

export class WorkspaceMaterializationError extends BurrowError {
	readonly code = "workspace_materialization_failed";
}

export class AgentNotInstalled extends BurrowError {
	readonly code = "agent_not_installed";
}

export class AgentRuntimeError extends BurrowError {
	readonly code = "agent_runtime_failed";
}

export class ToolchainMismatch extends BurrowError {
	readonly code = "toolchain_mismatch";
}

export class SecretResolutionError extends BurrowError {
	readonly code = "secret_resolution_failed";
}

export class ValidationError extends BurrowError {
	readonly code = "validation_error";
}

export class NotFoundError extends BurrowError {
	readonly code = "not_found";
}

export class CredentialError extends BurrowError {
	readonly code = "credential_error";
}

/**
 * Worker is draining (`POST /admin/drain {drain: true}` was set on the
 * server). Transient backpressure: the worker rejects new burrow + run
 * creation while in-flight work finishes. Callers (warren, orchestrators)
 * should treat this as "retry against another worker" rather than a hard
 * failure. Mapped to HTTP 503 by the server's renderError.
 */
export class WorkerDrainingError extends BurrowError {
	readonly code = "worker_draining";
}

/**
 * Render a BurrowError for terminal display. Non-BurrowError values fall back
 * to a generic shape so unexpected throws still surface a sensible message.
 */
export function formatError(err: unknown): string {
	if (err instanceof BurrowError) {
		const head = `[${err.code}] ${err.message}`;
		return err.recoveryHint ? `${head}\n  → ${err.recoveryHint}` : head;
	}
	if (err instanceof Error) {
		return `[unexpected] ${err.message}`;
	}
	return `[unexpected] ${String(err)}`;
}
