/**
 * `GET /openapi.json` and `GET /openapi.html` route handlers (burrow-d3ea).
 *
 * The JSON document is cached on first build — it's pure / deterministic so
 * there's no reason to re-serialize on every request. The HTML page hosts
 * Scalar API Reference (single-script CDN load), which fetches
 * `/openapi.json` from the same origin; auth is enforced on the JSON
 * endpoint, while the HTML page is left auth-exempt so a human can
 * discover the API surface before they have a token (the rendered docs
 * still need the JSON which IS auth-required).
 *
 * Scalar (vs Swagger UI / Stoplight Elements): single CDN tag, MIT
 * license, OpenAPI 3.1 native, and ~10× lighter than Swagger UI's bundled
 * stack. The CDN URL is pinned to a major version so a Scalar-side break
 * doesn't silently change our output.
 */

import type { RouteHandler } from "../types.ts";
import { buildOpenApiDocument, serializeOpenApiDocument } from "./spec.ts";

let cachedJson: string | undefined;

function getCachedJson(): string {
	if (cachedJson === undefined) {
		cachedJson = serializeOpenApiDocument(buildOpenApiDocument());
	}
	return cachedJson;
}

export const openApiJsonHandler: RouteHandler = () => {
	const body = getCachedJson();
	return new Response(body, {
		status: 200,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
};

/**
 * Pinned to Scalar's `@latest` major-1 channel. Pinning avoids a silent
 * upstream break; loading from a CDN is acceptable for the docs page since
 * it's the single human-only surface and degrades gracefully (the spec
 * itself is still served from `/openapi.json` for codegen).
 */
const SCALAR_CDN_SCRIPT = "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1";

const HTML_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>burrow serve — API reference</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
<script id="api-reference" data-url="/openapi.json"></script>
<script src="${SCALAR_CDN_SCRIPT}"></script>
</body>
</html>
`;

export const openApiHtmlHandler: RouteHandler = () => {
	return new Response(HTML_TEMPLATE, {
		status: 200,
		headers: {
			"content-type": "text/html; charset=utf-8",
			// `/openapi.json` is the data path; this HTML is purely a viewer.
			"cache-control": "public, max-age=300",
		},
	});
};

export { buildOpenApiDocument, serializeOpenApiDocument };
