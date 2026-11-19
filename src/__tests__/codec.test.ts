import { describe, expect, test } from 'bun:test'
import {
	decodeCallOutput,
	decodeFields,
	decodeStruct,
	encodeCallInput,
	encodeFields,
	encodePayloadHex,
	encodeStruct,
	getStructSize,
} from '../codec.ts'
import { PayloadBuildError, PayloadDecodeError } from '../errors.ts'
import type {
	ContractDefinition,
	ContractField,
	EncodableValue,
} from '../types.ts'

const KNOWN_IDENTITY =
	'BZBQFLLBNCXEMGLOBHUVFTLUPLVCPQUASSILFABOFFBCADQSSUPNWLZBQEXK'

const ALL_SCALAR_FIELDS: ContractField[] = [
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
]

const PAIR: ContractDefinition['structs'][string] = {
	name: 'Pair',
	byteLength: 16,
	alignment: 8,
	fields: [
		{ name: 'a', type: 'uint64', offset: 0, byteLength: 8 },
		{ name: 'b', type: 'uint32', offset: 8, byteLength: 4 },
	],
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
	structs: { Pair: PAIR },
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
		{
			kind: 'procedure',
			name: 'allScalars',
			inputType: 1,
			inputSize: 81,
			inputAlignment: 1,
			inputFields: ALL_SCALAR_FIELDS,
			outputSize: 0,
			outputAlignment: 1,
			outputFields: [],
		},
		{
			kind: 'procedure',
			name: 'nested',
			inputType: 2,
			inputSize: 48,
			inputAlignment: 8,
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
			outputSize: 0,
			outputAlignment: 1,
			outputFields: [],
		},
	],
	functions: [
		{
			kind: 'function',
			name: 'getStats',
			inputType: 3,
			inputSize: 4,
			inputAlignment: 4,
			inputFields: [
				{ name: 'epoch', type: 'uint32', offset: 0, byteLength: 4 },
			],
			outputSize: 48,
			outputAlignment: 1,
			outputFields: [
				{ name: 'total', type: 'uint128', offset: 0, byteLength: 16 },
				{ name: 'owner', type: 'id', offset: 16, byteLength: 32 },
			],
		},
	],
	notifications: [
		{
			kind: 'notification',
			name: 'locked',
			inputType: null,
			inputSize: 8,
			inputAlignment: 8,
			inputFields: [
				{ name: 'amount', type: 'uint64', offset: 0, byteLength: 8 },
			],
			outputSize: 0,
			outputAlignment: 1,
			outputFields: [],
		},
	],
}

function allScalarValues(): Record<string, EncodableValue> {
	return {
		u8: 255,
		s8: -128,
		u16: 65_535,
		s16: -32_768,
		u32: 4_294_967_295,
		s32: -2_147_483_648,
		u64: 18_446_744_073_709_551_615n,
		s64: -9_223_372_036_854_775_808n,
		u128: (1n << 128n) - 1n,
		owner: KNOWN_IDENTITY,
		flag: true,
		ok: false,
		status: 'Active',
	}
}

describe('encodeFields / decodeFields', () => {
	test('round-trips every scalar field kind', () => {
		const values = allScalarValues()
		const payload = encodeFields(ALL_SCALAR_FIELDS, CONTRACT, values)
		expect(payload.byteLength).toBe(81)

		const decoded = decodeFields(payload, ALL_SCALAR_FIELDS, CONTRACT, {
			enumFormat: 'name',
		})
		expect(decoded).toEqual({
			u8: 255,
			s8: -128,
			u16: 65_535,
			s16: -32_768,
			u32: 4_294_967_295,
			s32: -2_147_483_648,
			u64: 18_446_744_073_709_551_615n,
			s64: -9_223_372_036_854_775_808n,
			u128: (1n << 128n) - 1n,
			owner: KNOWN_IDENTITY,
			flag: true,
			ok: false,
			status: 'Active',
		})
	})

	test('uses explicit enum labels and numeric fallback', () => {
		const values = { ...allScalarValues(), status: 'Closed' }
		const payload = encodeFields(ALL_SCALAR_FIELDS, CONTRACT, values)
		expect(
			decodeFields(payload, ALL_SCALAR_FIELDS, CONTRACT, {
				enumFormat: 'name',
			}).status,
		).toBe('Closed')
		expect(decodeFields(payload, ALL_SCALAR_FIELDS, CONTRACT).status).toBe(2)

		const unknown = encodeFields(
			[
				{
					name: 'status',
					type: 'enum',
					offset: 0,
					byteLength: 1,
					enumRef: 'Status',
				},
			],
			CONTRACT,
			{ status: 9 },
		)
		expect(
			decodeFields(
				unknown,
				[
					{
						name: 'status',
						type: 'enum',
						offset: 0,
						byteLength: 1,
						enumRef: 'Status',
					},
				],
				CONTRACT,
				{ enumFormat: 'name' },
			).status,
		).toBe(9)
	})

	test('writes little-endian scalars at declared offsets', () => {
		const fields: ContractField[] = [
			{ name: 'amount', type: 'uint64', offset: 0, byteLength: 8 },
			{ name: 'epoch', type: 'uint32', offset: 8, byteLength: 4 },
			{ name: 'delta', type: 'sint32', offset: 12, byteLength: 4 },
			{ name: 'big', type: 'uint128', offset: 16, byteLength: 16 },
			{ name: 'flag', type: 'bool', offset: 32, byteLength: 1 },
			{ name: 'bit', type: 'bit', offset: 33, byteLength: 1 },
		]
		const payload = encodeFields(fields, CONTRACT, {
			amount: 5_000_000n,
			epoch: 150,
			delta: -1,
			big: (1n << 64n) + 2n,
			flag: true,
			bit: false,
		})
		const view = new DataView(
			payload.buffer,
			payload.byteOffset,
			payload.byteLength,
		)
		expect(view.getBigUint64(0, true)).toBe(5_000_000n)
		expect(view.getUint32(8, true)).toBe(150)
		expect(view.getInt32(12, true)).toBe(-1)
		expect(payload[16]).toBe(2)
		expect(payload[24]).toBe(1)
		expect(payload[32]).toBe(1)
		expect(payload[33]).toBe(0)
	})

	test('zero-fills padding in structs', () => {
		const fields: ContractField[] = [
			{
				name: 'pair',
				type: 'struct',
				offset: 0,
				byteLength: 16,
				structRef: 'Pair',
			},
		]
		const payload = encodeFields(fields, CONTRACT, {
			pair: { a: 0x0102030405060708n, b: 0x0a0b0c0d },
		})
		expect(payload.byteLength).toBe(16)
		expect(Array.from(payload.slice(12))).toEqual([0, 0, 0, 0])
		const decoded = decodeFields(payload, fields, CONTRACT).pair as Record<
			string,
			unknown
		>
		expect(decoded).toEqual({ a: 0x0102030405060708n, b: 0x0a0b0c0d })
	})

	test('encodes arrays of scalars, enums, and structs', () => {
		const fields: ContractField[] = [
			{
				name: 'numbers',
				type: 'array',
				offset: 0,
				byteLength: 8,
				array: {
					length: 4,
					itemType: 'uint16',
					itemByteLength: 2,
				},
			},
			{
				name: 'statuses',
				type: 'array',
				offset: 8,
				byteLength: 3,
				array: {
					length: 3,
					itemType: 'enum',
					itemByteLength: 1,
					itemEnumRef: 'Status',
				},
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
		]
		const payload = encodeFields(fields, CONTRACT, {
			numbers: [1, 2, 3, 4],
			statuses: ['None', 'Active', 'Closed'],
			pairs: [
				{ a: 1n, b: 2 },
				{ a: 3n, b: 4 },
			],
		})
		expect(payload.byteLength).toBe(48)
		expect(Array.from(payload.slice(8, 11))).toEqual([0, 1, 2])
		const decoded = decodeFields(payload, fields, CONTRACT, {
			enumFormat: 'name',
		})
		expect(decoded.numbers).toEqual([1, 2, 3, 4])
		expect(decoded.statuses).toEqual(['None', 'Active', 'Closed'])
		expect(decoded.pairs).toEqual([
			{ a: 1n, b: 2 },
			{ a: 3n, b: 4 },
		])
	})

	test('accepts raw Uint8Array values for any fixed-size field', () => {
		const fields: ContractField[] = [
			{ name: 'amount', type: 'uint64', offset: 0, byteLength: 8 },
			{
				name: 'raw',
				type: 'array',
				offset: 8,
				byteLength: 4,
				array: {
					length: 4,
					itemType: 'uint8',
					itemByteLength: 1,
				},
			},
		]
		const amount = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
		const raw = new Uint8Array([9, 10, 11, 12])
		const payload = encodeFields(fields, CONTRACT, { amount, raw })
		expect(Array.from(payload)).toEqual([...amount, ...raw])
	})

	test('encodes and decodes arrays of ids', () => {
		const fields: ContractField[] = [
			{
				name: 'keys',
				type: 'array',
				offset: 0,
				byteLength: 64,
				array: { length: 2, itemType: 'id', itemByteLength: 32 },
			},
		]
		const keys = [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)]
		const payload = encodeFields(fields, CONTRACT, { keys })
		expect(Array.from(payload.slice(0, 4))).toEqual([1, 1, 1, 1])
		expect(Array.from(payload.slice(32, 36))).toEqual([2, 2, 2, 2])
		expect(
			decodeFields(payload, fields, CONTRACT, { idFormat: 'hex' }),
		).toEqual({
			keys: ['01'.repeat(32), '02'.repeat(32)],
		})
		expect(() =>
			encodeFields(fields, CONTRACT, { keys: [new Uint8Array(31)] }),
		).toThrow(/32 bytes/)
	})
})

describe('identity hooks', () => {
	test('encodes and decodes through injected hooks', () => {
		const fields: ContractField[] = [
			{ name: 'owner', type: 'id', offset: 0, byteLength: 32 },
		]
		const publicKey = new Uint8Array(32).fill(7)
		let encodedIdentity = ''
		const payload = encodeFields(
			fields,
			CONTRACT,
			{ owner: KNOWN_IDENTITY },
			{
				identityToPublicKey: (identity) => {
					encodedIdentity = identity
					return publicKey
				},
			},
		)
		expect(encodedIdentity).toBe(KNOWN_IDENTITY)
		expect(Array.from(payload)).toEqual(Array.from(publicKey))

		let decodedKey: Uint8Array | undefined
		const decoded = decodeFields(payload, fields, CONTRACT, {
			publicKeyToIdentity: (key) => {
				decodedKey = key
				return KNOWN_IDENTITY
			},
		})
		expect(decoded.owner).toBe(KNOWN_IDENTITY)
		expect(Array.from(decodedKey as Uint8Array)).toEqual(Array.from(publicKey))
	})

	test('defaults round-trip a real identity', () => {
		const fields: ContractField[] = [
			{ name: 'owner', type: 'id', offset: 0, byteLength: 32 },
		]
		const payload = encodeFields(fields, CONTRACT, { owner: KNOWN_IDENTITY })
		expect(decodeFields(payload, fields, CONTRACT).owner).toBe(KNOWN_IDENTITY)
	})

	test('rejects a hook that returns the wrong width', () => {
		expect(() =>
			encodeFields(
				[{ name: 'owner', type: 'id', offset: 0, byteLength: 32 }],
				CONTRACT,
				{ owner: KNOWN_IDENTITY },
				{ identityToPublicKey: () => new Uint8Array(31) },
			),
		).toThrow(PayloadBuildError)
	})
})

describe('encodeStruct / decodeStruct', () => {
	const fields: ContractField[] = [
		{ name: 'a', type: 'uint64', offset: 0, byteLength: 8 },
		{ name: 'b', type: 'uint32', offset: 8, byteLength: 4 },
	]

	test('computes natural size with alignment and trailing padding', () => {
		expect(getStructSize(CONTRACT, fields)).toBe(16)
		const payload = encodeStruct(CONTRACT, fields, { a: 1n, b: 2 })
		expect(payload.byteLength).toBe(16)
		expect(Array.from(payload.slice(12))).toEqual([0, 0, 0, 0])
		expect(decodeStruct(CONTRACT, fields, payload)).toEqual({ a: 1n, b: 2 })
	})

	test('honours a minimum size and raw byte input', () => {
		const raw = new Uint8Array(20).fill(1)
		expect(
			Array.from(encodeStruct(CONTRACT, fields, raw, { size: 20 })),
		).toEqual(Array.from(raw))
		expect(
			encodeStruct(CONTRACT, fields, { a: 1n, b: 2 }, { size: 20 }),
		).toHaveLength(20)
	})

	test('rejects short buffers and undersized allocation', () => {
		expect(() => decodeStruct(CONTRACT, fields, new Uint8Array(12))).toThrow(
			PayloadDecodeError,
		)
		expect(() =>
			encodeStruct(CONTRACT, fields, { a: 1n, b: 2 }, { size: 8 }),
		).toThrow(PayloadBuildError)
		expect(() => getStructSize(CONTRACT, fields, 0)).toThrow(PayloadBuildError)
	})
})

describe('contract call helpers', () => {
	test('encodes procedure inputs and decodes function outputs', () => {
		const call = encodeCallInput(CONTRACT, 'allScalars', allScalarValues())
		expect(call.contractIndex).toBe(9)
		expect(call.inputType).toBe(1)
		expect(call.inputSize).toBe(81)

		const output = encodeFields(
			[
				{ name: 'total', type: 'uint128', offset: 0, byteLength: 16 },
				{ name: 'owner', type: 'id', offset: 16, byteLength: 32 },
			],
			CONTRACT,
			{ total: 42n, owner: KNOWN_IDENTITY },
		)
		const decoded = decodeCallOutput(CONTRACT, 'getStats', output, {
			publicKeyToIdentity: () => KNOWN_IDENTITY,
		})
		expect(decoded.total).toBe(42n)
		expect(decoded.owner).toBe(KNOWN_IDENTITY)
	})

	test('accepts call objects and rejects notifications/unknown calls', () => {
		const call = CONTRACT.procedures[0]
		expect(call).toBeDefined()
		expect(
			encodeCallInput(
				CONTRACT,
				call as NonNullable<typeof call>,
				allScalarValues(),
			).inputType,
		).toBe(1)
		expect(() => encodeCallInput(CONTRACT, 'locked', { amount: 1n })).toThrow(
			PayloadBuildError,
		)
		expect(() => encodeCallInput(CONTRACT, 'missing', {})).toThrow(
			PayloadBuildError,
		)
	})

	test('returns hex payloads', () => {
		expect(
			encodePayloadHex(
				CONTRACT,
				[{ name: 'x', type: 'uint32', offset: 0, byteLength: 4 }],
				{ x: 0x01020304 },
			),
		).toBe('04030201')
	})
})

describe('codec errors', () => {
	const fields: ContractField[] = [
		{ name: 'amount', type: 'uint64', offset: 0, byteLength: 8 },
	]

	test('missing values keep their zero-filled defaults', () => {
		expect(Array.from(encodeFields(fields, CONTRACT, {}))).toEqual([
			0, 0, 0, 0, 0, 0, 0, 0,
		])
		const payload = encodeFields(
			[
				{
					name: 'pair',
					type: 'struct',
					offset: 0,
					byteLength: 16,
					structRef: 'Pair',
				},
			],
			CONTRACT,
			{ pair: { a: 1n } },
		)
		expect(Array.from(payload)).toEqual([
			1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
		])
	})

	test('wrong types and out-of-range values throw', () => {
		expect(() => encodeFields(fields, CONTRACT, { amount: true })).toThrow(
			PayloadBuildError,
		)
		expect(() =>
			encodeFields(
				[{ name: 'x', type: 'uint8', offset: 0, byteLength: 1 }],
				CONTRACT,
				{ x: 256 },
			),
		).toThrow(/out of range/)
		expect(() => encodeFields(fields, CONTRACT, { amount: -1n })).toThrow(
			/out of range/,
		)
		expect(() =>
			encodeFields(
				[
					{
						name: 'status',
						type: 'enum',
						offset: 0,
						byteLength: 1,
						enumRef: 'Status',
					},
				],
				CONTRACT,
				{ status: 'Missing' },
			),
		).toThrow(/has no "Missing"/)
	})

	test('overlong arrays and raw-byte mismatches throw', () => {
		const arrayField: ContractField[] = [
			{
				name: 'numbers',
				type: 'array',
				offset: 0,
				byteLength: 8,
				array: {
					length: 4,
					itemType: 'uint16',
					itemByteLength: 2,
				},
			},
		]
		expect(() =>
			encodeFields(arrayField, CONTRACT, { numbers: [1, 2, 3, 4, 5] }),
		).toThrow(/expected at most 4 items/)
		expect(
			Array.from(encodeFields(arrayField, CONTRACT, { numbers: [1, 2, 3] })),
		).toEqual([1, 0, 2, 0, 3, 0, 0, 0])
		expect(() =>
			encodeFields(fields, CONTRACT, {
				amount: new Uint8Array(4),
			}),
		).toThrow(/raw bytes/)
	})

	test('truncated input throws PayloadDecodeError', () => {
		expect(() => decodeFields(new Uint8Array(4), fields, CONTRACT)).toThrow(
			PayloadDecodeError,
		)
	})

	test('unknown struct/enum references throw in both directions', () => {
		const badStruct: ContractField[] = [
			{
				name: 'pair',
				type: 'struct',
				offset: 0,
				byteLength: 16,
				structRef: 'Missing',
			},
		]
		expect(() =>
			encodeFields(badStruct, CONTRACT, {
				pair: { a: 1n, b: 2 },
			}),
		).toThrow(/struct "Missing"/)
		expect(() => decodeFields(new Uint8Array(16), badStruct, CONTRACT)).toThrow(
			/struct "Missing"/,
		)

		const badEnum: ContractField[] = [
			{
				name: 'status',
				type: 'enum',
				offset: 0,
				byteLength: 1,
				enumRef: 'Missing',
			},
		]
		expect(() => decodeFields(new Uint8Array(1), badEnum, CONTRACT)).toThrow(
			/enum "Missing"/,
		)
	})
})
