/**
 * Public surface for the ship subsystem (SPEC §22 Phase 9).
 */

export { BUILT_IN_SHIP_TARGETS, defaultShipRegistry, ShipRegistry } from "./registry.ts";
export { probeBinary, runStep, streamLines } from "./run.ts";
export type {
	ShipContext,
	ShipEvent,
	ShipInstallCheck,
	ShipPlan,
	ShipPlanStep,
	ShipTarget,
} from "./target.ts";
export {
	buildDockerArgv,
	dockerShipTarget,
	type ResolvedDockerPlan,
	resolveDockerPlan,
} from "./targets/docker.ts";
export {
	buildFlyArgv,
	flyShipTarget,
	type ResolvedFlyPlan,
	resolveFlyPlan,
} from "./targets/fly.ts";
export { tarballShipTarget } from "./targets/tarball.ts";
