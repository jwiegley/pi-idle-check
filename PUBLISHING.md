# Publishing pi-idle-check

The [Pi package catalog](https://pi.dev/packages) discovers public npm packages with the `pi-package` keyword. There is no separate Pi package upload in the documented publication process: publish to npm, and the catalog can discover the release. A Git repository alone does not create a catalog listing.

This repository already declares `pi.extensions: ["./index.ts"]`, the discovery keyword, public registry settings, and repository links. Pi loads the TypeScript source directly; no build output or bundled Pi runtime is required. The coding-agent peer range remains deliberately limited to `>=0.84.3 <0.85.0`, tested against 0.84.3. Validate newer host versions before widening that range.

## Before the first release

Publication is currently blocked by `"private": true`. The existing `"license": "UNLICENSED"` is preserved pending the owner's license decision; it is not the public-domain **Unlicense** and does not grant open-source usage rights.

1. Choose and approve the distribution license. For an open-source release, add its complete text as `LICENSE` and set the corresponding SPDX identifier in `package.json`. For example, **only after choosing MIT**:

   ```sh
   npm pkg set license=MIT
   ```

   Remove the publication guard and synchronize the lockfile after resolving licensing:

   ```sh
   npm pkg delete private
   npm install --package-lock-only --ignore-scripts
   ```

2. Check the npm name immediately before publishing:

   ```sh
   npm view pi-idle-check name version --registry=https://registry.npmjs.org/
   ```

   `E404` means no package was found; it does not reserve the name or guarantee npm will accept it. If another owner has claimed it, choose a scoped name such as `@YOUR_NPM_USER/pi-idle-check`, update `package.json` and the lockfile, and adjust the installation commands and catalog URL accordingly.

3. Create an npm account if needed, verify its email, and enable two-factor authentication for direct interactive publishing. Log in and confirm the publishing identity:

   ```sh
   npm login --registry=https://registry.npmjs.org/
   npm whoami --registry=https://registry.npmjs.org/
   ```

   Complete npm's authentication challenges locally; do not commit credentials or put tokens in release instructions. CI publishing can be added later with npm trusted publishing rather than a stored long-lived token.

## Validate and publish 0.1.0

Run these checks from the repository root before committing the release changes:

```sh
npm ci --ignore-scripts
npm run check
npm publish --dry-run
```

`npm run check` typechecks, runs the tests, and lists the package payload. Its smoke test creates a real tarball, installs it offline without host peers or lifecycle scripts, and loads that installed package through Pi. The expected payload is `package.json`, `README.md`, `index.ts`, `src/config.ts`, `src/idle.ts`, and the approved `LICENSE`. Tests, `PLAN.org`, `.obr`, `.pi`, and development dependencies must not be included. Review the dry-run output for unintended files; it does not prove registry authorization or catalog acceptance.

Update the README's pre-release installation notice once the release is authorized. Record issue changes with `obr sync --flush-only`, commit the release files and `PLAN.org` together, and confirm `git status --short` is empty. Version `0.1.0` is already set; do not run `npm version 0.1.0` again.

The following command is the public publication step. It uploads the package to npm and makes it available to others:

```sh
npm publish --access public
```

Publishing from the checkout runs `prepublishOnly`, which repeats `npm run check`. Do not bypass it with `--ignore-scripts`. npm may prompt for two-factor authentication. A published name/version pair cannot be reused, even after unpublishing.

After a successful publication, verify the release and record its source tag:

```sh
npm view pi-idle-check@0.1.0 version dist.tarball --registry=https://registry.npmjs.org/
git tag -a v0.1.0 -m "Release 0.1.0"
git push origin main
git push origin v0.1.0
```

On a compatible Pi installation without another copy loaded:

```sh
pi install npm:pi-idle-check@0.1.0
pi list
```

Run `/reload` or restart Pi and confirm there are no extension-load errors. Search the [catalog](https://pi.dev/packages) and check `https://pi.dev/packages/pi-idle-check` after indexing. Discovery need not be immediate; the official package documentation does not promise a refresh interval. If the listing is absent, first verify the published keyword and manifest with `npm view pi-idle-check keywords pi --json`.

## Later releases

Start from committed changes and passing checks. `npm version patch` (or `minor` / `major`, as appropriate) updates both manifests and creates a commit and tag. Then run `npm publish --access public`, verify the published version, and push the release commit and its tag. README and metadata changes also require a new npm version to reach registry consumers.

Optional `pi.image` or `pi.video` URLs provide gallery previews, as in [pi-mcp-adapter](https://pi.dev/packages/pi-mcp-adapter). They are not prerequisites for discovery. Add them only when an actual preview is available.

## Writable npm cache

If a Nix-managed home or another local setup makes `~/.npm` unwritable or produces `ENOTDIR`, select a writable cache for the publishing shell before running npm:

```sh
export npm_config_cache="${XDG_CACHE_HOME:-$HOME/.cache}/npm"
```

This changes neither the package nor the registry configuration.

## References

Publication guidance checked on 2026-09-22. Recheck npm authentication and Pi catalog requirements before release.

- [Pi package format, discovery, and host dependencies](https://pi.dev/docs/latest/packages)
- [npm: creating and publishing public packages](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)
- [npm publish: payload, dry runs, and version immutability](https://docs.npmjs.com/cli/v11/commands/npm-publish/)
