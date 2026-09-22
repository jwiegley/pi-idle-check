import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTestHost } from "./support/host.ts";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  name: string;
  license: string;
  keywords: string[];
  repository: { type: string; url: string };
  homepage: string;
  bugs: { url: string };
  publishConfig: { access: string; registry: string };
  dependencies?: Record<string, string>;
  devDependencies: Record<string, string>;
  engines: { node: string };
  files: string[];
  pi?: { extensions?: string[] };
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
  scripts: Record<string, string>;
};

test("declares one source extension and no runtime dependencies", () => {
  assert.deepEqual(packageJson.pi?.extensions, ["./index.ts"]);
  assert.equal(packageJson.dependencies, undefined);
  assert.deepEqual(packageJson.files, ["index.ts", "src/**/*.ts", "README.md"]);
});

test("pins development inputs and declares compatible Pi host peers", () => {
  assert.deepEqual(packageJson.peerDependencies, {
    "@earendil-works/pi-coding-agent": ">=0.84.3 <0.85.0",
    "@earendil-works/pi-tui": "*",
  });
  assert.deepEqual(packageJson.peerDependenciesMeta, {
    "@earendil-works/pi-coding-agent": { optional: true },
    "@earendil-works/pi-tui": { optional: true },
  });
  assert.deepEqual(packageJson.devDependencies, {
    "@earendil-works/pi-ai": "0.84.3",
    "@earendil-works/pi-coding-agent": "0.84.3",
    "@earendil-works/pi-tui": "0.84.3",
    "@types/node": "22.19.19",
    typescript: "5.9.3",
  });
  assert.ok(
    Object.values(packageJson.devDependencies).every((version) =>
      /^\d+(?:\.\d+)+(?:[-+].+)?$/.test(version),
    ),
  );
  assert.equal(packageJson.engines.node, ">=22.19.0");
});

test("declares npm catalog metadata and validates before publication", () => {
  assert.ok(packageJson.keywords.includes("pi-package"));
  assert.deepEqual(packageJson.repository, {
    type: "git",
    url: "git+https://github.com/jwiegley/pi-idle-check.git",
  });
  assert.equal(packageJson.homepage, "https://github.com/jwiegley/pi-idle-check#readme");
  assert.equal(packageJson.bugs.url, "https://github.com/jwiegley/pi-idle-check/issues");
  assert.deepEqual(packageJson.publishConfig, {
    access: "public",
    registry: "https://registry.npmjs.org/",
  });
  assert.equal(packageJson.scripts.prepublishOnly, "npm run check");
  assert.equal(packageJson.scripts.preinstall, undefined);
  assert.equal(packageJson.scripts.install, undefined);
  assert.equal(packageJson.scripts.postinstall, undefined);
  assert.equal(packageJson.scripts.prepare, undefined);
});

test("packs only release files and loads the installed tarball through Pi", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-idle-check-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    npm_config_cache: join(root, "cache"),
    // Even under npm publish --dry-run, these local pack/install commands need real files.
    npm_config_dry_run: "false",
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
  };
  const [packed] = JSON.parse(execFileSync("npm", [
    "pack", "--json", "--ignore-scripts", "--pack-destination", root,
  ], { cwd: new URL("..", import.meta.url), env, encoding: "utf8" })) as [
    { filename: string; files: { path: string }[] },
  ];
  const files = packed.files.map((file) => file.path).sort();
  assert.deepEqual(files.filter((path) => path !== "LICENSE"), [
    "README.md",
    "index.ts",
    "package.json",
    "src/config.ts",
    "src/idle.ts",
  ]);
  if (packageJson.license !== "UNLICENSED") assert.ok(files.includes("LICENSE"));

  // Pi supplies host peers; install only the extension, with no scripts or network.
  execFileSync("npm", [
    "install", "--prefix", join(root, "install"), "--ignore-scripts",
    "--legacy-peer-deps", "--offline", "--no-audit", "--no-fund",
    "--package-lock=false", join(root, packed.filename),
  ], { cwd: root, env, encoding: "utf8" });
  const packageRoot = join(root, "install", "node_modules", packageJson.name);
  const host = await createTestHost([], { extensionPaths: [packageRoot] });
  try {
    assert.deepEqual(host.extensionsResult.errors, []);
    assert.equal(host.extensionsResult.extensions.length, 1);
    const [extension] = host.extensionsResult.extensions;
    assert.equal(extension?.resolvedPath, join(packageRoot, "index.ts"));
    assert.ok(extension?.handlers.has("input"));
    assert.ok(extension?.commands.has("pi-idle-check-new-session"));
  } finally {
    host.cleanup();
  }
});
