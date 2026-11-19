/**
 * `@glyph-oss/contracts` runtime entry point.
 *
 * The committed generated modules provide the default qubic/core ABI. The
 * lookup, registry, and codec helpers also accept a {@link ContractMetadata}
 * document, so applications can load a different ABI revision at runtime.
 */

export type {
	CallInput,
	CallName,
	CallOutput,
	CallShape,
	ContractHandle,
	ContractShape,
	StructNamespace,
} from './abi.js'
export {
	createContractHandle,
	createStructNamespace,
	defineContract,
} from './abi.js'
export type {
	AbiContext,
	DecodeStructOptions,
	EncodeStructOptions,
} from './codec.js'
export {
	decodeCallOutput,
	decodeContractCall,
	decodeFields,
	decodeFunctionOutput,
	decodeProcedureOutput,
	decodeStruct,
	encodeCallInput,
	encodeContractCall,
	encodeFields,
	encodeFunctionInput,
	encodePayloadHex,
	encodeProcedureInput,
	encodeStruct,
	getStructSize,
} from './codec.js'

export * from './errors.js'
export { ABI_HASH } from './generated/abi-hash.js'
export * from './generated/qpi.js'
export * from './generated/types.js'
export * from './identity.js'
export type {
	CallKind,
	ContractSelector,
} from './lookup.js'
export {
	ContractLookup,
	createContractLookup,
	findContract,
	findContractByAssetName,
	findContractByIndex,
	findContractByName,
	getCall,
	getCallByName,
	getCalls,
	getFunction,
	getNotification,
	getProcedure,
	listCalls,
	validateMetadata,
} from './lookup.js'
export * from './metadata.js'
export type { ContractIndex } from './registry.js'
export {
	ContractRegistry,
	createContractIndex,
	createContractRegistry,
	getContract,
	requireContract,
} from './registry.js'
export * from './types.js'
