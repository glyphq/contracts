# @glyph-oss/contracts

Typed metadata and wire codecs for Qubic smart contracts.

This package is generated from the Qubic core contract sources. It gives UIs,
SDKs, and indexers a stable TypeScript view of every on-chain contract without
having to parse C++ at runtime:

- contract, struct, enum, function, and procedure metadata
- exact C++ memory layout (offsets, alignment, padding, sizes)
- encode and decode helpers for contract inputs and outputs
- a generated registry keyed by contract index and name

## Install

```bash
bun add @glyph-oss/contracts
```

## Development

```bash
bun install
bun run generate   # refresh the ABI registry from Qubic core sources
bun test
bun run typecheck
bun run check      # biome, typecheck, tests, build, node import smoke test
```

Run `bun run check:fix` to apply formatting and lint fixes.

Source files use explicit `.js` extensions for relative imports. The compiler
resolves them to the corresponding `.ts` source and emits valid Node ESM.

Generated output lives in `src/generated` and is excluded from Biome formatting
so registry refreshes stay small and reviewable.

## Releases

Releases are managed with [Changesets](https://github.com/changesets/changesets):

```bash
bun run changeset  # describe the change and choose a semver bump
```

On `main`, the release workflow opens a "version packages" pull request and
publishes to npm once it is merged.

## License

MIT
