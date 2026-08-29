import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies: Record<string, string>;
  engines: { node: string };
  files: string[];
  license: string;
  pi?: { extensions?: string[] };
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
  private: boolean;
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

test("is private, unlicensed, and defines no lifecycle scripts", () => {
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.license, "UNLICENSED");
  assert.equal(packageJson.scripts.preinstall, undefined);
  assert.equal(packageJson.scripts.install, undefined);
  assert.equal(packageJson.scripts.postinstall, undefined);
  assert.equal(packageJson.scripts.prepare, undefined);
});
