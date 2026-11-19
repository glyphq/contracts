import { describe, expect, test } from 'bun:test'
import { decodeStruct, encodeStruct } from './codec.ts'
import { CONTRACT_METADATA } from './generated/metadata.ts'
import { qpi } from './generated/qpi.ts'
import { validateMetadata } from './lookup.ts'
import type { ContractDefinition, ContractStruct } from './types.ts'

const ROUND_TRIP_LIMIT = 2_000_000

function roundTrip(
	definition: ContractDefinition,
	struct: ContractStruct,
	enumFormat: 'number' | 'name' = 'number',
): void {
	const bytes = new Uint8Array(struct.byteLength)
	const decoded = decodeStruct(definition, struct.fields, bytes, {
		enumFormat,
		alignment: struct.alignment,
		idFormat: 'hex',
	})
	const encoded = encodeStruct(definition, struct.fields, decoded, {
		alignment: struct.alignment,
		size: struct.byteLength,
	})
	expect(encoded).toEqual(bytes)
}

describe('generated ABI coverage', () => {
	test('validates every generated struct layout', () => {
		validateMetadata(CONTRACT_METADATA)
	})

	test('round-trips every contract struct, including nested state structs', () => {
		let count = 0
		for (const contract of CONTRACT_METADATA.contracts) {
			for (const struct of Object.values(contract.structs)) {
				// State structs can be hundreds of megabytes because they embed
				// large fixed-capacity arrays. Their layout is covered by
				// validateMetadata above; materialising them would exhaust the
				// test runner's memory.
				if (struct.byteLength > ROUND_TRIP_LIMIT) continue
				roundTrip(contract, struct)
				roundTrip(contract, struct, 'name')
				count++
			}
		}
		expect(count).toBeGreaterThan(500)
	})

	test('round-trips every shared QPI struct', () => {
		for (const struct of Object.values(qpi.structs)) {
			roundTrip(qpi.definition, struct)
			roundTrip(qpi.definition, struct, 'name')
		}
		expect(qpi.hasStruct('Entity')).toBe(true)
		expect(qpi.hasStruct('QPI::ProposalDataV1')).toBe(true)
		expect(qpi.size('NoData')).toBe(1)
		expect(qpi.encode('NoData', {})).toEqual(new Uint8Array([0]))
		expect(qpi.size('QPI::ProposalDataV1')).toBe(328)
		expect(qpi.size('QPI::ProposalDataYesNo')).toBe(304)
	})

	test('round-trips every call input and output', () => {
		for (const contract of CONTRACT_METADATA.contracts) {
			for (const call of [
				...contract.procedures,
				...contract.functions,
				...contract.notifications,
			]) {
				if (call.inputType !== null) {
					const payload = new Uint8Array(call.inputSize)
					const decoded = decodeStruct(contract, call.inputFields, payload, {
						alignment: call.inputAlignment,
						idFormat: 'hex',
					})
					expect(
						encodeStruct(contract, call.inputFields, decoded, {
							alignment: call.inputAlignment,
							size: call.inputSize,
						}),
					).toEqual(payload)
				}
				const output = new Uint8Array(call.outputSize)
				const decoded = decodeStruct(contract, call.outputFields, output, {
					alignment: call.outputAlignment,
					idFormat: 'hex',
				})
				expect(
					encodeStruct(contract, call.outputFields, decoded, {
						alignment: call.outputAlignment,
						size: call.outputSize,
					}),
				).toEqual(output)
			}
		}
	})
})
