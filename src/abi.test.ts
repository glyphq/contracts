import { describe, expect, test } from 'bun:test'
import type { ContractShape } from './abi.js'
import { createContractHandle, defineContract } from './abi.js'
import { encodeCallInput } from './codec.js'
import { ContractNotFoundError } from './errors.js'
import { contractIndexToIdentity, publicKeyToIdentity } from './identity.js'
import {
	ContractRegistry,
	createContractIndex,
	getContract,
	requireContract,
} from './registry.js'
import {
	ContractAbiError,
	type ContractCall,
	type ContractDefinition,
	type ContractField,
	type ContractMetadata,
} from './types.js'

const headerFields: ContractField[] = [
	{ name: 'a', type: 'uint64', offset: 0, byteLength: 8 },
	{ name: 'b', type: 'uint32', offset: 8, byteLength: 4 },
	{ name: 'c', type: 'uint64', offset: 16, byteLength: 8 },
]

function makeCall(
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

const placeOrder = makeCall(
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

const quote = makeCall(
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

const onOrder = makeCall('notification', 'onOrder', null, [], 0, 1)

const definition: ContractDefinition = {
	index: 42,
	name: 'Test',
	assetName: 'TST',
	contractAddress: contractIndexToIdentity(42),
	fileName: 'Test.h',
	constructionEpoch: null,
	destructionEpoch: null,
	stateSize: null,
	source: { path: 'src/contracts/Test.h', line: 1 },
	procedures: [placeOrder],
	functions: [quote],
	notifications: [onOrder],
	structs: {},
	enums: {},
}

const other: ContractDefinition = {
	...definition,
	index: 43,
	name: 'Other',
	assetName: 'OTH',
	contractAddress: contractIndexToIdentity(43),
	procedures: [],
	functions: [],
	notifications: [],
}

interface TestShape extends ContractShape {
	procedures: {
		placeOrder: {
			input: { a: bigint; b: number; c: bigint }
			output: { ok: boolean }
		}
	}
	functions: {
		quote: { input: { amount: bigint }; output: { price: bigint } }
	}
}

describe('defineContract', () => {
	test('exposes contract metadata and call maps', () => {
		const handle = defineContract<TestShape>(definition)
		expect(handle.contractIndex).toBe(42)
		expect(handle.name).toBe('Test')
		expect(handle.assetName).toBe('TST')
		expect(handle.contractAddress).toBe(contractIndexToIdentity(42))
		expect(handle.definition).toBe(definition)
		expect(handle.procedures.placeOrder?.inputType).toBe(100)
		expect(handle.functions.quote?.inputType).toBe(200)
		expect(handle.notifications.onOrder?.inputType).toBeNull()
	})

	test('encodes procedure inputs and matches the low-level helper', () => {
		const handle = defineContract<TestShape>(definition)
		const input = { a: 1n, b: 2, c: 3n }
		const payload = handle.encodeProcedure('placeOrder', input)
		expect(payload).toEqual(
			encodeCallInput(definition, placeOrder, input).payload,
		)
		expect(payload.byteLength).toBe(24)
	})

	test('decodes typed procedure output', () => {
		const handle = defineContract<TestShape>(definition)
		const data = new Uint8Array([1, 0, 0, 0])
		const output = handle.decodeProcedureOutput('placeOrder', data)
		expect(output.ok).toBe(true)
	})

	test('encodes functions and returns inferred output types', () => {
		const handle = defineContract<TestShape>(definition)
		const payload = handle.encodeFunction('quote', { amount: 8n })
		expect(payload.byteLength).toBe(8)
		expect(payload[0]).toBe(8)

		const data = new Uint8Array(8)
		data[0] = 21
		const output: { price: bigint } = handle.decodeFunctionOutput('quote', data)
		expect(output.price).toBe(21n)
	})

	test('aliases resolve names across procedures and functions', () => {
		const handle = defineContract<TestShape>(definition)
		const payload = handle.encodeInput('placeOrder', {
			a: 1n,
			b: 2,
			c: 3n,
		})
		expect(payload.byteLength).toBe(24)
		expect(handle.decodeOutput('quote', new Uint8Array(8))).toEqual({
			price: 0n,
		})
	})

	test('works without an explicit shape', () => {
		const handle = createContractHandle(definition)
		expect(
			handle.encodeProcedure('placeOrder', { a: 1n, b: 2, c: 3n }).byteLength,
		).toBe(24)
	})

	test('throws ContractAbiError for unknown call names', () => {
		const handle = defineContract<TestShape>(definition)
		expect(() =>
			(
				handle as unknown as {
					encodeProcedure: (name: string, input: object) => Uint8Array
				}
			).encodeProcedure('missing', {}),
		).toThrow(ContractAbiError)
		expect(() =>
			(
				handle as unknown as {
					encodeFunction: (name: string, input: object) => Uint8Array
				}
			).encodeFunction('missing', {}),
		).toThrow(ContractAbiError)
		expect(() => handle.encodeInput('missing', {})).toThrow(ContractAbiError)
	})

	test('rejects notification calls through the loose alias', () => {
		const handle = defineContract<TestShape>(definition)
		expect(() => handle.encodeInput('onOrder', {})).toThrow(/notification/i)
	})

	test('checks call names and inputs at compile time', () => {
		const handle = defineContract<TestShape>(definition)
		// @ts-expect-error unknown procedure name
		expect(() => handle.encodeProcedure('missing', {})).toThrow()
		// @ts-expect-error amount must be a bigint
		handle.encodeFunction('quote', { amount: 1 })
		expect(() =>
			// @ts-expect-error unknown function name
			handle.decodeFunctionOutput('missing', new Uint8Array()),
		).toThrow()
	})
})

describe('registry', () => {
	test('indexes by index, name, and asset name case-insensitively', () => {
		const index = createContractIndex([definition, other])
		expect(getContract(index, 42)).toBe(definition)
		expect(getContract(index, '42')).toBe(definition)
		expect(getContract(index, 'test')).toBe(definition)
		expect(getContract(index, 'TeSt')).toBe(definition)
		expect(getContract(index, 'tst')).toBe(definition)
		expect(getContract(index, 'other')).toBe(other)
		expect(getContract(index, 'missing')).toBeUndefined()
	})

	test('accepts a raw contract array', () => {
		expect(getContract([definition, other], 43)).toBe(other)
		expect(getContract([definition, other], 'OTH')).toBe(other)
	})

	test('requireContract throws ContractNotFoundError', () => {
		expect(requireContract([definition], 42)).toBe(definition)
		expect(() => requireContract([definition], 99)).toThrow(
			ContractNotFoundError,
		)
		expect(() => requireContract([definition], 'missing')).toThrow(
			ContractNotFoundError,
		)
	})

	test('ContractRegistry wraps the index', () => {
		const registry = new ContractRegistry([definition, other])
		expect(registry.size).toBe(2)
		expect(registry.has('Test')).toBe(true)
		expect(registry.has(99)).toBe(false)
		expect(registry.get('tst')).toBe(definition)
		expect(registry.require(43)).toBe(other)
	})

	test('accepts ContractMetadata', () => {
		const metadata: ContractMetadata = {
			schemaVersion: 1,
			source: {
				repository: 'qubic/core',
				ref: 'main',
				commit: '0'.repeat(40),
				commitDate: '2026-01-01T00:00:00.000Z',
			},
			contracts: [definition, other],
		}
		expect(getContract(metadata, 42)).toBe(definition)
		expect(getContract(metadata, 'other')).toBe(other)
		expect(new ContractRegistry(metadata).size).toBe(2)
	})

	test('contractAddress matches the deterministic identity', () => {
		expect(definition.contractAddress).toBe(contractIndexToIdentity(42))
		expect(publicKeyToIdentity(new Uint8Array(32))).toBe(
			`${'A'.repeat(56)}FXIB`,
		)
	})
})
