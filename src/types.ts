/**
 * ABI metadata shared by the generator, the runtime codec, and consumers.
 *
 * Qubic contracts are C++ structs. Their wire format is the raw in-memory
 * layout produced by the compiler: fields are naturally aligned and padding
 * bytes are part of the struct size. `offset` and `byteLength` below always
 * describe that real layout.
 */

/** Scalar ABI field kinds. */
export type ScalarFieldKind =
	| 'uint8'
	| 'sint8'
	| 'uint16'
	| 'sint16'
	| 'uint32'
	| 'sint32'
	| 'uint64'
	| 'sint64'
	| 'uint128'
	| 'id'
	| 'bit'
	| 'bool'

export type ContractFieldKind = ScalarFieldKind | 'enum' | 'struct' | 'array'

export interface ContractEnumValue {
	name: string
	value: number
}

export interface ContractEnum {
	/** Qualified name, e.g. `QtryEventStatus`. */
	name: string
	/** Underlying integer type, e.g. `uint8`. */
	underlyingType: ScalarFieldKind
	/** Size in bytes of the underlying integer type. */
	byteLength: number
	values: ContractEnumValue[]
}

export interface ContractArrayInfo {
	/** Number of elements in the fixed-size QPI Array. */
	length: number
	/** Kind of each element. Arrays of arrays are not part of the QPI subset. */
	itemType: Exclude<ContractFieldKind, 'array'>
	/** Byte footprint of one element. */
	itemByteLength: number
	/** Qualified struct name when `itemType` is `struct`. */
	itemStructRef?: string
	/** Qualified enum name when `itemType` is `enum`. */
	itemEnumRef?: string
}

export interface ContractField {
	name: string
	type: ContractFieldKind
	/** Byte offset from the start of the enclosing struct. */
	offset: number
	/** Total footprint of the field, including array elements. */
	byteLength: number
	/** Qualified struct name when `type` is `struct`. */
	structRef?: string
	/** Qualified enum name when `type` is `enum`. */
	enumRef?: string
	/** Element metadata when `type` is `array`. */
	array?: ContractArrayInfo
	/** Doc comment attached to the field, if the contract author wrote one. */
	description?: string
}

export interface ContractStruct {
	/** Qualified name, e.g. `Qx::AssetAskOrders_output::Order` or `QPI::Asset`. */
	name: string
	fields: ContractField[]
	/** `sizeof(struct)`, including trailing padding. */
	byteLength: number
	/** `alignof(struct)`. */
	alignment: number
}

export type ContractCallKind = 'procedure' | 'function' | 'notification'

export interface ContractCall {
	kind: ContractCallKind
	name: string
	/**
	 * Registered `inputType` used in transactions and contract-function
	 * requests. `null` for notification-only procedures, which cannot be
	 * invoked by users.
	 */
	inputType: number | null
	inputSize: number
	outputSize: number
	inputAlignment: number
	outputAlignment: number
	inputFields: ContractField[]
	outputFields: ContractField[]
	/** Doc comment attached to the call, if present. */
	description?: string
}

export interface ContractSourceReference {
	/** Path inside the qubic/core repository. */
	path: string
	/** 1-based line of the contract struct declaration. */
	line: number
}

export interface ContractDefinition {
	/** Contract index used on-chain and in `SELF` / destination identities. */
	index: number
	/**
	 * Canonical contract name from `CONTRACT_STATE_TYPE` in
	 * `src/contract_core/contract_def.h`, e.g. `MLM`, `SWATCH`, `WOLFPACK`.
	 */
	name: string
	/** Asset name from `contractDescriptions`, e.g. `MLM`, `SWATCH`, `GGWP`. */
	assetName: string
	/** Deterministic 60-character identity derived from the contract index. */
	contractAddress: string
	/** Header file name, e.g. `MyLastMatch.h`. */
	fileName: string
	/** Epoch in which the contract was constructed, when known. */
	constructionEpoch: number | null
	/** Epoch in which the contract is destroyed, when known. */
	destructionEpoch: number | null
	/** Compiled state size when the generator can compute it, else `null`. */
	stateSize: number | null
	source: ContractSourceReference
	procedures: ContractCall[]
	functions: ContractCall[]
	notifications: ContractCall[]
	/** Every decodable struct declared by this contract, keyed by qualified name. */
	structs: Record<string, ContractStruct>
	/** Enums declared or referenced by this contract, keyed by qualified name. */
	enums: Record<string, ContractEnum>
}

export interface ContractSourceMetadata {
	repository: 'qubic/core'
	/** Git ref used for generation, usually `main`. */
	ref: string
	/** Resolved commit SHA. */
	commit: string
	/** Commit author date in ISO 8601 form. */
	commitDate: string
}

/** Struct and enum definitions shared outside a single contract. */
export interface StructScope {
	/** Structs keyed by qualified name, e.g. `QPI::Entity`. */
	structs: Record<string, ContractStruct>
	/** Enums keyed by qualified name, e.g. `QPI::ProposalTypes`. */
	enums: Record<string, ContractEnum>
}

export interface ContractMetadata {
	schemaVersion: 1
	source: ContractSourceMetadata
	/** Shared QPI types that are not owned by a single contract. */
	qpi?: StructScope
	contracts: ContractDefinition[]
}

export interface EncodedContractCall {
	contractIndex: number
	inputType: number
	/** Serialized input struct, including ABI padding. */
	payload: Uint8Array
	/** `payload.byteLength`. */
	inputSize: number
}

export interface EncodeOptions {
	/**
	 * Convert a 60-character Qubic identity into a 32-byte public key.
	 * When omitted, identities are decoded as base-26 (checksum bytes are
	 * ignored) and 64-character hex strings / 32-byte arrays are accepted.
	 */
	identityToPublicKey?: (identity: string) => Uint8Array
}

export interface DecodeOptions {
	/**
	 * Convert a 32-byte public key into a 60-character Qubic identity.
	 * When omitted, `id` fields are returned as 60-character identities.
	 */
	publicKeyToIdentity?: (publicKey: Uint8Array) => string
	/** Return `id` fields as identities (default) or lowercase hex. */
	idFormat?: 'identity' | 'hex'
	/**
	 * Return enum labels instead of numeric values. Unknown values stay
	 * numeric so decoding never loses information.
	 */
	enumFormat?: 'number' | 'name'
}

export type DecodedScalar = number | bigint | boolean | string
export type DecodedValue =
	| DecodedScalar
	| Uint8Array
	| DecodedValue[]
	| { [field: string]: DecodedValue }

export type DecodedStruct = Record<string, DecodedValue>
export type EncodableValue =
	| number
	| bigint
	| boolean
	| string
	| Uint8Array
	| readonly EncodableValue[]
	| { readonly [field: string]: EncodableValue }

export class ContractAbiError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options)
		this.name = 'ContractAbiError'
	}
}
