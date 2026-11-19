# @glyph-oss/contracts

Typed Qubic contract metadata, ABI descriptors, and binary codecs for
TypeScript. The package is generated from
[`qubic/core`](https://github.com/qubic/core) and ships the exact memory layout
used by every Qubic contract on chain.

- Full metadata for contracts, procedures, functions, notifications, structs,
  and enums.
- Runtime encoders and decoders for procedure inputs, procedure outputs,
  function inputs, and function outputs.
- Natural C++ alignment and padding, including trailing struct padding.
- `bigint` for 64-bit and 128-bit integers, `number` for smaller integers,
  `boolean` for `bool` and `bit`.
- Identity conversion through `@qubic.org/crypto`, so Qubic identities can be
  converted to and from 32-byte public keys without hand-rolled K12 code.
- Per-contract typed handles such as `QX`.
- ESM only, browser-safe, Node 18+ and Bun 1.1+.

## Install

```bash
bun add @glyph-oss/contracts
```

```bash
npm install @glyph-oss/contracts
```

## Quick start

### Look up contract metadata

```ts
import { contracts, getContract } from "@glyph-oss/contracts";

const all = contracts;
const qx = getContract("QX");

console.log(qx.index, qx.assetName);
console.log(qx.procedures.map((call) => call.name));
```

Every `ContractDefinition` includes its on-chain index, source reference,
compiled state size when known, and the procedures, functions, notifications,
structs, and enums that belong to it.

### Encode and decode a call

```ts
import {
  decodeProcedureOutput,
  encodeProcedureInput,
  getContract,
} from "@glyph-oss/contracts";

const qx = getContract("QX");
const call = qx.procedures.find((candidate) => candidate.name === "IssueAsset");

if (!call) {
  throw new Error("QX.IssueAsset was not found");
}

const encoded = encodeProcedureInput(qx, call, {
  assetName: "GLYPH",
  numberOfShares: 1_000_000n,
});

const decoded = decodeProcedureOutput(qx, call, outputBytes, {
  enumFormat: "name",
});
```

`encodeProcedureInput` returns the serialized payload plus the registered
`inputType` and input size needed to build a transaction.
`decodeProcedureOutput` accepts the raw output bytes returned by the contract.
The function variants, `encodeFunctionInput` and `decodeFunctionOutput`, use
the same field and padding rules.

### Typed contract handles

Generated handles expose the same metadata and codec helpers with
contract-local names:

```ts
import { QX, encodeProcedureInput } from "@glyph-oss/contracts";

const call = QX.procedures.issueAsset;
const encoded = encodeProcedureInput(QX, call, {
  assetName: "GLYPH",
  numberOfShares: 1_000_000n,
});
```

The API is still pre-1.0. Check the generated TypeScript declarations for the
exact helper signatures available in the installed version.

## Codec semantics

Qubic serializes contract structs as raw C++ memory. The codec deliberately
preserves that layout instead of using a compact canonical encoding.

- `offset`, `byteLength`, and `alignment` in the metadata always describe the
  compiled C++ layout. Padding bytes are encoded and decoded as part of the
  struct.
- `uint64`, `sint64`, `uint128`, and `sint128` values use `bigint`. Smaller
  integer fields use `number`.
- Fixed-size `Array<T, N>` fields are expanded into `N` elements. Arrays of
  arrays are outside the supported QPI subset.
- `id` fields are 32-byte public keys. Encoding accepts a 60-character Qubic
  identity, a 64-character hex string, or a `Uint8Array`. Decoding returns a
  60-character Qubic identity by default, or lowercase hex when
  `idFormat: "hex"` (or a custom hook) is configured.
- Enums decode to numbers by default, or to their labels when
  `enumFormat: "name"` is set. Unknown enum values remain numbers so decoding
  never loses information.
- Notification-only procedures have `inputType: null` and cannot be invoked by
  users.

## Generation

The package is regenerated weekly from `qubic/core`, every Wednesday at 12:00
UTC. Each release records the resolved commit SHA and commit date in
`ContractMetadata.source`, so the exact upstream revision is always known.

To regenerate locally:

```bash
bun run generate
```

The generator writes `src/generated/*.ts` and updates the fixtures used by the
codec tests. Do not edit generated files by hand.

## Development

```bash
bun install
bun run typecheck
bun test
bun run build
bun run check
```

Available scripts:

| Script | Description |
| --- | --- |
| `bun run build` | Emit `dist/` with TypeScript declarations |
| `bun run lint` | Lint with Biome |
| `bun run format` | Format with Biome |
| `bun run typecheck` | Type check with `tsc --noEmit` |
| `bun test` | Run the test suite |
| `bun run check` | Biome, typecheck, tests, build, and Node import smoke test |
| `bun run check:fix` | Apply Biome formatting and lint fixes |
| `bun run generate` | Regenerate contract metadata from `qubic/core` |
| `bun run changeset` | Add a changeset |
| `bun run audit` | Audit dependencies at the high severity level |

Commits follow Conventional Commits with a required lowercase scope, for
example `feat(codec): add uint128 support`.

## Release process

Releases are managed with Changesets.

1. Add a changeset for user-visible changes with `bun run changeset`.
2. Open a pull request. CI validates commit messages, type checks, tests,
   builds, audits dependencies, and verifies the package contents.
3. On `main`, the release workflow opens or updates a version packages pull
   request when pending changesets exist.
4. When that pull request merges, the workflow publishes the unpublished
   version to npm, pushes the git tag, and creates a GitHub release.

Publishing requires the `NPM_TOKEN` repository secret.

## License

MIT
