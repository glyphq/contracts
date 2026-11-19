import {
	ContractNotFoundError,
	EntryNotFoundError,
	MetadataValidationError,
} from './errors.js'
import type {
	ContractCall,
	ContractCallKind,
	ContractDefinition,
	ContractEnum,
	ContractField,
	ContractMetadata,
	ContractStruct,
	ScalarFieldKind,
} from './types.js'

export type ContractSelector =
	| { index: number }
	| { name: string }
	| { assetName: string }

export type CallKind = ContractCallKind

const SCALAR_BYTE_LENGTHS: Record<ScalarFieldKind, number> = {
	uint8: 1,
	sint8: 1,
	uint16: 2,
	sint16: 2,
	uint32: 4,
	sint32: 4,
	uint64: 8,
	sint64: 8,
	uint128: 16,
	id: 32,
	bit: 1,
	bool: 1,
}

const CALL_LIST_NAMES: Record<
	CallKind,
	'procedures' | 'functions' | 'notifications'
> = {
	procedure: 'procedures',
	function: 'functions',
	notification: 'notifications',
}

/** Returns every call exposed by a contract across all call kinds. */
export function listCalls(contract: ContractDefinition): ContractCall[] {
	return [
		...contract.procedures,
		...contract.functions,
		...contract.notifications,
	]
}

/** Finds a contract by its on-chain index. */
export function findContractByIndex(
	metadata: ContractMetadata,
	index: number,
): ContractDefinition {
	const contract = metadata.contracts.find(
		(candidate) => candidate.index === index,
	)
	if (!contract) {
		throw new ContractNotFoundError({ index })
	}
	return contract
}

/** Finds a contract by its canonical name, case-insensitively. */
export function findContractByName(
	metadata: ContractMetadata,
	name: string,
): ContractDefinition {
	const normalized = name.toLowerCase()
	const contract = metadata.contracts.find(
		(candidate) => candidate.name.toLowerCase() === normalized,
	)
	if (!contract) {
		throw new ContractNotFoundError({ name })
	}
	return contract
}

/** Finds a contract by its asset name, case-insensitively. */
export function findContractByAssetName(
	metadata: ContractMetadata,
	assetName: string,
): ContractDefinition {
	const normalized = assetName.toLowerCase()
	const contract = metadata.contracts.find(
		(candidate) => candidate.assetName.toLowerCase() === normalized,
	)
	if (!contract) {
		throw new ContractNotFoundError({ assetName })
	}
	return contract
}

/** Finds a contract by index, canonical name, or asset name. */
export function findContract(
	metadata: ContractMetadata,
	selector: ContractSelector,
): ContractDefinition {
	if ('index' in selector) {
		return findContractByIndex(metadata, selector.index)
	}
	if ('name' in selector) {
		return findContractByName(metadata, selector.name)
	}
	return findContractByAssetName(metadata, selector.assetName)
}

/** Returns the calls of one kind, in declaration order. */
export function getCalls(
	contract: ContractDefinition,
	kind: CallKind,
): ContractCall[] {
	return contract[CALL_LIST_NAMES[kind]]
}

/** Returns a call by kind and registered `inputType` ordinal. */
export function getCall(
	contract: ContractDefinition,
	kind: CallKind,
	inputType: number,
): ContractCall {
	const call = getCalls(contract, kind).find(
		(candidate) => candidate.inputType === inputType,
	)
	if (!call) {
		throw new EntryNotFoundError(contract.name, kind, { inputType })
	}
	return call
}

/** Returns a call by kind and name, case-insensitively. */
export function getCallByName(
	contract: ContractDefinition,
	kind: CallKind,
	name: string,
): ContractCall {
	const normalized = name.toLowerCase()
	const call = getCalls(contract, kind).find(
		(candidate) => candidate.name.toLowerCase() === normalized,
	)
	if (!call) {
		throw new EntryNotFoundError(contract.name, kind, { name })
	}
	return call
}

export function getProcedure(
	contract: ContractDefinition,
	inputType: number,
): ContractCall {
	return getCall(contract, 'procedure', inputType)
}

export function getFunction(
	contract: ContractDefinition,
	inputType: number,
): ContractCall {
	return getCall(contract, 'function', inputType)
}

export function getNotification(
	contract: ContractDefinition,
	inputType: number,
): ContractCall {
	return getCall(contract, 'notification', inputType)
}

/**
 * Indexed view over a metadata document. Building the lookup validates the
 * metadata once, then serves index, name, and asset-name lookups in O(1).
 */
export class ContractLookup {
	readonly metadata: ContractMetadata
	private readonly byIndex = new Map<number, ContractDefinition>()
	private readonly byName = new Map<string, ContractDefinition>()
	private readonly byAssetName = new Map<string, ContractDefinition>()

	constructor(
		metadata: ContractMetadata,
		options: { validate?: boolean } = {},
	) {
		if (options.validate !== false) {
			validateMetadata(metadata)
		}
		this.metadata = metadata
		for (const contract of metadata.contracts) {
			this.byIndex.set(contract.index, contract)
			this.byName.set(contract.name.toLowerCase(), contract)
			this.byAssetName.set(contract.assetName.toLowerCase(), contract)
		}
	}

	get size(): number {
		return this.byIndex.size
	}

	byIndexOrThrow(index: number): ContractDefinition {
		const contract = this.byIndex.get(index)
		if (!contract) {
			throw new ContractNotFoundError({ index })
		}
		return contract
	}

	byNameOrThrow(name: string): ContractDefinition {
		const contract = this.byName.get(name.toLowerCase())
		if (!contract) {
			throw new ContractNotFoundError({ name })
		}
		return contract
	}

	byAssetNameOrThrow(assetName: string): ContractDefinition {
		const contract = this.byAssetName.get(assetName.toLowerCase())
		if (!contract) {
			throw new ContractNotFoundError({ assetName })
		}
		return contract
	}

	find(selector: ContractSelector): ContractDefinition {
		if ('index' in selector) {
			return this.byIndexOrThrow(selector.index)
		}
		if ('name' in selector) {
			return this.byNameOrThrow(selector.name)
		}
		return this.byAssetNameOrThrow(selector.assetName)
	}

	has(selector: ContractSelector): boolean {
		try {
			this.find(selector)
			return true
		} catch (error) {
			if (error instanceof ContractNotFoundError) {
				return false
			}
			throw error
		}
	}
}

/** Builds an indexed lookup, validating the metadata by default. */
export function createContractLookup(
	metadata: ContractMetadata,
	options: { validate?: boolean } = {},
): ContractLookup {
	return new ContractLookup(metadata, options)
}

/**
 * Validates structural invariants that the codec relies on: unique contract
 * selectors, call ordinals, field bounds, fixed-size array arithmetic, and
 * scalar widths.
 */
export function validateMetadata(metadata: ContractMetadata): void {
	if (metadata.schemaVersion !== 1) {
		throw new MetadataValidationError(
			`Unsupported metadata schemaVersion ${metadata.schemaVersion}`,
		)
	}

	const indices = new Set<number>()
	const names = new Set<string>()
	const assetNames = new Set<string>()

	for (const contract of metadata.contracts) {
		if (!Number.isInteger(contract.index) || contract.index < 0) {
			throw new MetadataValidationError(
				`Contract "${contract.name}" has invalid index ${contract.index}`,
			)
		}
		if (indices.has(contract.index)) {
			throw new MetadataValidationError(
				`Duplicate contract index ${contract.index}`,
			)
		}
		indices.add(contract.index)

		const name = contract.name.toLowerCase()
		if (names.has(name)) {
			throw new MetadataValidationError(
				`Duplicate contract name "${contract.name}"`,
			)
		}
		names.add(name)

		const assetName = contract.assetName.toLowerCase()
		if (assetNames.has(assetName)) {
			throw new MetadataValidationError(
				`Duplicate contract asset name "${contract.assetName}"`,
			)
		}
		assetNames.add(assetName)

		validateCallList(contract, 'procedure', contract.procedures)
		validateCallList(contract, 'function', contract.functions)
		validateCallList(contract, 'notification', contract.notifications)

		for (const struct of Object.values(contract.structs)) {
			validateStruct(contract, struct, new Set())
		}
	}

	if (metadata.qpi) {
		const qpi: ContractDefinition = {
			index: 0,
			name: 'QPI',
			assetName: 'QPI',
			contractAddress: '',
			fileName: '',
			constructionEpoch: null,
			destructionEpoch: null,
			stateSize: null,
			source: { path: '', line: 0 },
			procedures: [],
			functions: [],
			notifications: [],
			structs: metadata.qpi.structs,
			enums: metadata.qpi.enums,
		}
		for (const struct of Object.values(qpi.structs)) {
			validateStruct(qpi, struct, new Set())
		}
		for (const enumDef of Object.values(qpi.enums)) {
			validateEnum(enumDef, `QPI enum "${enumDef.name}"`)
		}
	}
}

function validateCallList(
	contract: ContractDefinition,
	kind: CallKind,
	calls: ContractCall[],
): void {
	const inputTypes = new Set<number>()
	for (const call of calls) {
		if (call.kind !== kind) {
			throw new MetadataValidationError(
				`Contract ${contract.name}: ${kind} list contains a ${call.kind} "${call.name}"`,
			)
		}
		if (call.inputType !== null) {
			if (!Number.isInteger(call.inputType) || call.inputType < 0) {
				throw new MetadataValidationError(
					`Contract ${contract.name} ${kind} "${call.name}": invalid inputType ${call.inputType}`,
				)
			}
			if (inputTypes.has(call.inputType)) {
				throw new MetadataValidationError(
					`Contract ${contract.name} ${kind} "${call.name}": duplicate inputType ${call.inputType}`,
				)
			}
			inputTypes.add(call.inputType)
		}

		validateFields(
			contract,
			call.inputFields,
			call.inputSize,
			`${contract.name} ${kind} "${call.name}" input`,
		)
		validateFields(
			contract,
			call.outputFields,
			call.outputSize,
			`${contract.name} ${kind} "${call.name}" output`,
		)
	}
}

function validateFields(
	contract: ContractDefinition,
	fields: ContractField[],
	size: number,
	label: string,
): void {
	if (!Number.isInteger(size) || size < 0) {
		throw new MetadataValidationError(`${label}: invalid size ${size}`)
	}
	for (const field of fields) {
		if (!Number.isInteger(field.offset) || field.offset < 0) {
			throw new MetadataValidationError(
				`${label} field "${field.name}": invalid offset ${field.offset}`,
			)
		}
		if (!Number.isInteger(field.byteLength) || field.byteLength < 0) {
			throw new MetadataValidationError(
				`${label} field "${field.name}": invalid byteLength ${field.byteLength}`,
			)
		}
		if (field.offset + field.byteLength > size) {
			throw new MetadataValidationError(
				`${label} field "${field.name}" ends at ${field.offset + field.byteLength}, beyond size ${size}`,
			)
		}
		validateField(contract, field, `${label} field "${field.name}"`, new Set())
	}
}

function validateField(
	contract: ContractDefinition,
	field: ContractField,
	label: string,
	seenStructs: Set<string>,
): void {
	switch (field.type) {
		case 'struct': {
			const struct = requireStruct(contract, field.structRef, label)
			if (field.byteLength !== struct.byteLength) {
				throw new MetadataValidationError(
					`${label}: struct byteLength ${field.byteLength} !== ${struct.name} byteLength ${struct.byteLength}`,
				)
			}
			validateStruct(contract, struct, new Set(seenStructs))
			return
		}
		case 'enum': {
			const enumDef = requireEnum(contract, field.enumRef, label)
			validateEnum(enumDef, label)
			if (field.byteLength !== enumDef.byteLength) {
				throw new MetadataValidationError(
					`${label}: enum byteLength ${field.byteLength} !== ${enumDef.name} byteLength ${enumDef.byteLength}`,
				)
			}
			return
		}
		case 'array': {
			const array = field.array
			if (!array) {
				throw new MetadataValidationError(`${label}: missing array metadata`)
			}
			if (!Number.isInteger(array.length) || array.length < 0) {
				throw new MetadataValidationError(
					`${label}: invalid array length ${array.length}`,
				)
			}
			if (!Number.isInteger(array.itemByteLength) || array.itemByteLength < 0) {
				throw new MetadataValidationError(
					`${label}: invalid item byteLength ${array.itemByteLength}`,
				)
			}
			if (array.length * array.itemByteLength !== field.byteLength) {
				throw new MetadataValidationError(
					`${label}: array length × item byteLength does not equal byteLength`,
				)
			}
			validateItemType(contract, array.itemType, array.itemByteLength, {
				label,
				structRef: array.itemStructRef,
				enumRef: array.itemEnumRef,
			})
			return
		}
		default: {
			const expected = SCALAR_BYTE_LENGTHS[field.type]
			if (field.byteLength !== expected) {
				throw new MetadataValidationError(
					`${label}: ${field.type} byteLength ${field.byteLength} !== ${expected}`,
				)
			}
		}
	}
}

function validateItemType(
	contract: ContractDefinition,
	itemType: ContractField['type'],
	itemByteLength: number,
	refs: { label: string; structRef?: string; enumRef?: string },
): void {
	if (itemType === 'array') {
		throw new MetadataValidationError(
			`${refs.label}: nested arrays are not supported`,
		)
	}
	if (itemType === 'struct') {
		const struct = requireStruct(contract, refs.structRef, refs.label)
		if (itemByteLength !== struct.byteLength) {
			throw new MetadataValidationError(
				`${refs.label}: struct item byteLength ${itemByteLength} !== ${struct.byteLength}`,
			)
		}
		return
	}
	if (itemType === 'enum') {
		const enumDef = requireEnum(contract, refs.enumRef, refs.label)
		validateEnum(enumDef, refs.label)
		if (itemByteLength !== enumDef.byteLength) {
			throw new MetadataValidationError(
				`${refs.label}: enum item byteLength ${itemByteLength} !== ${enumDef.byteLength}`,
			)
		}
		return
	}
	const expected = SCALAR_BYTE_LENGTHS[itemType]
	if (itemByteLength !== expected) {
		throw new MetadataValidationError(
			`${refs.label}: ${itemType} item byteLength ${itemByteLength} !== ${expected}`,
		)
	}
}

function validateStruct(
	contract: ContractDefinition,
	struct: ContractStruct,
	seen: Set<string>,
): void {
	if (seen.has(struct.name)) {
		throw new MetadataValidationError(
			`${struct.name}: recursive struct reference`,
		)
	}
	if (!Number.isInteger(struct.byteLength) || struct.byteLength < 0) {
		throw new MetadataValidationError(
			`${struct.name}: invalid byteLength ${struct.byteLength}`,
		)
	}
	if (
		!Number.isInteger(struct.alignment) ||
		struct.alignment <= 0 ||
		(struct.alignment & (struct.alignment - 1)) !== 0
	) {
		throw new MetadataValidationError(
			`${struct.name}: alignment must be a positive power of two`,
		)
	}

	const nextSeen = new Set(seen)
	nextSeen.add(struct.name)
	for (const field of struct.fields) {
		if (!Number.isInteger(field.offset) || field.offset < 0) {
			throw new MetadataValidationError(
				`${struct.name} field "${field.name}": invalid offset ${field.offset}`,
			)
		}
		if (!Number.isInteger(field.byteLength) || field.byteLength < 0) {
			throw new MetadataValidationError(
				`${struct.name} field "${field.name}": invalid byteLength ${field.byteLength}`,
			)
		}
		if (field.offset + field.byteLength > struct.byteLength) {
			throw new MetadataValidationError(
				`${struct.name} field "${field.name}" ends beyond struct byteLength ${struct.byteLength}`,
			)
		}
		validateField(
			contract,
			field,
			`${struct.name} field "${field.name}"`,
			nextSeen,
		)
	}
}

function validateEnum(enumDef: ContractEnum, label: string): void {
	const expected = SCALAR_BYTE_LENGTHS[enumDef.underlyingType]
	if (enumDef.byteLength !== expected) {
		throw new MetadataValidationError(
			`${label}: enum ${enumDef.name} byteLength ${enumDef.byteLength} !== ${expected}`,
		)
	}
	for (const value of enumDef.values) {
		if (!Number.isInteger(value.value)) {
			throw new MetadataValidationError(
				`${label}: enum ${enumDef.name} value "${value.name}" is not an integer`,
			)
		}
	}
}

function requireStruct(
	contract: ContractDefinition,
	ref: string | undefined,
	label: string,
): ContractStruct {
	if (!ref) {
		throw new MetadataValidationError(`${label}: missing structRef`)
	}
	const struct = contract.structs[ref]
	if (!struct) {
		throw new MetadataValidationError(`${label}: struct "${ref}" not found`)
	}
	return struct
}

function requireEnum(
	contract: ContractDefinition,
	ref: string | undefined,
	label: string,
): ContractEnum {
	if (!ref) {
		throw new MetadataValidationError(`${label}: missing enumRef`)
	}
	const enumDef = contract.enums[ref]
	if (!enumDef) {
		throw new MetadataValidationError(`${label}: enum "${ref}" not found`)
	}
	return enumDef
}
