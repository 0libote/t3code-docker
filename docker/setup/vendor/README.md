# Vendored YAML parser

`yaml.mjs` bundles `yaml@2.9.1` by Eemeli Aro. Its ISC license is preserved in
`yaml.LICENSE`. This is used on the server for skill frontmatter; nothing is
downloaded at runtime or sent to the browser.

Upstream: https://github.com/eemeli/yaml/tree/v2.9.1

Reproduce from a temporary directory, then copy the bundle and license here:

```sh
npm pack yaml@2.9.1
tar -xzf yaml-2.9.1.tgz
npm exec --yes --package=esbuild@0.25.12 -- esbuild package/browser/dist/index.js --bundle --format=esm --platform=node --minify --outfile=yaml.mjs
```

SHA-256 of the npm archive:
`4ef6c54cf559b8a207b7b518378230805a1c84af239b14960e8c67c7d59de5d3`.

SHA-256 of the bundle:
`13ebcaebd9d434c647a9e1a492392ab1ee8f604635cec427b2691cb7c5e7c524`.

Metadata extraction inspects scalar nodes directly; it never expands aliases or
executes custom tags. Inputs are bounded before parsing. Update the pinned
version, archive checksum, bundle checksum and license together.

## JSONC editor

`jsonc.mjs` bundles Microsoft's `jsonc-parser@3.3.1` (MIT; see `jsonc.LICENSE`).
It preserves JSONC comments and rule order for OpenCode's native policy edits;
Claude settings are validated as strict JSON. No runtime dependency installation
or browser code is added.

Upstream: https://github.com/microsoft/node-jsonc-parser/tree/v3.3.1

```sh
npm install --prefix /tmp/jsonc-build --no-audit --no-fund jsonc-parser@3.3.1 esbuild@0.25.12
/tmp/jsonc-build/node_modules/.bin/esbuild /tmp/jsonc-build/node_modules/jsonc-parser/lib/esm/main.js --bundle --format=esm --platform=node --minify --outfile=jsonc.mjs
```

Bundle SHA-256: `bd0f3ce191c835fbd222afb0e0e416852d0ea1c917406bdd0a609a0b8655f5ef`.
Inputs are bounded to 1 MiB; invalid syntax, duplicate keys and unsupported
policy shapes disable controls rather than normalizing away existing settings.

## TOML syntax tree

`toml-patch.mjs` is the unmodified ESM distribution of
`@decimalturn/toml-patch@3.1.2` (MIT; see `toml-patch.LICENSE`).
Upstream: https://github.com/DecimalTurn/toml-patch

```sh
npm pack @decimalturn/toml-patch@3.1.2
tar -xzf decimalturn-toml-patch-3.1.2.tgz
cp package/dist/toml-patch.js toml-patch.mjs
cp package/LICENSE toml-patch.LICENSE
```

Archive SHA-256: `aed417934ced4cd4d19da54eb286c16750ba9058ca2e47be4162e3c0e5449514`.
Distribution SHA-256: `8872b6d74fd090a2e358b727ce68d055af802c9efa86d05a8a1d05cdba6ce869`.

MCP editing validates the complete document and uses this pinned parser's CST
locations to change only the selected server. Unrelated source, including
comments attached to the end of a preceding table, stays in place. Inline-root
edits are patched only inside that root assignment. The result is parsed again
and checked against the intended data before publication. Nested tables,
arrays of tables and multiline strings are covered by regression tests. Update
the distribution, license, checksums and CST compatibility checks together.
There is no runtime package installation and the bundle never reaches browsers.
