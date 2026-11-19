import { PayloadBuildError, PayloadDecodeError } from './errors.ts'
import {
	bytesToHex,
	identityToPublicKey as defaultIdentityToPublicKey,
	publicKeyToIdentity as defaultPublicKeyToIdentity,
} from './identity.ts'
import { getFunction, getProcedure } from './lookup.ts'
import type {
	ContractArrayInfo,
	ContractCall,
	ContractDefinition,
	ContractEnum,
	ContractField,
	ContractStruct,
	DecodedStruct,
	DecodedValue,
	DecodeOptions,
	EncodableValue,
	EncodedContractCall,
	EncodeOptions,
	ScalarFieldKind,
} from './types.ts'

/** Struct and enum maps needed to encode or decode nested values. */
export type AbiContext = Pick<ContractDefinition, 'structs' | 'enums'>

type StructuredValue = {
	readonly [field: string]: EncodableValue
}

const UINT8_MAX = 0xff
const UINT16_MAX = 0xffff
const UINT32_MAX = 0xffff_ffff
const UINT64_MAX = (1n << 64n) - 1n
const INT64_MIN = -(1n << 63n)
const INT64_MAX = (1n << 63n) - 1n
const UINT128_MAX = (1n << 128n) - 1n

const HEX_PUBLIC_KEY = /^(?:0x)?[0-9a-fA-F]{64}$/

/**
 * Encodes named values into the fixed binary layout described by `fields`.
 *
 * Every field is written at its declared `offset`, so compiler padding between
 * fields stays zero. Missing values throw; the returned buffer length is the
 * highest field end, not necessarily a call's `inputSize` (which can include
 * trailing padding). Use {@link encodeContractCall} for call payloads.
 */
export function encodeFields(
	fields: ContractField[],
	context: AbiContext,
	input: Record<string, EncodableValue>,
	options: EncodeOptions = {},
): Uint8Array {
	const size = requiredSize(fields, 'payload')
	const buffer = new Uint8Array(size)
	encodeFieldsInto(fields, context, input, buffer, options, 'payload')
	return buffer
}

/**
 * Decodes binary data using the fixed layout described by `fields`.
 *
 * `id` fields are formatted by `options.publicKeyToIdentity` when supplied and
 * as lowercase hex otherwise. `enum` fields decode to their label only when
 * `options.enumFormat` is `"name"`; unknown values always stay numeric.
 */
export function decodeFields(
	data: Uint8Array,
	fields: ContractField[],
	context: AbiContext,
	options: DecodeOptions = {},
): DecodedStruct {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
	const result: DecodedStruct = {}

	for (const field of fields) {
		assertReadable(data, field, 'payload')
		result[field.name] = decodeField(
			field,
			data,
			view,
			field.offset,
			context,
			options,
			'payload',
		)
	}

	return result
}

/** Encodes one procedure or function input into a call payload. */
export function encodeContractCall(
	contract: ContractDefinition,
	call: ContractCall,
	input: Record<string, EncodableValue>,
	options: EncodeOptions = {},
): EncodedContractCall {
	if (call.inputType === null) {
		throw new PayloadBuildError(
			`${call.kind} "${call.name}" has no inputType and cannot be called`,
		)
	}

	const payload = new Uint8Array(call.inputSize)
	encodeFieldsInto(
		call.inputFields,
		contract,
		input,
		payload,
		options,
		`${call.kind} "${call.name}" input`,
	)

	return {
		contractIndex: contract.index,
		inputType: call.inputType,
		payload,
		inputSize: payload.byteLength,
	}
}

/** Decodes a procedure or function output. */
export function decodeContractCall(
	contract: ContractDefinition,
	call: ContractCall,
	data: Uint8Array,
	options: DecodeOptions = {},
): DecodedStruct {
	return decodeCallOutput(contract, call, data, options)
}

/** Encodes a procedure input selected by its registered ordinal. */
export function encodeProcedureInput(
	contract: ContractDefinition,
	inputType: number,
	input: Record<string, EncodableValue>,
	options: EncodeOptions = {},
): EncodedContractCall {
	return encodeContractCall(
		contract,
		getProcedure(contract, inputType),
		input,
		options,
	)
}

/** Encodes a read-only function input selected by its registered ordinal. */
export function encodeFunctionInput(
	contract: ContractDefinition,
	inputType: number,
	input: Record<string, EncodableValue>,
	options: EncodeOptions = {},
): EncodedContractCall {
	return encodeContractCall(
		contract,
		getFunction(contract, inputType),
		input,
		options,
	)
}

/** Decodes a procedure output selected by its registered ordinal. */
export function decodeProcedureOutput(
	contract: ContractDefinition,
	inputType: number,
	data: Uint8Array,
	options: DecodeOptions = {},
): DecodedStruct {
	return decodeContractCall(
		contract,
		getProcedure(contract, inputType),
		data,
		options,
	)
}

/** Decodes a read-only function output selected by its registered ordinal. */
export function decodeFunctionOutput(
	contract: ContractDefinition,
	inputType: number,
	data: Uint8Array,
	options: DecodeOptions = {},
): DecodedStruct {
	return decodeContractCall(
		contract,
		getFunction(contract, inputType),
		data,
		options,
	)
}

function encodeFieldsInto(
	fields: ContractField[],
	context: AbiContext,
	input: Record<string, EncodableValue>,
	buffer: Uint8Array,
	options: EncodeOptions,
	label: string,
): void {
	const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)

	for (const field of fields) {
		assertWritable(buffer, field, label)
		// Missing fields keep their zero-filled value. This matches C++ default
		// initialisation and makes fixed-array tails easy to omit.
		if (!(field.name in input)) continue
		encodeField(
			field,
			input[field.name] as EncodableValue,
			buffer,
			view,
			field.offset,
			context,
			options,
			`${label}.${field.name}`,
		)
	}
}

function encodeField(
	field: ContractField,
	value: EncodableValue,
	buffer: Uint8Array,
	view: DataView,
	offset: number,
	context: AbiContext,
	options: EncodeOptions,
	label: string,
): void {
	if (value instanceof Uint8Array && field.type !== 'id') {
		if (value.byteLength !== field.byteLength) {
			throw new PayloadBuildError(
				`${label}: raw bytes must be exactly ${field.byteLength} bytes, got ${value.byteLength}`,
			)
		}
		buffer.set(value, offset)
		return
	}

	switch (field.type) {
		case 'uint8':
		case 'sint8':
		case 'uint16':
		case 'sint16':
		case 'uint32':
		case 'sint32':
		case 'uint64':
		case 'sint64':
		case 'uint128':
		case 'bit':
		case 'bool':
			encodeScalar(field.type, value, buffer, view, offset, label)
			return
		case 'id': {
			buffer.set(encodeId(value, options, label), offset)
			return
		}
		case 'enum': {
			const enumDef = requireEnum(context, field.enumRef, label, 'build')
			encodeEnum(enumDef, value, buffer, view, offset, label)
			return
		}
		case 'struct': {
			const struct = requireStruct(context, field.structRef, label, 'build')
			if (field.byteLength !== struct.byteLength) {
				throw new PayloadBuildError(
					`${label}: byteLength ${field.byteLength} !== struct byteLength ${struct.byteLength}`,
				)
			}
			encodeStructValue(
				struct,
				value,
				buffer,
				view,
				offset,
				context,
				options,
				label,
			)
			return
		}
		case 'array': {
			encodeArray(field, value, buffer, view, offset, context, options, label)
			return
		}
		default: {
			throw new PayloadBuildError(
				`${label}: unknown field type "${String(field.type)}"`,
			)
		}
	}
}

function encodeStructValue(
	struct: ContractStruct,
	value: EncodableValue,
	buffer: Uint8Array,
	view: DataView,
	offset: number,
	context: AbiContext,
	options: EncodeOptions,
	label: string,
): void {
	if (
		typeof value !== 'object' ||
		value === null ||
		Array.isArray(value) ||
		value instanceof Uint8Array
	) {
		throw new PayloadBuildError(`${label}: expected an object for struct`)
	}
	const input = value as StructuredValue
	for (const field of struct.fields) {
		assertWritable(buffer, field, label, offset)
		if (!(field.name in input)) continue
		encodeField(
			field,
			input[field.name] as EncodableValue,
			buffer,
			view,
			offset + field.offset,
			context,
			options,
			`${label}.${field.name}`,
		)
	}
}

function encodeArray(
	field: ContractField,
	value: EncodableValue,
	buffer: Uint8Array,
	view: DataView,
	offset: number,
	context: AbiContext,
	options: EncodeOptions,
	label: string,
): void {
	const array = field.array
	if (!array) {
		throw new PayloadBuildError(`${label}: missing array metadata`)
	}
	if (!Array.isArray(value)) {
		throw new PayloadBuildError(`${label}: expected an array`)
	}
	if (value.length > array.length) {
		throw new PayloadBuildError(
			`${label}: expected at most ${array.length} items, got ${value.length}`,
		)
	}

	for (let index = 0; index < array.length; index++) {
		const itemOffset = offset + index * array.itemByteLength
		const itemLabel = `${label}[${index}]`
		const item = value[index] as EncodableValue | undefined
		if (item === undefined) continue
		if (item instanceof Uint8Array) {
			if (item.byteLength !== array.itemByteLength) {
				throw new PayloadBuildError(
					`${itemLabel}: raw bytes must be exactly ${array.itemByteLength} bytes, got ${item.byteLength}`,
				)
			}
			buffer.set(item, itemOffset)
			continue
		}
		switch (array.itemType) {
			case 'struct': {
				const struct = requireStruct(
					context,
					array.itemStructRef,
					itemLabel,
					'build',
				)
				encodeStructValue(
					struct,
					item,
					buffer,
					view,
					itemOffset,
					context,
					options,
					itemLabel,
				)
				break
			}
			case 'enum': {
				const enumDef = requireEnum(
					context,
					array.itemEnumRef,
					itemLabel,
					'build',
				)
				encodeEnum(enumDef, item, buffer, view, itemOffset, itemLabel)
				break
			}
			case 'id':
				buffer.set(encodeId(item, options, itemLabel), itemOffset)
				break
			default:
				encodeScalar(array.itemType, item, buffer, view, itemOffset, itemLabel)
		}
	}
}

function encodeId(
	value: EncodableValue,
	options: EncodeOptions,
	label: string,
): Uint8Array {
	try {
		if (value instanceof Uint8Array) {
			if (value.byteLength !== 32) {
				throw new Error('public key must be exactly 32 bytes')
			}
			return value
		}
		if (typeof value !== 'string') {
			throw new Error('expected an identity string or 32-byte public key')
		}
		if (options.identityToPublicKey) {
			const publicKey = options.identityToPublicKey(value)
			if (!(publicKey instanceof Uint8Array) || publicKey.byteLength !== 32) {
				throw new Error('identityToPublicKey must return 32 bytes')
			}
			return publicKey
		}
		// The canonical helper also accepts 64-character hex keys.
		return defaultIdentityToPublicKey(value)
	} catch (cause) {
		throw new PayloadBuildError(`${label}: invalid identity or public key`, {
			cause,
		})
	}
}

function encodeEnum(
	enumDef: ContractEnum,
	value: EncodableValue,
	buffer: Uint8Array,
	view: DataView,
	offset: number,
	label: string,
): void {
	let numeric: EncodableValue = value
	if (typeof value === 'string') {
		const entry = enumDef.values.find((candidate) => candidate.name === value)
		if (!entry) {
			throw new PayloadBuildError(
				`${label}: enum ${enumDef.name} has no "${value}"`,
			)
		}
		numeric = entry.value
	}
	if (
		typeof numeric === 'number' &&
		(enumDef.underlyingType === 'uint64' ||
			enumDef.underlyingType === 'sint64' ||
			enumDef.underlyingType === 'uint128')
	) {
		numeric = BigInt(numeric)
	}
	encodeScalar(
		enumDef.underlyingType,
		numeric,
		buffer,
		view,
		offset,
		`${label} (${enumDef.name})`,
	)
}

function encodeScalar(
	type: ScalarFieldKind,
	value: EncodableValue,
	buffer: Uint8Array,
	view: DataView,
	offset: number,
	label: string,
): void {
	switch (type) {
		case 'uint8':
			view.setUint8(offset, integerNumber(value, type, 0, UINT8_MAX, label))
			return
		case 'sint8':
			view.setInt8(offset, integerNumber(value, type, -0x80, 0x7f, label))
			return
		case 'uint16':
			view.setUint16(
				offset,
				integerNumber(value, type, 0, UINT16_MAX, label),
				true,
			)
			return
		case 'sint16':
			view.setInt16(
				offset,
				integerNumber(value, type, -0x8000, 0x7fff, label),
				true,
			)
			return
		case 'uint32':
			view.setUint32(
				offset,
				integerNumber(value, type, 0, UINT32_MAX, label),
				true,
			)
			return
		case 'sint32':
			view.setInt32(
				offset,
				integerNumber(value, type, -0x8000_0000, 0x7fff_ffff, label),
				true,
			)
			return
		case 'uint64':
			view.setBigUint64(
				offset,
				integerBigInt(value, type, 0n, UINT64_MAX, label),
				true,
			)
			return
		case 'sint64':
			view.setBigInt64(
				offset,
				integerBigInt(value, type, INT64_MIN, INT64_MAX, label),
				true,
			)
			return
		case 'uint128': {
			let remaining = integerBigInt(value, type, 0n, UINT128_MAX, label)
			for (let index = 0; index < 16; index++) {
				buffer[offset + index] = Number(remaining & 0xffn)
				remaining >>= 8n
			}
			return
		}
		case 'bit':
		case 'bool': {
			let bit: number
			if (value === true) {
				bit = 1
			} else if (value === false) {
				bit = 0
			} else if (value === 0 || value === 1) {
				bit = value
			} else {
				throw new PayloadBuildError(
					`${label}: expected boolean or 0/1 for ${type}, got ${String(value)}`,
				)
			}
			view.setUint8(offset, bit)
			return
		}
		case 'id':
			throw new PayloadBuildError(
				`${label}: id fields must be encoded through encodeField`,
			)
	}
}

function decodeField(
	field: ContractField,
	data: Uint8Array,
	view: DataView,
	offset: number,
	context: AbiContext,
	options: DecodeOptions,
	label: string,
): DecodedValue {
	switch (field.type) {
		case 'uint8':
		case 'sint8':
		case 'uint16':
		case 'sint16':
		case 'uint32':
		case 'sint32':
		case 'uint64':
		case 'sint64':
		case 'uint128':
		case 'bit':
		case 'bool':
			return decodeScalar(field.type, data, view, offset)
		case 'id':
			return decodeId(data, offset, options, label)
		case 'enum': {
			const enumDef = requireEnum(context, field.enumRef, label, 'decode')
			const numeric = decodeScalar(enumDef.underlyingType, data, view, offset)
			if (options.enumFormat === 'name') {
				const entry = enumDef.values.find(
					(candidate) =>
						BigInt(candidate.value) === BigInt(numeric as number | bigint),
				)
				if (entry) {
					return entry.name
				}
			}
			return numeric
		}
		case 'struct': {
			const struct = requireStruct(context, field.structRef, label, 'decode')
			return decodeStructValue(
				struct,
				data,
				view,
				offset,
				context,
				options,
				label,
			)
		}
		case 'array': {
			const array = field.array
			if (!array) {
				throw new PayloadDecodeError(`${label}: missing array metadata`)
			}
			const items: DecodedValue[] = []
			for (let index = 0; index < array.length; index++) {
				const itemOffset = offset + index * array.itemByteLength
				const itemLabel = `${label}[${index}]`
				switch (array.itemType) {
					case 'struct': {
						const struct = requireStruct(
							context,
							array.itemStructRef,
							itemLabel,
							'decode',
						)
						items.push(
							decodeStructValue(
								struct,
								data,
								view,
								itemOffset,
								context,
								options,
								itemLabel,
							),
						)
						break
					}
					case 'enum': {
						const enumDef = requireEnum(
							context,
							array.itemEnumRef,
							itemLabel,
							'decode',
						)
						const numeric = decodeScalar(
							enumDef.underlyingType,
							data,
							view,
							itemOffset,
						)
						if (options.enumFormat === 'name') {
							const entry = enumDef.values.find(
								(candidate) =>
									BigInt(candidate.value) ===
									BigInt(numeric as number | bigint),
							)
							if (entry) {
								items.push(entry.name)
								break
							}
						}
						items.push(numeric)
						break
					}
					case 'id':
						items.push(decodeId(data, itemOffset, options, itemLabel))
						break
					default:
						items.push(decodeScalar(array.itemType, data, view, itemOffset))
				}
			}
			return items
		}
		default:
			throw new PayloadDecodeError(
				`${label}: unknown field type "${String(field.type)}"`,
			)
	}
}

function decodeStructValue(
	struct: ContractStruct,
	data: Uint8Array,
	view: DataView,
	offset: number,
	context: AbiContext,
	options: DecodeOptions,
	label: string,
): DecodedStruct {
	const result: DecodedStruct = {}
	for (const field of struct.fields) {
		assertReadable(data, field, label, offset)
		result[field.name] = decodeField(
			field,
			data,
			view,
			offset + field.offset,
			context,
			options,
			`${label}.${field.name}`,
		)
	}
	return result
}

function decodeId(
	data: Uint8Array,
	offset: number,
	options: DecodeOptions,
	label: string,
): string {
	const publicKey = data.slice(offset, offset + 32)
	if (options.idFormat === 'hex') return bytesToHex(publicKey)
	try {
		return options.publicKeyToIdentity
			? options.publicKeyToIdentity(publicKey)
			: defaultPublicKeyToIdentity(publicKey)
	} catch (cause) {
		throw new PayloadDecodeError(`${label}: could not format identity`, {
			cause,
		})
	}
}

function decodeScalar(
	type: ScalarFieldKind,
	data: Uint8Array,
	view: DataView,
	offset: number,
): DecodedValue {
	switch (type) {
		case 'uint8':
			return view.getUint8(offset)
		case 'sint8':
			return view.getInt8(offset)
		case 'uint16':
			return view.getUint16(offset, true)
		case 'sint16':
			return view.getInt16(offset, true)
		case 'uint32':
			return view.getUint32(offset, true)
		case 'sint32':
			return view.getInt32(offset, true)
		case 'uint64':
			return view.getBigUint64(offset, true)
		case 'sint64':
			return view.getBigInt64(offset, true)
		case 'uint128': {
			let value = 0n
			for (let index = 15; index >= 0; index--) {
				value = (value << 8n) | BigInt(data[offset + index] as number)
			}
			return value
		}
		case 'bit':
		case 'bool':
			return view.getUint8(offset) !== 0
		case 'id':
			throw new PayloadDecodeError(
				'id fields must be decoded through decodeField',
			)
	}
}

function requireStruct(
	context: AbiContext,
	ref: string | undefined,
	label: string,
	mode: 'build' | 'decode',
): ContractStruct {
	const struct = ref === undefined ? undefined : context.structs[ref]
	if (!struct) {
		const message = `${label}: struct "${ref ?? ''}" not found`
		throw mode === 'build'
			? new PayloadBuildError(message)
			: new PayloadDecodeError(message)
	}
	return struct
}

function requireEnum(
	context: AbiContext,
	ref: string | undefined,
	label: string,
	mode: 'build' | 'decode',
): ContractEnum {
	const enumDef = ref === undefined ? undefined : context.enums[ref]
	if (!enumDef) {
		const message = `${label}: enum "${ref ?? ''}" not found`
		throw mode === 'build'
			? new PayloadBuildError(message)
			: new PayloadDecodeError(message)
	}
	return enumDef
}

function requiredSize(fields: ContractField[], label: string): number {
	let size = 0
	for (const field of fields) {
		if (!Number.isInteger(field.offset) || field.offset < 0) {
			throw new PayloadBuildError(
				`${label} field "${field.name}": invalid offset`,
			)
		}
		if (!Number.isInteger(field.byteLength) || field.byteLength < 0) {
			throw new PayloadBuildError(
				`${label} field "${field.name}": invalid byteLength`,
			)
		}
		size = Math.max(size, field.offset + field.byteLength)
	}
	return size
}

function assertWritable(
	buffer: Uint8Array,
	field: ContractField,
	label: string,
	baseOffset = 0,
): void {
	const end = baseOffset + field.offset + field.byteLength
	if (end > buffer.byteLength) {
		throw new PayloadBuildError(
			`${label}: field "${field.name}" ends at ${end}, beyond ${buffer.byteLength} bytes`,
		)
	}
}

function assertReadable(
	data: Uint8Array,
	field: ContractField,
	label: string,
	baseOffset = 0,
): void {
	const end = baseOffset + field.offset + field.byteLength
	if (end > data.byteLength) {
		throw new PayloadDecodeError(
			`${label}: field "${field.name}" needs ${end} bytes, got ${data.byteLength}`,
		)
	}
}

function integerNumber(
	value: EncodableValue,
	type: ScalarFieldKind,
	min: number,
	max: number,
	label: string,
): number {
	if (typeof value !== 'number' || !Number.isInteger(value)) {
		throw new PayloadBuildError(
			`${label}: expected an integer number for ${type}`,
		)
	}
	if (value < min || value > max) {
		throw new PayloadBuildError(
			`${label}: ${value} is out of range for ${type}`,
		)
	}
	return value
}

function integerBigInt(
	value: EncodableValue,
	type: ScalarFieldKind,
	min: bigint,
	max: bigint,
	label: string,
): bigint {
	let result: bigint
	if (typeof value === 'bigint') {
		result = value
	} else if (typeof value === 'number') {
		if (!Number.isSafeInteger(value)) {
			throw new PayloadBuildError(
				`${label}: number is outside the safe integer range for ${type}`,
			)
		}
		result = BigInt(value)
	} else if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) {
		result = BigInt(value.trim())
	} else {
		throw new PayloadBuildError(
			`${label}: expected a bigint, safe integer, or decimal string for ${type}`,
		)
	}
	if (result < min || result > max) {
		throw new PayloadBuildError(
			`${label}: ${result} is out of range for ${type}`,
		)
	}
	return result
}

/** Options for {@link encodeStruct}. */
export interface EncodeStructOptions extends EncodeOptions {
	/** Struct alignment. Defaults to the maximum natural field alignment. */
	alignment?: number
	/** Minimum allocation size. Must be at least the natural struct size. */
	size?: number
	/** Error path prefix. Defaults to `input`. */
	path?: string
}

/** Options for {@link decodeStruct}. */
export interface DecodeStructOptions extends DecodeOptions {
	/** Struct alignment. Defaults to the maximum natural field alignment. */
	alignment?: number
	/**
	 * Minimum required input size. Useful when a call's size is larger than the
	 * sum of its field footprints.
	 */
	size?: number
}

/**
 * Computes the on-wire size of a struct: the maximum field end rounded up to
 * the struct alignment.
 */
export function getStructSize(
	definition: ContractDefinition,
	fields: readonly ContractField[],
	alignment?: number,
): number {
	const resolved = normalizeAlignment(
		alignment ?? inferAlignment(fields, definition),
	)
	let end = 0
	for (const field of fields) {
		end = Math.max(end, field.offset + field.byteLength)
	}
	return alignUp(end, resolved)
}

/**
 * Encodes an object into the raw struct layout described by `fields`.
 *
 * The returned buffer is exactly the struct size, or `options.size` when that
 * is larger, zero-filled so alignment padding is deterministic. A `Uint8Array`
 * value of exactly the resulting size is copied verbatim.
 */
export function encodeStruct(
	definition: ContractDefinition,
	fields: readonly ContractField[],
	value: object | Uint8Array,
	options: EncodeStructOptions = {},
): Uint8Array {
	const naturalSize = getStructSize(definition, fields, options.alignment)
	const size = options.size ?? naturalSize
	if (!Number.isInteger(size) || size < naturalSize) {
		throw new PayloadBuildError(
			`Struct size ${size} is smaller than the natural size ${naturalSize}`,
		)
	}
	const buffer = new Uint8Array(size)

	if (value instanceof Uint8Array) {
		if (value.byteLength !== size) {
			throw new PayloadBuildError(
				`Raw struct bytes must be exactly ${size} bytes, got ${value.byteLength}`,
			)
		}
		buffer.set(value)
		return buffer
	}

	encodeFieldsInto(
		fields as ContractField[],
		definition,
		value as Record<string, EncodableValue>,
		buffer,
		options,
		options.path ?? 'input',
	)
	return buffer
}

/**
 * Decodes a raw struct buffer.
 *
 * Buffers larger than the struct are accepted; a buffer shorter than the
 * required size throws `PayloadDecodeError`.
 */
export function decodeStruct(
	definition: ContractDefinition,
	fields: readonly ContractField[],
	data: Uint8Array,
	options: DecodeStructOptions = {},
): DecodedStruct {
	const naturalSize = getStructSize(definition, fields, options.alignment)
	const required = Math.max(naturalSize, options.size ?? 0)
	if (data.byteLength < required) {
		throw new PayloadDecodeError(
			`Struct requires ${required} bytes, got ${data.byteLength}`,
		)
	}
	return decodeFields(data, fields as ContractField[], definition, options)
}

/** Encodes a contract call's input struct. */
export function encodeCallInput(
	definition: ContractDefinition,
	call: ContractCall | string,
	values: object = {},
	options: EncodeStructOptions = {},
): EncodedContractCall {
	const resolved = resolveCall(definition, call)
	if (resolved.kind === 'notification' || resolved.inputType === null) {
		throw new PayloadBuildError(
			`Call "${resolved.name}" is a notification and cannot be encoded for user invocation`,
		)
	}

	const naturalSize = getStructSize(
		definition,
		resolved.inputFields,
		resolved.inputAlignment,
	)
	const payload = encodeStruct(definition, resolved.inputFields, values, {
		...options,
		alignment: resolved.inputAlignment,
		size: Math.max(naturalSize, resolved.inputSize),
		path: 'input',
	})

	return {
		contractIndex: definition.index,
		inputType: resolved.inputType,
		payload,
		inputSize: payload.byteLength,
	}
}

/** Decodes a contract call's output struct. */
export function decodeCallOutput(
	definition: ContractDefinition,
	call: ContractCall | string,
	data: Uint8Array,
	options: DecodeStructOptions = {},
): DecodedStruct {
	const resolved = resolveCall(definition, call)
	const naturalSize = getStructSize(
		definition,
		resolved.outputFields,
		resolved.outputAlignment,
	)
	return decodeStruct(definition, resolved.outputFields, data, {
		...options,
		alignment: resolved.outputAlignment,
		size: Math.max(naturalSize, resolved.outputSize),
	})
}

/** Returns a hex view of an encoded struct payload. */
export function encodePayloadHex(
	definition: ContractDefinition,
	fields: readonly ContractField[],
	value: object | Uint8Array,
	options: EncodeStructOptions = {},
): string {
	return bytesToHex(encodeStruct(definition, fields, value, options))
}

function resolveCall(
	definition: ContractDefinition,
	call: ContractCall | string,
): ContractCall {
	if (typeof call !== 'string') {
		return call
	}
	const all = [
		...definition.procedures,
		...definition.functions,
		...definition.notifications,
	]
	const normalized = call.toLowerCase()
	const found =
		all.find((candidate) => candidate.name === call) ??
		all.find((candidate) => candidate.name.toLowerCase() === normalized)
	if (!found) {
		throw new PayloadBuildError(
			`Unknown call "${call}" in contract ${definition.name}`,
		)
	}
	return found
}

function alignUp(value: number, alignment: number): number {
	return Math.ceil(value / alignment) * alignment
}

function normalizeAlignment(alignment: number | undefined): number {
	if (alignment === undefined) {
		return 1
	}
	if (!Number.isInteger(alignment) || alignment <= 0) {
		throw new PayloadBuildError(`Invalid struct alignment ${alignment}`)
	}
	return alignment
}

function inferAlignment(
	fields: readonly ContractField[],
	definition: ContractDefinition,
): number {
	let alignment = 1
	for (const field of fields) {
		alignment = Math.max(alignment, fieldAlignment(field, definition))
	}
	return alignment
}

function fieldAlignment(
	field: ContractField,
	definition: ContractDefinition,
): number {
	switch (field.type) {
		case 'uint8':
		case 'sint8':
		case 'bool':
		case 'bit':
		case 'id':
			return 1
		case 'uint16':
		case 'sint16':
			return 2
		case 'uint32':
		case 'sint32':
			return 4
		case 'uint64':
		case 'sint64':
			return 8
		case 'uint128':
			return 16
		case 'enum': {
			const enumDef = definition.enums[field.enumRef ?? '']
			return enumDef ? enumDef.byteLength : 1
		}
		case 'struct': {
			const struct = definition.structs[field.structRef ?? '']
			return struct?.alignment ?? 1
		}
		case 'array':
			return field.array ? arrayItemAlignment(field.array, definition) : 1
	}
}

function arrayItemAlignment(
	array: ContractArrayInfo,
	definition: ContractDefinition,
): number {
	switch (array.itemType) {
		case 'struct':
			return definition.structs[array.itemStructRef ?? '']?.alignment ?? 1
		case 'enum':
			return definition.enums[array.itemEnumRef ?? '']?.byteLength ?? 1
		default:
			return widthAlignment(scalarWidth(array.itemType))
	}
}

function scalarWidth(type: ScalarFieldKind): number {
	switch (type) {
		case 'uint8':
		case 'sint8':
		case 'bit':
		case 'bool':
			return 1
		case 'uint16':
		case 'sint16':
			return 2
		case 'uint32':
		case 'sint32':
			return 4
		case 'uint64':
		case 'sint64':
			return 8
		case 'uint128':
			return 16
		case 'id':
			return 32
	}
}

function widthAlignment(width: number): number {
	if (width >= 16) return 16
	if (width >= 8) return 8
	if (width >= 4) return 4
	if (width >= 2) return 2
	return 1
}

// Keep the exported surface explicit: `HEX_PUBLIC_KEY` documents the accepted
// id string shape handled by the canonical identity helper.
void HEX_PUBLIC_KEY
