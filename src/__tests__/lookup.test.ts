import { describe, expect, test } from 'bun:test'
import {
	ContractNotFoundError,
	EntryNotFoundError,
	MetadataValidationError,
} from '../errors.ts'
import {
	ContractLookup,
	createContractLookup,
	findContract,
	findContractByAssetName,
	findContractByIndex,
	findContractByName,
	getCall,
	getCallByName,
	getFunction,
	getNotification,
	getProcedure,
	listCalls,
	validateMetadata,
} from '../lookup.ts'
import type {
	ContractCall,
	ContractDefinition,
	ContractMetadata,
} from '../types.ts'

function call(
	kind: ContractCall['kind'],
	inputType: number,
	name: string,
	overrides: Partial<ContractCall> = {},
): ContractCall {
	return {
		kind,
		name,
		inputType,
		inputSize: 0,
		outputSize: 0,
		inputAlignment: 1,
		outputAlignment: 1,
		inputFields: [],
		outputFields: [],
		...overrides,
	}
}

const CONTRACT: ContractDefinition = {
	index: 9,
	name: 'Qearn',
	assetName: 'QEARN',
	contractAddress:
		'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFXIB',
	fileName: 'Qearn.h',
	constructionEpoch: 137,
	destructionEpoch: null,
	stateSize: 1024,
	source: { path: 'src/contracts/Qearn.h', line: 1 },
	structs: {
		Pair: {
			name: 'Pair',
			byteLength: 16,
			alignment: 8,
			fields: [
				{ name: 'a', type: 'uint64', offset: 0, byteLength: 8 },
				{ name: 'b', type: 'uint32', offset: 8, byteLength: 4 },
			],
		},
	},
	enums: {
		Status: {
			name: 'Status',
			underlyingType: 'uint8',
			byteLength: 1,
			values: [
				{ name: 'None', value: 0 },
				{ name: 'Active', value: 1 },
				{ name: 'Closed', value: 2 },
			],
		},
	},
	procedures: [
		call('procedure', 1, 'lock', {
			inputSize: 8,
			inputAlignment: 8,
			inputFields: [
				{ name: 'amount', type: 'uint64', offset: 0, byteLength: 8 },
			],
			outputSize: 4,
			outputFields: [
				{ name: 'returnCode', type: 'uint32', offset: 0, byteLength: 4 },
			],
		}),
		call('procedure', 2, 'unlock', {
			inputSize: 12,
			inputFields: [
				{ name: 'amount', type: 'uint64', offset: 0, byteLength: 8 },
				{ name: 'epoch', type: 'uint32', offset: 8, byteLength: 4 },
			],
		}),
		call('procedure', 3, 'allScalars', {
			inputSize: 81,
			inputFields: [
				{ name: 'u8', type: 'uint8', offset: 0, byteLength: 1 },
				{ name: 's8', type: 'sint8', offset: 1, byteLength: 1 },
				{ name: 'u16', type: 'uint16', offset: 2, byteLength: 2 },
				{ name: 's16', type: 'sint16', offset: 4, byteLength: 2 },
				{ name: 'u32', type: 'uint32', offset: 6, byteLength: 4 },
				{ name: 's32', type: 'sint32', offset: 10, byteLength: 4 },
				{ name: 'u64', type: 'uint64', offset: 14, byteLength: 8 },
				{ name: 's64', type: 'sint64', offset: 22, byteLength: 8 },
				{ name: 'u128', type: 'uint128', offset: 30, byteLength: 16 },
				{ name: 'owner', type: 'id', offset: 46, byteLength: 32 },
				{ name: 'flag', type: 'bit', offset: 78, byteLength: 1 },
				{ name: 'ok', type: 'bool', offset: 79, byteLength: 1 },
				{
					name: 'status',
					type: 'enum',
					offset: 80,
					byteLength: 1,
					enumRef: 'Status',
				},
			],
		}),
		call('procedure', 4, 'nested', {
			inputSize: 48,
			inputFields: [
				{
					name: 'pair',
					type: 'struct',
					offset: 0,
					byteLength: 16,
					structRef: 'Pair',
				},
				{
					name: 'pairs',
					type: 'array',
					offset: 16,
					byteLength: 32,
					array: {
						length: 2,
						itemType: 'struct',
						itemByteLength: 16,
						itemStructRef: 'Pair',
					},
				},
			],
		}),
	],
	functions: [
		call('function', 5, 'getStats', {
			inputSize: 4,
			inputFields: [
				{ name: 'epoch', type: 'uint32', offset: 0, byteLength: 4 },
			],
			outputSize: 48,
			outputFields: [
				{ name: 'total', type: 'uint128', offset: 0, byteLength: 16 },
				{ name: 'owner', type: 'id', offset: 16, byteLength: 32 },
			],
		}),
	],
	notifications: [
		call('notification', 6, 'locked', {
			inputSize: 8,
			inputFields: [
				{ name: 'amount', type: 'uint64', offset: 0, byteLength: 8 },
			],
		}),
	],
}

const METADATA: ContractMetadata = {
	schemaVersion: 1,
	source: {
		repository: 'qubic/core',
		ref: 'main',
		commit: '0'.repeat(40),
		commitDate: '2026-01-01T00:00:00Z',
	},
	contracts: [
		CONTRACT,
		{
			...CONTRACT,
			index: 1,
			name: 'Qx',
			assetName: 'QX',
			fileName: 'Qx.h',
			structs: {},
			enums: {},
			procedures: [],
			functions: [],
			notifications: [],
		},
	],
}

describe('contract lookup', () => {
	test('finds by index, name, and asset name', () => {
		expect(findContractByIndex(METADATA, 9).name).toBe('Qearn')
		expect(findContractByName(METADATA, 'qEaRn').index).toBe(9)
		expect(findContractByAssetName(METADATA, 'qx').index).toBe(1)
		expect(findContract(METADATA, { name: 'QX' }).assetName).toBe('QX')
	})

	test('throws ContractNotFoundError with selector details', () => {
		expect(() => findContractByIndex(METADATA, 99)).toThrow(
			ContractNotFoundError,
		)
		expect(() => findContractByName(METADATA, 'nope')).toThrow(
			ContractNotFoundError,
		)
		expect(() => findContractByAssetName(METADATA, 'nope')).toThrow(
			ContractNotFoundError,
		)
	})
})

describe('call lookup', () => {
	test('finds procedures, functions, and notifications by ordinal', () => {
		expect(getProcedure(CONTRACT, 2).name).toBe('unlock')
		expect(getFunction(CONTRACT, 5).name).toBe('getStats')
		expect(getNotification(CONTRACT, 6).name).toBe('locked')
		expect(getCall(CONTRACT, 'procedure', 1).name).toBe('lock')
	})

	test('finds calls by name case-insensitively', () => {
		expect(getCallByName(CONTRACT, 'procedure', 'UNLOCK').inputType).toBe(2)
		expect(getCallByName(CONTRACT, 'function', 'getstats').inputType).toBe(5)
	})

	test('lists calls in declaration order across kinds', () => {
		expect(listCalls(CONTRACT).map((entry) => entry.name)).toEqual([
			'lock',
			'unlock',
			'allScalars',
			'nested',
			'getStats',
			'locked',
		])
	})

	test('throws EntryNotFoundError with selector details', () => {
		expect(() => getProcedure(CONTRACT, 99)).toThrow(EntryNotFoundError)
		expect(() => getCallByName(CONTRACT, 'procedure', 'nope')).toThrow(
			EntryNotFoundError,
		)
		const error = (() => {
			try {
				getFunction(CONTRACT, 99)
			} catch (caught) {
				return caught
			}
		})()
		expect(error).toBeInstanceOf(EntryNotFoundError)
		expect((error as EntryNotFoundError).contractName).toBe('Qearn')
		expect((error as EntryNotFoundError).selector).toEqual({ inputType: 99 })
	})
})

describe('indexed ContractLookup', () => {
	test('serves O(1) lookups and has()', () => {
		const lookup = createContractLookup(METADATA)
		expect(lookup.size).toBe(2)
		expect(lookup.byIndexOrThrow(9).name).toBe('Qearn')
		expect(lookup.byNameOrThrow('qx').index).toBe(1)
		expect(lookup.byAssetNameOrThrow('qeArN').index).toBe(9)
		expect(lookup.find({ assetName: 'QX' }).name).toBe('Qx')
		expect(lookup.has({ index: 42 })).toBe(false)
		expect(lookup.has({ name: 'Qearn' })).toBe(true)
	})

	test('can skip validation when the caller already validated', () => {
		const lookup = new ContractLookup(METADATA, { validate: false })
		expect(lookup.size).toBe(2)
	})
})

describe('validateMetadata', () => {
	test('accepts a registry covering every field kind', () => {
		expect(() => validateMetadata(METADATA)).not.toThrow()
	})

	test('rejects unsupported schema versions', () => {
		const invalid = structuredClone(METADATA) as unknown as {
			schemaVersion: number
		}
		invalid.schemaVersion = 2
		expect(() =>
			validateMetadata(invalid as unknown as ContractMetadata),
		).toThrow(MetadataValidationError)
	})

	test('rejects duplicate indices, names, and asset names', () => {
		const duplicateIndex = structuredClone(METADATA)
		duplicateIndex.contracts[1]!.index = 9
		expect(() => validateMetadata(duplicateIndex)).toThrow(
			/Duplicate contract index/,
		)

		const duplicateName = structuredClone(METADATA)
		duplicateName.contracts[1]!.name = 'QEARN'
		expect(() => validateMetadata(duplicateName)).toThrow(
			/Duplicate contract name/,
		)

		const duplicateAsset = structuredClone(METADATA)
		duplicateAsset.contracts[1]!.assetName = 'qearn'
		expect(() => validateMetadata(duplicateAsset)).toThrow(
			/Duplicate contract asset name/,
		)
	})

	test('rejects duplicate or invalid inputType ordinals', () => {
		const duplicate = structuredClone(METADATA)
		duplicate.contracts[0]!.procedures[1]!.inputType = 1
		expect(() => validateMetadata(duplicate)).toThrow(/duplicate inputType/)

		const negative = structuredClone(METADATA)
		negative.contracts[0]!.procedures[0]!.inputType = -1
		expect(() => validateMetadata(negative)).toThrow(/invalid inputType/)
	})

	test('rejects field bounds beyond the call size', () => {
		const invalid = structuredClone(METADATA)
		invalid.contracts[0]!.procedures[0]!.inputFields[0]!.offset = 4
		expect(() => validateMetadata(invalid)).toThrow(/beyond size/)
	})

	test('rejects wrong scalar widths', () => {
		const invalid = structuredClone(METADATA)
		invalid.contracts[0]!.procedures[0]!.inputFields[0]!.byteLength = 4
		expect(() => validateMetadata(invalid)).toThrow(/uint64 byteLength/)
	})

	test('rejects malformed fixed-size arrays', () => {
		const invalid = structuredClone(METADATA)
		const arrayField = invalid.contracts[0]!.procedures[3]!.inputFields[1]!
		arrayField.array!.length = 3
		expect(() => validateMetadata(invalid)).toThrow(/array length/)
	})

	test('rejects missing struct and enum references', () => {
		const missingStruct = structuredClone(METADATA)
		missingStruct.contracts[0]!.procedures[3]!.inputFields[0]!.structRef =
			'Missing'
		expect(() => validateMetadata(missingStruct)).toThrow(/struct "Missing"/)

		const missingEnum = structuredClone(METADATA)
		missingEnum.contracts[0]!.procedures[2]!.inputFields[12]!.enumRef =
			'Missing'
		expect(() => validateMetadata(missingEnum)).toThrow(/enum "Missing"/)
	})

	test('rejects recursive struct references', () => {
		const invalid = structuredClone(METADATA)
		invalid.contracts[0]!.structs.Pair!.fields[0] = {
			name: 'self',
			type: 'struct',
			offset: 0,
			byteLength: 16,
			structRef: 'Pair',
		}
		expect(() => validateMetadata(invalid)).toThrow(/recursive struct/)
	})

	test('rejects invalid struct alignment', () => {
		const invalid = structuredClone(METADATA)
		invalid.contracts[0]!.structs.Pair!.alignment = 3
		expect(() => validateMetadata(invalid)).toThrow(/power of two/)
	})

	test('rejects call kind mismatches', () => {
		const invalid = structuredClone(METADATA)
		invalid.contracts[0]!.procedures[0]!.kind = 'function'
		expect(() => validateMetadata(invalid)).toThrow(/procedure list contains/)
	})
})
