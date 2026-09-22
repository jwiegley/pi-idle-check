# Publishing pi-idle-check

The [Pi package catalog](https://pi.dev/packages) discovers public npm packages with the `pi-package` keyword. There is no separate Pi package upload in the documented publication process: publish to npm, and the catalog can discover the release. A Git repository alone does not create a catalog listing.

This repository already declares `pi.extensions: ["./index.ts"]`, the discovery keyword, public registry settings, and repository links. Pi loads the TypeScript source directly; no build output or bundled Pi runtime is required. The coding-agent peer range remains deliberately limited to `>=0.84.3 <0.85.0`, tested against 0.84.3. Validate newer host versions before widening that range.

## Before the first release

The repository is licensed under [MIT](LICENSE), and the `private` publication guard has been removed. Account setup and publication remain manual steps; preparing the repository does not upload it to npm.

### Create and secure an npm account

An npm account identifies the owner of a published package. It is separate from a GitHub account; the usernames need not match.

1. Open [npm signup](https://www.npmjs.com/signup) and create a personal account with a username, email address, and unique password. Choose an email suitable for public package metadata: npm's account documentation warns that it may be visible to package consumers.
2. Open npm's verification email and verify the address. npm requires verification before publishing.
3. On npmjs.com, open the profile menu, choose **Account**, and select **Enable 2FA** under **Two-Factor Authentication**. Register a browser-supported security key or passkey, such as Touch ID or a hardware security key, following the browser prompts.
4. Save the recovery codes in a password manager or another secure location separate from the second-factor device. These codes restore access if that device is lost.

npm's current direct-publishing rules require 2FA or a specially configured access token. Use account 2FA for this interactive release; no manually created token or organization is needed.

### Authorize the terminal

Node.js and npm are already installed on the development machine. `npm login` authorizes this machine to act as the npm account; it does not publish anything.

The Nix-managed `~/.npm` on this machine is not a writable cache directory. Select a writable cache for this shell, then start browser-based login:

```sh
export npm_config_cache="${XDG_CACHE_HOME:-$HOME/.cache}/npm"
npm login --auth-type=web --registry=https://registry.npmjs.org/
```

Follow the terminal prompt to open the login page, or copy the displayed URL into a browser. Sign in to the account, complete any email or 2FA challenge, and return to the terminal when authorization succeeds. Confirm the identity:

```sh
npm whoami --registry=https://registry.npmjs.org/
```

The result should be the chosen npm username. If it reports `ENEEDAUTH`, repeat `npm login`. Authorization may expire; the same login procedure renews it.

The CLI normally stores its credential in `~/.npmrc`, outside this repository. Do not commit that file, paste its contents into chat, or share recovery codes. This login procedure uses npm 10's browser authentication rather than the legacy password prompts still shown in parts of npm's account guide. CI publishing can be added later with npm trusted publishing rather than a stored long-lived token.

### Check the package name

Check the npm name immediately before publishing:

```sh
npm view pi-idle-check name version --registry=https://registry.npmjs.org/
```

`E404` means no package was found; it does not reserve the name or guarantee npm will accept it. If another owner has claimed it, choose a scoped name such as `@YOUR_NPM_USER/pi-idle-check`, update `package.json` and the lockfile, and adjust the installation commands and catalog URL accordingly.

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

## References

Publication guidance checked on 2026-09-22. Recheck npm authentication and Pi catalog requirements before release.

- [Pi package format, discovery, and host dependencies](https://pi.dev/docs/latest/packages)
- [npm: creating an account and verifying email](https://docs.npmjs.com/creating-a-new-npm-user-account/)
- [npm: configuring two-factor authentication](https://docs.npmjs.com/configuring-two-factor-authentication/)
- [npm 10 login: browser authentication and credential storage](https://docs.npmjs.com/cli/v10/commands/npm-login/)
- [npm: creating and publishing public packages](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)
- [npm publish: payload, dry runs, and version immutability](https://docs.npmjs.com/cli/v11/commands/npm-publish/)
