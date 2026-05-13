/**
 * Admin surface for `burrow serve` (pl-cb3e step 4 / burrow-79ad).
 *
 * Exactly one route lives here today: `POST /admin/drain`. The plan
 * (pl-cb3e approach) deliberately keeps admin on the same listener as the
 * mirrored Client surface — under the VPC-private threat model the bearer
 * boundary is the meaningful security perimeter, not the TCP port, so a
 * separate admin port would double the operator-facing config for zero
 * security gain.
 *
 * Drain semantics:
 *   - Bit lives on the dispatcher (`DrainController`) so a single source
 *     of truth survives across multiple HTTP listeners on the same worker.
 *   - When set, `POST /burrows` and `POST /burrows/:id/runs` return 503
 *     `worker_draining` (handlers wrapped via `withDrainGate` in routes.ts).
 *   - In-flight runs and streaming responses are NOT interrupted —
 *     graceful drain means "stop accepting new work; let the current set
 *     finish to terminal state".
 *   - Unset (`{drain: false}`) restores acceptance.
 *
 * Admin is mounted alongside the canonical route table (not in
 * ROUTE_PATTERNS) so the OpenAPI golden test (which enforces ROUTE_PATTERNS
 * ⊆ spec) doesn't trip. The OpenAPI doc update is the next plan step
 * (burrow-37c3); admin appears there.
 */

import { ValidationError, WorkerDrainingError } from "../core/errors.ts";
import type { DrainController } from "../runner/dispatcher.ts";
import { jsonResponse } from "./response.ts";
import type { AdminControls, Route, RouteContext, RouteHandler } from "./types.ts";

/**
 * Wrap a CRUD handler so it 503s when the dispatcher is draining. Used to
 * gate `POST /burrows` and `POST /burrows/:id/runs` — read endpoints
 * (GET /burrows, GET /burrows/:id, …) and lifecycle ones (cancel, stop,
 * resume) keep working through drain so operators / orchestrators can
 * still observe state and tear down in-flight work.
 */
export function withDrainGate(controller: DrainController, inner: RouteHandler): RouteHandler {
	return (ctx) => {
		if (controller.isDraining()) {
			throw new WorkerDrainingError(
				"burrow worker is draining; new burrows and runs are not accepted",
				{
					recoveryHint:
						'retry against another worker, or POST /admin/drain {"drain":false} to resume acceptance',
				},
			);
		}
		return inner(ctx);
	};
}

/**
 * Build the admin route table for an admin-enabled server. Currently a
 * one-element list (`POST /admin/drain`); kept as a function so future
 * admin routes (e.g. operator-triggered cache flush, telemetry pulls)
 * land here without re-shaping the server boot path.
 */
export function buildAdminRoutes(controls: AdminControls): Route[] {
	return [
		{
			method: "POST",
			pattern: "/admin/drain",
			handler: drainHandler(controls.drain),
		},
	];
}

/**
 * `POST /admin/drain` — flip the dispatcher's drain bit. Body shape:
 * `{drain: boolean}` (strict — no string coercion). Response echoes the
 * new state so the caller can confirm without a follow-up GET.
 *
 * Idempotent: setting drain to its current value is a no-op (still 200,
 * still echoes the value). The handler does not block on in-flight work
 * draining — it returns immediately; the operator polls `GET /healthz`
 * (or worker telemetry, if added) to know when the worker is quiescent.
 */
function drainHandler(controller: DrainController): RouteHandler {
	return async (ctx: RouteContext) => {
		const body = await readDrainBody(ctx);
		controller.setDrain(body.drain);
		return jsonResponse(200, { drain: controller.isDraining() });
	};
}

async function readDrainBody(ctx: RouteContext): Promise<{ drain: boolean }> {
	const raw = await ctx.request.text();
	if (raw.length === 0) {
		throw new ValidationError(
			"request body is empty; expected a JSON object with a 'drain' boolean",
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new ValidationError(
			`request body must be JSON: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ValidationError("request body must be a JSON object");
	}
	const drain = (parsed as Record<string, unknown>).drain;
	if (typeof drain !== "boolean") {
		throw new ValidationError("field 'drain' is required and must be a boolean");
	}
	return { drain };
}
