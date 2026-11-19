# @glyph-oss/contracts

Typed Qubic contract metadata, ABI descriptors, and binary codecs for
TypeScript. The package is generated from
[`qubic/core`](https://github.com/qubic/core) and ships the exact memory layout
used by every Qubic contract on chain.

- Metadata for every production contract, including procedures, functions,
  notifications, all decodable structs, and enums.
- Shared QPI types such as `QPI::Entity`, proposal data, and price oracle
  payloads.
- Typed handles such as `QX` and `QUTIL` with call-name and input checking.
- Encoders and decoders for procedure inputs, procedure outputs, function
  inputs, and function outputs.
- Natural C++ alignment and padding, including trailing struct padding.
- `bigint` for 64-bit and 128-bit integers, `number` for smaller integers,
  `boolean` for `bool` and `bit`.
- Identity conversion through `@qubic.org/crypto`, so Qubic identities can be
  converted to and from 32-byte public keys without hand-rolled K12 code.
- ESM only, Node 18+ and Bun 1.1+.

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
import {
	CONTRACTS,
	contracts,
	getContractDefinition,
	getContractHandle,
} from '@glyph-oss/contracts'

const qx = getContractDefinition('QX')
const qxHandle = getContractHandle(1)

console.log(qx.index, qx.assetName)
console.log(qx.procedures.map((call) => call.name))
console.log(contracts.QX === qxHandle)
console.log(CONTRACTS.length)
```

Names and asset names are matched case-insensitively. `contracts` is a typed
map keyed by canonical contract name, and `getContractHandle` narrows to the
generated per-contract type.

### Encode and decode calls with a typed handle

```ts
import { QX } from '@glyph-oss/contracts'

const payload = QX.encodeProcedure('IssueAsset', {
	assetName: 1n,
	numberOfShares: 1_000_000n,
	unitOfMeasurement: 1n,
	numberOfDecimalPlaces: 0,
})

// `outputBytes` is the raw output struct returned by the contract.
const issued = QX.decodeProcedureOutput('IssueAsset', outputBytes)
console.log(issued.issuedNumberOfShares)

const fees = QX.decodeFunctionOutput('Fees', feesBytes)
console.log(fees.assetIssuanceFee, fees.transferFee, fees.tradeFee)
```

`encodeProcedure` and `encodeFunction` return the serialized input payload
exactly as it must be passed to `qpi.transfer` / `qpi.invoke`. The payload
includes ABI padding.

### Work with metadata and ordinals

```ts
import {
	decodeProcedureOutput,
	encodeContractCall,
	getContractDefinition,
} from '@glyph-oss/contracts'

const qx = getContractDefinition('QX')
const call = qx.procedures.find((candidate) => candidate.name === 'IssueAsset')

if (!call) {
	throw new Error('QX.IssueAsset was not found')
}

const encoded = encodeContractCall(qx, call, {
	assetName: 1n,
	numberOfShares: 1_000_000n,
	unitOfMeasurement: 1n,
	numberOfDecimalPlaces: 0,
})

console.log(encoded.inputType, encoded.inputSize, encoded.payload)
const decoded = decodeProcedureOutput(qx, call.inputType, outputBytes, {
	enumFormat: 'name',
})
```

Use the low-level helpers when contract ordinals are loaded from an external
source. The typed handles are preferred for application code.

### Encode and decode standalone structs

```ts
import {
	decodeStruct,
	encodeStruct,
	getContractDefinition,
} from '@glyph-oss/contracts'

const qx = getContractDefinition('QX')
const order = qx.structs['QX::AssetAskOrders_output::Order']

if (!order) {
	throw new Error('QX order struct was not found')
}

const bytes = encodeStruct(qx, order.fields, {
	entity: new Uint8Array(32),
	price: 10n,
	numberOfShares: 4n,
})
const value = decodeStruct(qx, order.fields, bytes)
```

### Decode shared QPI structs

```ts
import { qpi } from '@glyph-oss/contracts'

const entityBytes = qpi.encode('Entity', {
	publicKey: new Uint8Array(32),
	incomingAmount: 42n,
	outgoingAmount: 7n,
})

const entity = qpi.decode('QPI::Entity', entityBytes, { idFormat: 'hex' })
console.log(entity.incomingAmount)
console.log(qpi.size('QPI::ProposalDataV1'))
```

`qpi` resolves qualified names such as `QPI::ProposalDataV1` and short names
such as `ProposalDataV1`. Contract handles expose every struct declared in
their header, including state and local structs, through `contract.structs`.

State structs that embed template-only containers such as `HashMap`,
`HashSet`, `Collection`, or `Logger` are skipped because their layout depends
on a template instantiation. The generator prints one warning per contract
when that happens.

## Codec semantics

Qubic serializes contract structs as raw C++ memory. The codec preserves that
layout instead of using a compact canonical encoding.

- `offset`, `byteLength`, and `alignment` always describe the compiled C++
  layout. Padding bytes are encoded and decoded as part of the struct.
- `uint64`, `sint64`, `uint128`, and `sint128` values use `bigint`. Smaller
  integer fields use `number`.
- `bit` and `bool` use `boolean`.
- Fixed-size `Array<T, N>` fields are expanded into `N` elements. Arrays of
  arrays are outside the supported QPI subset.
- `id` fields are 32-byte public keys. Encoding accepts a 60-character Qubic
  identity, a 64-character hex string, or a `Uint8Array`. Decoding returns a
  60-character Qubic identity by default, or lowercase hex when
  `idFormat: 'hex'` is set.
- Enums decode to numbers by default, or to their labels when
  `enumFormat: 'name'` is set. Unknown enum values remain numbers so decoding
  never loses information.
- Notification-only procedures have `inputType: null` and cannot be invoked by
  users.

## Generation

The package is regenerated from `qubic/core` every Wednesday at 12:00 UTC by
the `Generate ABI` workflow. The workflow opens a pull request only when the
ABI hash changes, so source-only commits do not create release noise.

`ContractMetadata.source` records the resolved upstream commit and commit date
for the ABI that is checked in. `ABI_HASH` covers only the ABI, not provenance,
and can be used to detect layout changes.

To regenerate locally:

```bash
bun run generate
```

Use a local checkout instead of the network:

```bash
QUBIC_CORE_DIR=../core bun run generate
```

Set `QUBIC_CORE_REF` to pin a branch, tag, or commit. The generator writes
`src/generated/*.ts`; do not edit those files by hand.

## Development

```bash
bun install
bun run check
```

Available scripts:

| Script              | Description                                               |
| ------------------- | --------------------------------------------------------- |
| `bun run clean`     | Remove `dist/`                                            |
| `bun run build`     | Emit `dist/` with TypeScript declarations                 |
| `bun run lint`      | Check formatting and lint rules with Biome                |
| `bun run format`    | Format with Biome                                         |
| `bun run typecheck` | Type check with `tsc --noEmit`                            |
| `bun test`          | Run the test suite                                        |
| `bun run check`     | Lint, type check, test, build, and Node import smoke test |
| `bun run check:fix` | Apply Biome formatting and safe fixes                     |
| `bun run generate`  | Regenerate contract metadata from `qubic/core`            |
| `bun run changeset` | Add a changeset                                           |
| `bun run audit`     | Audit dependencies at the high severity level             |

Commits follow Conventional Commits with a required lowercase scope, for
example `feat(codec): add uint128 support`.

## Release process

Releases are managed with Changesets.

1. Add a changeset for user-visible changes with `bun run changeset`.
2. Open a pull request. CI validates commit messages, lint, types, tests,
   builds, audits dependencies, and verifies the package contents.
3. On `main`, the release workflow opens or updates a version packages pull
   request when pending changesets exist.
4. When that pull request merges, the workflow publishes the unpublished
   version to npm, pushes the git tag, and creates a GitHub release.

Publishing requires the `NPM_TOKEN` repository secret.

## License

MIT
