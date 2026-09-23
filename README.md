# omp-extensions

A monorepo of extensions for [oh-my-pi](https://omp.sh) (omp), distributed as
an omp plugin marketplace and on npm (listed in the
[pi.dev package catalog](https://pi.dev/packages)). Install either way:

```sh
# npm
omp plugin install omp-wiretap

# or this repo as a marketplace — add once, install any extension
omp plugin marketplace add luobochuanqi/omp-extensions
omp plugin install wiretap@omp-extensions
```

## Extensions

| Extension | Version | Description |
| --- | --- | --- |
| [wiretap](./wiretap) | 0.1.0 | Raw LLM network request inspector — captures the exact provider wire payload plus response status, headers, and TTFB; inspect in-transcript via `/wire`. |

Each extension is a self-contained package: its `package.json` carries its own
version and the `omp.extensions` manifest, and the root
[`.omp-plugin/marketplace.json`](.omp-plugin/marketplace.json) is the
marketplace catalog. Extensions ship TypeScript sources directly — omp imports
them at load; there is no build step.

## Development

```sh
git clone https://github.com/luobochuanqi/omp-extensions
cd omp-extensions/wiretap
bun install          # dev-only deps (runtime imports are host-provided)
bun run typecheck    # tsc --noEmit against pinned @oh-my-pi/* types
bun run selfcheck    # assert-based runtime check with a mock ExtensionAPI
bun run preview      # render sample views against the real dark theme
```

Load a working copy into a live session:

```sh
omp --extension ./wiretap    # one-off
omp plugin link ./wiretap    # persistent dev symlink
```

Extension code must only *register* at load time (handlers, commands,
renderers); runtime actions belong inside events/commands. The plugin
installer enforces this — it imports and initializes every declared extension
against a throwaway surface and rolls back the install on failure.

## Release flow

1. Bump `version` in the extension's `package.json`.
2. Commit, then tag `<extension>-vX.Y.Z` (tags anchor history; marketplace
   installs track the default branch).
3. Push `main` and the tag.
4. `npm publish` from the extension directory — updates the npm channel and
   the pi.dev catalog listing (marketplace users get it via upgrade).

The catalog deliberately omits per-plugin `version` — installs read it from
the plugin manifest, keeping one source of truth. Consequence: the bulk
`omp plugin upgrade` (which compares catalog versions only) skips such
entries; upgrade explicitly with `omp plugin upgrade wiretap@omp-extensions`.

## Adding an extension

1. Create `<name>/` with a `package.json` declaring `name`, `version`,
   `license`, and `omp.extensions: ["./index.ts"]`.
2. Add an entry to `.omp-plugin/marketplace.json` with `"source": "./<name>"`.
3. Include a `README.md` and its own `selfcheck`/`typecheck` scripts.

## License

MIT — see each extension's `LICENSE`.
