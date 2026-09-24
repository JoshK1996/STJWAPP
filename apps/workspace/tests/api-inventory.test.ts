import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

test("the generated API contract retains every installed literal route and dynamic MFA operation", async () => {
  const doc = JSON.parse(await readFile("docs/openapi.json", "utf-8"));
  const routes: { path: string; method: string }[] = [];
  for (const name of await readdir("server")) {
    if (!name.endsWith(".ts")) continue;
    const source = await readFile("server/" + name, "utf-8");
    for (const match of source.matchAll(
      /app\.(get|post|put|patch|delete)\(\s*(["'])(\/api\/[^"']+)\2\s*,/g,
    )) {
      routes.push({
        method: match[1],
        path: match[3].slice(4).replace(/:([A-Za-z]+)/g, "{$1}"),
      });
    }
  }
  for (const action of ["disable", "recovery-codes"])
    routes.push({ method: "post", path: "/auth/mfa/" + action });
  assert.ok(routes.length > 160);
  for (const route of routes)
    assert.ok(
      doc.paths[route.path]?.[route.method],
      `${route.method} ${route.path} missing from API documentation`,
    );
  assert.equal(doc.paths["/auth/mfa/verify"].post.security.length, 0);
  assert.equal(
    doc.paths["/school/grade-imports/{id}/apply"].post.requestBody.content[
      "application/json"
    ].schema.additionalProperties,
    false,
  );
});
