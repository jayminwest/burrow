/**
 * `ShipRegistry` — last-write-wins registry of `ShipTarget` instances. Mirrors
 * the AgentRegistry shape so callers can reach for the same mental model.
 *
 * Built-ins are constructed by `defaultShipRegistry()`; tests can register
 * fakes to mock the docker/fly shell-outs without monkey-patching globals.
 */

import { ValidationError } from "../core/errors.ts";
import type { ShipTarget } from "./target.ts";
import { dockerShipTarget } from "./targets/docker.ts";
import { flyShipTarget } from "./targets/fly.ts";
import { tarballShipTarget } from "./targets/tarball.ts";

export class ShipRegistry {
	private readonly targets = new Map<string, ShipTarget>();

	register(target: ShipTarget): ShipTarget {
		this.targets.set(target.id, target);
		return target;
	}

	get(id: string): ShipTarget | undefined {
		return this.targets.get(id);
	}

	require(id: string): ShipTarget {
		const t = this.targets.get(id);
		if (!t) {
			throw new ValidationError(`unknown ship target: '${id}'`, {
				recoveryHint: `known targets: ${this.list()
					.map((x) => x.id)
					.join(", ")}`,
			});
		}
		return t;
	}

	has(id: string): boolean {
		return this.targets.has(id);
	}

	list(): ShipTarget[] {
		return [...this.targets.values()];
	}

	unregister(id: string): boolean {
		return this.targets.delete(id);
	}
}

/** Built-in registry: tarball + docker + fly (SPEC §22 Phase 9). */
export function defaultShipRegistry(): ShipRegistry {
	const reg = new ShipRegistry();
	reg.register(tarballShipTarget);
	reg.register(dockerShipTarget);
	reg.register(flyShipTarget);
	return reg;
}

export const BUILT_IN_SHIP_TARGETS: readonly string[] = ["tarball", "docker", "fly"];
