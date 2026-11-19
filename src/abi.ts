/**
 * Typed contract handles.
 *
 * `defineContract` binds a runtime {@link ContractDefinition} to a compile-time
 * shape. The shape lists procedures/functions and their input/output types so
 * call names and inputs are checked by TypeScript while the payload remains
 * plain binary data.
 */

import type { DecodeStructOptions, EncodeStructOptions } from './codec.js'
import {
	decodeCallOutput,
	decodeStruct,
	encodeCallInput,
	encodeStruct,
} from './codec.js'
import { EntryNotFoundError, StructNotFoundError } from './errors.js'
import type {
	ContractCall,
	ContractDefinition,
	ContractEnum,
	ContractStruct,
	DecodedStruct,
	DecodeOptions,
	EncodableValue,
	EncodeOptions,
	StructScope,
} from './types.js'

/** Per-call input/output description used by {@link ContractShape}. */
export interface CallShape {
	input?: unknown
	output?: unknown
}

/** Compile-time description of a contract's procedures and functions. */
export interface ContractShape {
	procedures?: Record<string, CallShape>
	functions?: Record<string, CallShape>
}

type CallSection<
	S extends ContractShape,
	K extends 'procedures' | 'functions',
> = K extends keyof S
	? NonNullable<S[K]> extends Record<string, CallShape>
		? NonNullable<S[K]>
		: Record<string, CallShape>
	: Record<string, CallShape>

/** Names of one call section, e.g. all procedure names in the shape. */
export type CallName<
	S extends ContractShape,
	K extends 'procedures' | 'functions',
> = Extract<keyof CallSection<S, K>, string>

/** Input type for one call in a shape, falling back to any encodable value. */
export type CallInput<
	S extends ContractShape,
	K extends 'procedures' | 'functions',
	N extends CallName<S, K>,
> = N extends keyof CallSection<S, K>
	? CallSection<S, K>[N] extends { input: infer I }
		? I
		: EncodableValue
	: EncodableValue

/** Output type for one call in a shape, falling back to a decoded struct. */
export type CallOutput<
	S extends ContractShape,
	K extends 'procedures' | 'functions',
	N extends CallName<S, K>,
> = N extends keyof CallSection<S, K>
	? CallSection<S, K>[N] extends { output: infer O }
		? O
		: DecodedStruct
	: DecodedStruct

/** Public handle returned by {@link defineContract}. */
export interface ContractHandle<S extends ContractShape = ContractShape> {
	/** On-chain contract index. */
	readonly contractIndex: number
	/** Canonical contract name. */
	readonly name: string
	/** Asset name. */
	readonly assetName: string
	/** Deterministic 60-character contract identity. */
	readonly contractAddress: string
	/** Full metadata used by the handle. */
	readonly definition: ContractDefinition
	/** Procedure metadata keyed by call name. */
	readonly procedures: Readonly<Record<string, ContractCall>>
	/** Function metadata keyed by call name. */
	readonly functions: Readonly<Record<string, ContractCall>>
	/** Notification metadata keyed by call name. */
	readonly notifications: Readonly<Record<string, ContractCall>>

	/** Encode a procedure input struct. */
	encodeProcedure<N extends CallName<S, 'procedures'>>(
		name: N,
		input: CallInput<S, 'procedures', N>,
		options?: EncodeOptions,
	): Uint8Array
	/** Decode a procedure output struct. */
	decodeProcedureOutput<N extends CallName<S, 'procedures'>>(
		name: N,
		data: Uint8Array,
		options?: DecodeOptions,
	): CallOutput<S, 'procedures', N>

	/** Encode a function input struct. */
	encodeFunction<N extends CallName<S, 'functions'>>(
		name: N,
		input: CallInput<S, 'functions', N>,
		options?: EncodeOptions,
	): Uint8Array
	/** Decode a function output struct. */
	decodeFunctionOutput<N extends CallName<S, 'functions'>>(
		name: N,
		data: Uint8Array,
		options?: DecodeOptions,
	): CallOutput<S, 'functions', N>

	/**
	 * Loose alias that resolves a call name across procedures and functions.
	 * Prefer {@link ContractHandle.encodeProcedure} /
	 * {@link ContractHandle.encodeFunction} for typed input checking.
	 */
	encodeInput(
		name: string,
		input: EncodableValue,
		options?: EncodeOptions,
	): Uint8Array
	/** Loose alias that resolves a call name across procedures and functions. */
	decodeOutput(
		name: string,
		data: Uint8Array,
		options?: DecodeOptions,
	): DecodedStruct
}

function toCallMap(
	calls: readonly ContractCall[],
): Readonly<Record<string, ContractCall>> {
	const map: Record<string, ContractCall> = {}
	for (const call of calls) {
		map[call.name] = call
	}
	return Object.freeze(map)
}

function requireCall(
	definition: ContractDefinition,
	map: Readonly<Record<string, ContractCall>>,
	kind: 'procedure' | 'function',
	name: string,
): ContractCall {
	const call = map[name]
	if (!call) {
		throw new EntryNotFoundError(definition.name, kind, { name })
	}
	return call
}

/**
 * Bind a runtime contract definition to a typed shape.
 *
 * ```ts
 * type Shape = {
 *   procedures: { transfer: { input: { to: string; amount: bigint }; output: {} } }
 *   functions: {}
 * }
 * const handle = defineContract<Shape>(definition)
 * handle.encodeProcedure('transfer', { to, amount: 10n })
 * ```
 */
export function defineContract<S extends ContractShape = ContractShape>(
	definition: ContractDefinition,
): ContractHandle<S> {
	const procedures = toCallMap(definition.procedures)
	const functions = toCallMap(definition.functions)
	const notifications = toCallMap(definition.notifications)

	const handle: ContractHandle<S> = {
		contractIndex: definition.index,
		name: definition.name,
		assetName: definition.assetName,
		contractAddress: definition.contractAddress,
		definition,
		procedures,
		functions,
		notifications,

		encodeProcedure(name, input, options) {
			const call = requireCall(definition, procedures, 'procedure', name)
			return encodeCallInput(definition, call, input as object, options).payload
		},

		decodeProcedureOutput(name, data, options) {
			const call = requireCall(definition, procedures, 'procedure', name)
			return decodeCallOutput(definition, call, data, options) as CallOutput<
				S,
				'procedures',
				typeof name
			>
		},

		encodeFunction(name, input, options) {
			const call = requireCall(definition, functions, 'function', name)
			return encodeCallInput(definition, call, input as object, options).payload
		},

		decodeFunctionOutput(name, data, options) {
			const call = requireCall(definition, functions, 'function', name)
			return decodeCallOutput(definition, call, data, options) as CallOutput<
				S,
				'functions',
				typeof name
			>
		},

		encodeInput(name, input, options) {
			const call = procedures[name] ?? functions[name] ?? notifications[name]
			if (!call) {
				throw new EntryNotFoundError(definition.name, 'procedure', { name })
			}
			return encodeCallInput(definition, call, input as object, options).payload
		},

		decodeOutput(name, data, options) {
			const call = procedures[name] ?? functions[name] ?? notifications[name]
			if (!call) {
				throw new EntryNotFoundError(definition.name, 'procedure', { name })
			}
			return decodeCallOutput(definition, call, data, options)
		},
	}

	return handle
}

/** Convenience alias for {@link defineContract}. */
export const createContractHandle = defineContract

/** A named set of structs and enums that can be encoded and decoded. */
export interface StructNamespace {
	/** Scope name used in error messages, e.g. `QPI`. */
	readonly name: string
	/** Synthetic definition used to resolve nested struct and enum references. */
	readonly definition: ContractDefinition
	/** Structs keyed by qualified name. */
	readonly structs: Readonly<Record<string, ContractStruct>>
	/** Enums keyed by qualified name. */
	readonly enums: Readonly<Record<string, ContractEnum>>
	/** Whether a struct can be resolved by qualified or short name. */
	hasStruct(name: string): boolean
	/** Resolve a struct by qualified or short name, throwing when absent. */
	getStruct(name: string): ContractStruct
	/** Encode one struct, including C++ padding. */
	encode(
		name: string,
		value: object | Uint8Array,
		options?: EncodeStructOptions,
	): Uint8Array
	/** Decode one struct, including C++ padding. */
	decode(
		name: string,
		data: Uint8Array,
		options?: DecodeStructOptions,
	): DecodedStruct
	/** Natural byte size of a struct. */
	size(name: string): number
}

/**
 * Bind a {@link StructScope} to encode/decode helpers.
 *
 * Generated code uses this for shared QPI types; it also works with a custom
 * scope when an application loads ABI metadata at runtime.
 */
export function createStructNamespace(
	name: string,
	scope: StructScope | undefined,
): StructNamespace {
	const structs = scope?.structs ?? {}
	const enums = scope?.enums ?? {}
	const definition: ContractDefinition = {
		index: 0,
		name,
		assetName: name,
		contractAddress: '',
		fileName: '',
		constructionEpoch: null,
		destructionEpoch: null,
		stateSize: null,
		source: { path: '', line: 0 },
		procedures: [],
		functions: [],
		notifications: [],
		structs,
		enums,
	}

	const resolve = (structName: string): ContractStruct => {
		const direct = structs[structName]
		if (direct !== undefined) return direct
		const qualified = structs[`${name}::${structName}`]
		if (qualified !== undefined) return qualified
		for (const [key, struct] of Object.entries(structs)) {
			if (key.endsWith(`::${structName}`)) return struct
		}
		throw new StructNotFoundError(name, structName)
	}

	return {
		name,
		definition,
		structs,
		enums,
		hasStruct(structName) {
			try {
				resolve(structName)
				return true
			} catch (error) {
				if (error instanceof StructNotFoundError) return false
				throw error
			}
		},
		getStruct: resolve,
		encode(structName, value, options) {
			const struct = resolve(structName)
			return encodeStruct(definition, struct.fields, value, {
				...options,
				alignment: struct.alignment,
				size: struct.byteLength,
			})
		},
		decode(structName, data, options) {
			const struct = resolve(structName)
			return decodeStruct(definition, struct.fields, data, {
				...options,
				alignment: struct.alignment,
				size: struct.byteLength,
			})
		},
		size(structName) {
			return resolve(structName).byteLength
		},
	}
}

export { decodeCallOutput, encodeCallInput }
