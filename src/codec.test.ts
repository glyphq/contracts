import { describe, expect, test } from 'bun:test'
import {
	decodeCallOutput,
	decodeFunctionOutput,
	decodeProcedureOutput,
	decodeStruct,
	encodeCallInput,
	encodeFunctionInput,
	encodeProcedureInput,
	encodeStruct,
	getStructSize,
} from './codec.js'
import { contractIndexToIdentity, publicKeyToIdentity } from './identity.js'
import type {
	ContractCall,
	ContractDefinition,
	ContractEnum,
	ContractField,
	ContractStruct,
} from './types.js'
import { ContractAbiError } from './types.js'

const headerFields: ContractField[] = [
	{ name: 'a', type: 'uint64', offset: 0, byteLength: 8 },
	{ name: 'b', type: 'uint32', offset: 8, byteLength: 4 },
	{ name: 'c', type: 'uint64', offset: 16, byteLength: 8 },
]

const tightFields: ContractField[] = [
	{ name: 'small', type: 'uint8', offset: 0, byteLength: 1 },
	{ name: 'wide', type: 'uint64', offset: 8, byteLength: 8 },
]

const innerStruct: ContractStruct = {
	name: 'Inner',
	fields: [
		{ name: 'x', type: 'uint32', offset: 0, byteLength: 4 },
		{ name: 'y', type: 'uint64', offset: 8, byteLength: 8 },
	],
	byteLength: 16,
	alignment: 8,
}

const statusEnum: ContractEnum = {
	name: 'Status',
	underlyingType: 'uint8',
	byteLength: 1,
	values: [
		{ name: 'Pending', value: 0 },
		{ name: 'Done', value: 1 },
		{ name: 'Failed', value: 2 },
	],
}

const mixedFields: ContractField[] = [
	{ name: 'owner', type: 'id', offset: 0, byteLength: 32 },
	{
		name: 'status',
		type: 'enum',
		offset: 32,
		byteLength: 1,
		enumRef: 'Status',
	},
	{ name: 'enabled', type: 'bit', offset: 33, byteLength: 1 },
	{
		name: 'inner',
		type: 'struct',
		offset: 40,
		byteLength: 16,
		structRef: 'Inner',
	},
]

const orderArrayFields: ContractField[] = [
	{
		name: 'orders',
		type: 'array',
		offset: 0,
		byteLength: 64,
		array: {
			length: 4,
			itemType: 'struct',
			itemByteLength: 16,
			itemStructRef: 'Inner',
		},
	},
	{ name: 'total', type: 'uint64', offset: 64, byteLength: 8 },
]

const wideFields: ContractField[] = [
	{ name: 'amount', type: 'uint128', offset: 0, byteLength: 16 },
	{ name: 'delta', type: 'sint64', offset: 16, byteLength: 8 },
]

function call(
	kind: ContractCall['kind'],
	name: string,
	inputType: number | null,
	inputFields: ContractField[],
	inputSize: number,
	inputAlignment: number,
	outputFields: ContractField[] = [],
	outputSize = 0,
	outputAlignment = 1,
): ContractCall {
	return {
		kind,
		name,
		inputType,
		inputSize,
		outputSize,
		inputAlignment,
		outputAlignment,
		inputFields,
		outputFields,
	}
}

const placeOrder = call(
	'procedure',
	'placeOrder',
	100,
	headerFields,
	24,
	8,
	[{ name: 'ok', type: 'bool', offset: 0, byteLength: 1 }],
	1,
	1,
)

const submitOrders = call(
	'procedure',
	'submitOrders',
	101,
	orderArrayFields,
	72,
	8,
	[
		{
			name: 'status',
			type: 'enum',
			offset: 0,
			byteLength: 1,
			enumRef: 'Status',
		},
	],
	1,
	1,
)

const touchMixed = call('procedure', 'touchMixed', 102, mixedFields, 56, 8)

const signedWide = call('procedure', 'signedWide', 103, wideFields, 32, 16)

const quote = call(
	'function',
	'quote',
	200,
	[{ name: 'amount', type: 'uint64', offset: 0, byteLength: 8 }],
	8,
	8,
	[{ name: 'price', type: 'uint64', offset: 0, byteLength: 8 }],
	8,
	8,
)

const onOrder = call('notification', 'onOrder', null, [], 0, 1)

const definition: ContractDefinition = {
	index: 42,
	name: 'Test',
	assetName: 'TEST',
	contractAddress: contractIndexToIdentity(42),
	fileName: 'Test.h',
	constructionEpoch: null,
	destructionEpoch: null,
	stateSize: null,
	source: { path: 'src/contracts/Test.h', line: 1 },
	procedures: [placeOrder, submitOrders, touchMixed, signedWide],
	functions: [quote],
	notifications: [onOrder],
	structs: { Inner: innerStruct },
	enums: { Status: statusEnum },
}

const zeroIdentity = `${'A'.repeat(56)}FXIB`

describe('encodeStruct layout', () => {
	test('writes little-endian scalars at declared offsets and zeroes padding', () => {
		const data = encodeStruct(definition, headerFields, {
			a: 0x0102030405060708n,
			b: 0x0a0b0c0d,
			c: 0x1112131415161718n,
		})

		expect(data.byteLength).toBe(24)
		expect(Array.from(data.slice(0, 8))).toEqual([8, 7, 6, 5, 4, 3, 2, 1])
		expect(Array.from(data.slice(8, 12))).toEqual([0x0d, 0x0c, 0x0b, 0x0a])
		expect(Array.from(data.slice(12, 16))).toEqual([0, 0, 0, 0])
		expect(Array.from(data.slice(16, 24))).toEqual([
			0x18, 0x17, 0x16, 0x15, 0x14, 0x13, 0x12, 0x11,
		])
	})

	test('uint8 followed by uint64 keeps the natural padding gap', () => {
		const data = encodeStruct(definition, tightFields, {
			small: 0xff,
			wide: 1n,
		})
		expect(data.byteLength).toBe(16)
		expect(data[0]).toBe(0xff)
		expect(Array.from(data.slice(1, 8))).toEqual([0, 0, 0, 0, 0, 0, 0])
		expect(data[8]).toBe(1)
		expect(Array.from(data.slice(9, 16))).toEqual([0, 0, 0, 0, 0, 0, 0])
	})

	test('accepts decimal strings and bigints for 64-bit fields', () => {
		const data = encodeStruct(definition, headerFields, {
			a: '18446744073709551615',
			b: 0,
			c: 42n,
		})
		const decoded = decodeStruct(definition, headerFields, data)
		expect(decoded.a).toBe(18446744073709551615n)
		expect(decoded.c).toBe(42n)
	})

	test('accepts raw Uint8Array bytes for a field of matching width', () => {
		const raw = new Uint8Array(8).fill(0x11)
		const data = encodeStruct(definition, headerFields, {
			a: raw,
			b: 0,
			c: 0n,
		})
		expect(Array.from(data.slice(0, 8))).toEqual(Array.from(raw))
	})

	test('sizes structs using the provided alignment', () => {
		expect(getStructSize(definition, wideFields, 16)).toBe(32)
		expect(getStructSize(definition, headerFields, 8)).toBe(24)
		expect(getStructSize(definition, tightFields, 8)).toBe(16)
	})
})

describe('decodeStruct', () => {
	test('round-trips scalars, nested structs, enums, ids, and bits', () => {
		const encoded = encodeStruct(definition, mixedFields, {
			owner: zeroIdentity,
			status: 'Failed',
			enabled: true,
			inner: { x: 7, y: 9n },
		})

		expect(Array.from(encoded.slice(0, 32))).toEqual(
			Array.from(new Uint8Array(32)),
		)
		expect(encoded[32]).toBe(2)
		expect(encoded[33]).toBe(1)
		expect(Array.from(encoded.slice(34, 40))).toEqual([0, 0, 0, 0, 0, 0])
		expect(Array.from(encoded.slice(40, 44))).toEqual([7, 0, 0, 0])
		expect(Array.from(encoded.slice(44, 48))).toEqual([0, 0, 0, 0])
		expect(encoded[48]).toBe(9)

		const decoded = decodeStruct(definition, mixedFields, encoded, {
			enumFormat: 'name',
		})
		expect(decoded.owner).toBe(zeroIdentity)
		expect(decoded.status).toBe('Failed')
		expect(decoded.enabled).toBe(true)
		expect(decoded.inner).toEqual({ x: 7, y: 9n })
	})

	test('decodes enum numbers by default and labels on request', () => {
		const data = encodeStruct(definition, mixedFields, {
			owner: new Uint8Array(32),
			status: 'Done',
			enabled: false,
			inner: { x: 0, y: 0n },
		})
		expect(decodeStruct(definition, mixedFields, data).status).toBe(1)
		expect(
			decodeStruct(definition, mixedFields, data, { enumFormat: 'name' })
				.status,
		).toBe('Done')
	})

	test('uses a custom publicKeyToIdentity formatter for id output', () => {
		const data = encodeStruct(definition, mixedFields, {
			owner: new Uint8Array(32).fill(5),
		})
		const decoded = decodeStruct(definition, mixedFields, data, {
			publicKeyToIdentity: () => 'CUSTOM',
		})
		expect(decoded.owner).toBe('CUSTOM')
	})

	test('accepts output buffers longer than the struct but rejects short ones', () => {
		const data = encodeStruct(definition, headerFields, {
			a: 1n,
			b: 2,
			c: 3n,
		})
		const padded = new Uint8Array(40)
		padded.set(data)
		expect(decodeStruct(definition, headerFields, padded).a).toBe(1n)
		expect(() =>
			decodeStruct(definition, headerFields, data.slice(0, 23)),
		).toThrow(ContractAbiError)
	})
})

describe('arrays', () => {
	test('zero-fills a short fixed array tail and decodes full length', () => {
		const data = encodeStruct(definition, orderArrayFields, {
			orders: [
				{ x: 1, y: 2n },
				{ x: 3, y: 4n },
			],
			total: 5n,
		})
		expect(data.byteLength).toBe(72)
		expect(data[0]).toBe(1)
		expect(data[8]).toBe(2)
		expect(data[16]).toBe(3)
		expect(data[24]).toBe(4)
		expect(Array.from(data.slice(64, 72))).toEqual([5, 0, 0, 0, 0, 0, 0, 0])

		const decoded = decodeStruct(definition, orderArrayFields, data)
		expect(decoded.orders).toEqual([
			{ x: 1, y: 2n },
			{ x: 3, y: 4n },
			{ x: 0, y: 0n },
			{ x: 0, y: 0n },
		])
		expect(decoded.total).toBe(5n)
	})

	test('accepts raw bytes for the entire fixed array', () => {
		const raw = new Uint8Array(64).fill(0xaa)
		const data = encodeStruct(definition, orderArrayFields, {
			orders: raw,
			total: 0n,
		})
		expect(Array.from(data.slice(0, 64))).toEqual(Array.from(raw))
		const decoded = decodeStruct(definition, orderArrayFields, data)
		const orders = decoded.orders as Array<{ x: number; y: bigint }>
		expect(orders[0]).toEqual({
			x: 0xaaaaaaaa,
			y: 0xaaaaaaaaaaaaaaaan,
		})
	})

	test('accepts raw bytes for an individual struct element', () => {
		const rawElement = new Uint8Array(16)
		rawElement[0] = 6
		rawElement[8] = 7
		const data = encodeStruct(definition, orderArrayFields, {
			orders: [rawElement],
			total: 0n,
		})
		const decoded = decodeStruct(definition, orderArrayFields, data)
		expect(decoded.orders).toBeInstanceOf(Array)
		expect((decoded.orders as Array<{ x: number; y: bigint }>)[0]).toEqual({
			x: 6,
			y: 7n,
		})
	})

	test('rejects arrays with too many elements and reports the path', () => {
		expect(() =>
			encodeStruct(definition, orderArrayFields, {
				orders: [
					{ x: 1, y: 1n },
					{ x: 2, y: 2n },
					{ x: 3, y: 3n },
					{ x: 4, y: 4n },
					{ x: 5, y: 5n },
				],
			}),
		).toThrow(/input\.orders: expected at most 4 items/)
	})
})

describe('range validation', () => {
	test('reports the field path for out-of-range values', () => {
		expect(() =>
			encodeStruct(definition, headerFields, {
				a: 1n << 64n,
				b: 0,
				c: 0n,
			}),
		).toThrow(/input\.a/)
		expect(() =>
			encodeStruct(definition, headerFields, {
				a: 0n,
				b: -1,
				c: 0n,
			}),
		).toThrow(/input\.b/)
		expect(() =>
			encodeStruct(definition, wideFields, {
				amount: 1n << 128n,
				delta: 0n,
			}),
		).toThrow(/input\.amount/)
		expect(() =>
			encodeStruct(definition, wideFields, {
				amount: 0n,
				delta: -(1n << 63n) - 1n,
			}),
		).toThrow(/input\.delta/)
	})

	test('rejects unsafe JavaScript numbers for 64-bit fields', () => {
		expect(() =>
			encodeStruct(definition, headerFields, {
				a: Number.MAX_SAFE_INTEGER + 2,
				b: 0,
				c: 0n,
			}),
		).toThrow(/safe integer/)
	})

	test('encodes the full uint128 range and signed int64 bounds', () => {
		const data = encodeStruct(definition, wideFields, {
			amount: (1n << 128n) - 1n,
			delta: -(1n << 63n),
		})
		const decoded = decodeStruct(definition, wideFields, data)
		expect(decoded.amount).toBe((1n << 128n) - 1n)
		expect(decoded.delta).toBe(-(1n << 63n))
	})
})

describe('call input and output helpers', () => {
	test('encodes a procedure input into an EncodedContractCall', () => {
		const encoded = encodeCallInput(definition, placeOrder, {
			a: 1n,
			b: 2,
			c: 3n,
		})
		expect(encoded.contractIndex).toBe(42)
		expect(encoded.inputType).toBe(100)
		expect(encoded.inputSize).toBe(24)
		expect(encoded.payload.byteLength).toBe(24)
		expect(encoded.payload[0]).toBe(1)
		expect(encoded.payload[8]).toBe(2)
		expect(encoded.payload[16]).toBe(3)
	})

	test('resolves calls by name and decodes outputs', () => {
		const encoded = encodeCallInput(definition, 'quote', { amount: 9n })
		expect(encoded.inputType).toBe(200)
		expect(encoded.payload[0]).toBe(9)

		const output = new Uint8Array(8)
		output[0] = 12
		expect(decodeCallOutput(definition, 'quote', output).price).toBe(12n)
	})

	test('tolerates longer output buffers', () => {
		const output = new Uint8Array(16)
		output[0] = 1
		expect(decodeCallOutput(definition, placeOrder, output).ok).toBe(true)
	})

	test('rejects notification calls and unknown call names', () => {
		expect(() => encodeCallInput(definition, onOrder, {})).toThrow(
			/notification/i,
		)
		expect(() => encodeCallInput(definition, 'onOrder', {})).toThrow(
			/notification/i,
		)
		expect(() => encodeCallInput(definition, 'missing', {})).toThrow(
			/Unknown call/,
		)
	})

	test('round-trips a mixed struct through a call', () => {
		const payload = encodeCallInput(definition, 'touchMixed', {
			owner: new Uint8Array(32).fill(9),
			status: 'Pending',
			enabled: true,
			inner: { x: 11, y: 12n },
		}).payload
		expect(payload.byteLength).toBe(56)
		const decoded = decodeStruct(definition, mixedFields, payload, {
			enumFormat: 'name',
		})
		expect(decoded.status).toBe('Pending')
		expect(decoded.inner).toEqual({ x: 11, y: 12n })
	})

	test('default id output is the 60-character Qubic identity', () => {
		const payload = encodeCallInput(definition, 'touchMixed', {
			owner: new Uint8Array(32),
		}).payload
		const decoded = decodeStruct(definition, mixedFields, payload)
		expect(decoded.owner).toBe(publicKeyToIdentity(new Uint8Array(32)))
	})

	test('resolves calls by registered ordinal', () => {
		const procedureInput = encodeProcedureInput(definition, 100, {
			a: 2n,
			b: 3,
			c: 4n,
		})
		expect(procedureInput.inputType).toBe(100)
		expect(procedureInput.payload.byteLength).toBe(24)
		expect(decodeProcedureOutput(definition, 100, new Uint8Array([1])).ok).toBe(
			true,
		)

		const functionInput = encodeFunctionInput(definition, 200, { amount: 5n })
		expect(functionInput.inputType).toBe(200)
		const output = new Uint8Array(8)
		output[0] = 6
		expect(decodeFunctionOutput(definition, 200, output).price).toBe(6n)
	})
})
