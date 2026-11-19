/**
 * Parser/tokenizer tests for the restricted QPI C++ subset.
 *
 * The checked-in fixtures cover the syntax the parser must support. The
 * real-header tests read a local qubic/core clone when one is available
 * (`QUBIC_CORE` or `$JCODE_SCRATCH_DIR/qubic-research/core`) and are skipped
 * otherwise, so the suite stays hermetic in CI.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
	evaluateIntegerExpression,
	parseContractDef,
	parseCppFile,
	preprocess,
	qualifyTypeName,
	tokenize,
} from './cpp.js'
import type { CppField, CppStruct } from './model.js'

const fixtures = join(import.meta.dir, '../../fixtures/cpp')
const basicSource = readFileSync(join(fixtures, 'basic.h'), 'utf8')
const contractDefSource = readFileSync(join(fixtures, 'contract_def.h'), 'utf8')

/** Read a struct by simple name from a parsed file. */
function struct(
	file: ReturnType<typeof parseCppFile>,
	name: string,
): CppStruct {
	const found = file.structs.find((s) => s.name === name)
	if (!found) throw new Error(`missing struct ${name}`)
	return found
}

/**
 * Natural C++ size for a flat struct of scalars. This is test-local on
 * purpose: the reusable layout engine lives in the build layer.
 */
const SCALAR_SIZE: Record<string, number> = {
	uint8: 1,
	sint8: 1,
	bool: 1,
	bit: 1,
	uint16: 2,
	sint16: 2,
	uint32: 4,
	sint32: 4,
	uint64: 8,
	sint64: 8,
	uint128: 16,
	id: 32,
}

function naturalScalarSize(fields: CppField[]): number {
	let offset = 0
	let alignment = 1
	for (const field of fields) {
		const size = SCALAR_SIZE[field.type.name]
		if (size === undefined) throw new Error(`not a scalar: ${field.type.name}`)
		offset = Math.ceil(offset / size) * size
		offset += size
		alignment = Math.max(alignment, size)
	}
	return Math.ceil(offset / alignment) * alignment
}

describe('tokenizer', () => {
	test('emits doc comments and tracks lines', () => {
		const tokens = tokenize(
			'/** @brief Doc. */\nstruct X\n{\n\tuint64 n;\n};\n',
		)
		const doc = tokens.find((t) => t.kind === 'doc')
		expect(doc?.value).toBe('@brief Doc.')
		expect(doc?.line).toBe(1)
		const structToken = tokens.find((t) => t.value === 'struct')
		expect(structToken?.line).toBe(2)
		const field = tokens.find((t) => t.value === 'n')
		expect(field?.line).toBe(4)
	})

	test('discards ordinary comments but keeps /// docs', () => {
		const tokens = tokenize('// ignored\n/// kept\nuint8 x;\n')
		const docs = tokens.filter((t) => t.kind === 'doc')
		expect(docs.map((t) => t.value)).toEqual(['kept'])
	})
})

describe('preprocessor-lite', () => {
	test('skips #if 0 and records includes/macros', () => {
		const text = [
			'#define LIMIT 8',
			'#include "contracts/Foo.h"',
			'#if 0',
			'struct Hidden { uint64 n; };',
			'#endif',
			'struct Visible { uint64 n; };',
		].join('\n')
		const pre = preprocess(text)
		expect(pre.includes).toEqual(['contracts/Foo.h'])
		expect(pre.macros.map((m) => [m.name, m.value])).toEqual([['LIMIT', '8']])
		expect(pre.text).not.toContain('Hidden')
		expect(pre.text.split('\n')).toHaveLength(6)
		expect(pre.text).toContain('struct Visible')
	})
})

describe('fixture parser', () => {
	const file = parseCppFile(basicSource, 'fixtures/cpp/basic.h')

	test('parses structs, nesting, and skips #if 0', () => {
		expect(file.structs.map((s) => s.name)).toContain('Container')
		expect(file.structs.map((s) => s.name)).not.toContain('Hidden')
		const order = struct(file, 'Order')
		expect(order.qualifiedName).toBe('Container::Order')
		expect(order.scope).toBe('Container')
		expect(order.fields.map((f) => [f.name, f.type.name])).toEqual([
			['entity', 'id'],
			['price', 'sint64'],
		])

		const nested = struct(file, 'Container').nestedStructs.map(
			(s) => s.qualifiedName,
		)
		expect(nested).toContain('Container::Order')
		expect(nested).toContain('Container::DoThing_input')
	})

	test('parses multi-declarators, arrays, templates, and enum fields', () => {
		const input = struct(file, 'DoThing_input')
		expect(input.fields.map((f) => f.name)).toEqual([
			'amount',
			'count',
			'orders',
			'flags',
			'color',
			'mode',
			'asset',
		])
		expect(input.fields[0]?.type.name).toBe('uint64')
		expect(input.fields[1]?.type.name).toBe('uint64')

		const orders = input.fields.find((f) => f.name === 'orders')!
		expect(orders.type.name).toBe('Array')
		expect(orders.type.templateArgs?.[0]).toEqual({
			kind: 'type',
			type: { name: 'Order' },
		})
		expect(orders.type.templateArgs?.[1]).toEqual({
			kind: 'value',
			expression: 'MAX_ORDERS',
		})

		const flags = input.fields.find((f) => f.name === 'flags')!
		expect(flags.type.name).toBe('BitArray')
		expect(flags.type.templateArgs?.[0]).toEqual({
			kind: 'value',
			expression: '64',
		})

		expect(input.fields.find((f) => f.name === 'color')?.type.name).toBe(
			'Color',
		)
		expect(input.fields.find((f) => f.name === 'mode')?.type.name).toBe('Mode')
		expect(input.fields.find((f) => f.name === 'asset')?.type.name).toBe(
			'QPI::Asset',
		)
	})

	test('parses enums with underlying types and implicit/explicit values', () => {
		const color = file.enums.find((e) => e.name === 'Color')!
		expect(color.underlyingType).toBe('uint8')
		expect(color.isScoped).toBe(false)
		expect(color.values.map((v) => [v.name, v.value])).toEqual([
			['Red', 0],
			['Green', 5],
			['Blue', 6],
		])

		const mode = file.enums.find((e) => e.name === 'Mode')!
		expect(mode.underlyingType).toBe('uint16')
		expect(mode.isScoped).toBe(true)
		expect(mode.values.map((v) => [v.name, v.value])).toEqual([
			['Idle', 1],
			['Busy', 2],
		])
	})

	test('resolves constexpr constants and macros', () => {
		const byName = new Map(file.constants.map((c) => [c.name, c.value]))
		expect(byName.get('MAX_ORDERS')).toBe(4)
		expect(byName.get('LEGACY_LIMIT')).toBe(8)
		expect(byName.get('LOCAL_LIMIT')).toBe(8)
	})

	test('captures typedefs and using aliases', () => {
		const aliases = new Map(file.typedefs.map((t) => [t.name, t]))
		expect(aliases.get('OrderArray')?.kind).toBe('using')
		expect(aliases.get('OrderArray')?.target.name).toBe('Array')
		expect(aliases.get('DoThing_locals')?.target.name).toBe('NoData')
		expect(aliases.get('SmallIndex')?.target.name).toBe('uint16')
	})

	test('parses call declarations and registration ids', () => {
		const doThing = file.calls.find((c) => c.name === 'DoThing')!
		expect(doThing.kind).toBe('procedure')
		expect(doThing.visibility).toBe('public')
		expect(doThing.hasLocals).toBe(true)
		expect(doThing.inputStructRef).toBe('Container::DoThing_input')
		expect(doThing.description).toBe('@brief Does the thing.')

		const fire = file.calls.find((c) => c.name === 'Fire')!
		expect(fire.visibility).toBe('private')
		expect(fire.kind).toBe('procedure')

		const byName = new Map(file.registrations.map((r) => [r.name, r]))
		expect(byName.get('DoThing')?.inputType).toBe(8)
		expect(byName.get('Fire')?.inputType).toBe(2)
		expect(byName.get('Notify')?.kind).toBe('notification')
		expect(byName.get('Notify')?.inputType).toBeNull()
	})

	test('attaches doc comments to structs and fields', () => {
		expect(struct(file, 'Point').description).toBe(
			'A plain nested-free struct.',
		)
		expect(struct(file, 'Order').description).toBe('@brief One order.')
		const input = struct(file, 'DoThing_input')
		expect(input.description).toBe(
			'@brief Input of DoThing.\n@note Exercises multi-declarators, arrays, and enum fields.',
		)
		expect(input.fields.find((f) => f.name === 'amount')?.description).toBe(
			'Number of units.',
		)
	})

	test('qualifies relative type names against the scope', () => {
		const known = new Set(file.structs.map((s) => s.qualifiedName))
		expect(qualifyTypeName('Order', 'Container::DoThing_input', known)).toBe(
			'Container::Order',
		)
		expect(qualifyTypeName('Point', 'Container', known)).toBe('Point')
		expect(qualifyTypeName('Missing', 'Container', known)).toBe('Missing')
	})
})

describe('integer expressions', () => {
	const constants = new Map<string, number>([
		['MAX', 4],
		['Mode::Busy', 2],
	])

	test('evaluates arithmetic, literals, and casts', () => {
		expect(evaluateIntegerExpression('2 * MAX', constants)).toBe(8)
		expect(evaluateIntegerExpression('0x10 + 0b10', constants)).toBe(18)
		expect(evaluateIntegerExpression('(1 << 4) | 3', constants)).toBe(19)
		expect(
			evaluateIntegerExpression('static_cast<uint16>(Mode::Busy)', constants),
		).toBe(2)
		expect(evaluateIntegerExpression('MAX / 2', constants)).toBe(2)
	})

	test('returns null for unresolved or unsupported expressions', () => {
		expect(evaluateIntegerExpression('UNKNOWN + 1', constants)).toBeNull()
		expect(evaluateIntegerExpression('sizeof(Foo)', constants)).toBeNull()
		expect(evaluateIntegerExpression('', constants)).toBeNull()
	})
})

describe('contract_def.h', () => {
	test('extracts indices, state types, includes, and descriptions', () => {
		const def = parseContractDef(contractDefSource)
		expect(def.entries.map((e) => e.index)).toEqual([1, 2])

		const first = def.byIndex.get(1)!
		expect(first.stateType).toBe('FIRST')
		expect(first.state2Type).toBe('FIRST2')
		expect(first.fileName).toBe('First.h')
		expect(first.includePath).toBe('contracts/First.h')
		expect(first.assetName).toBe('FIRST')
		expect(first.constructionEpoch).toBe(10)
		expect(first.destructionEpoch).toBe(10000)
		expect(first.stateSizeExpression).toBe('FIRST::StateData')
		expect(def.byStateType.get('SECOND')?.index).toBe(2)

		// Test contracts and test descriptions are excluded.
		expect(def.byIndex.has(3)).toBe(false)
		expect(def.entries.map((e) => e.assetName)).toEqual(['FIRST', 'SECOND'])
	})
})

/* -------------------------------------------------------------------------- */
/* Real qubic/core headers (optional)                                         */
/* -------------------------------------------------------------------------- */

const coreRoot =
	process.env.QUBIC_CORE ??
	(process.env.JCODE_SCRATCH_DIR
		? join(process.env.JCODE_SCRATCH_DIR, 'qubic-research/core')
		: undefined)
const coreSrc = coreRoot ? join(coreRoot, 'src') : undefined
const hasCore =
	coreSrc !== undefined && existsSync(join(coreSrc, 'contracts/Qx.h'))

function parseCore(fileName: string) {
	const path = join(coreSrc!, 'contracts', fileName)
	return parseCppFile(readFileSync(path, 'utf8'), `contracts/${fileName}`)
}

describe.skipIf(!hasCore)('real headers', () => {
	test('Qx: structs, calls, registrations, and natural input sizes', () => {
		const qx = parseCore('Qx.h')
		expect(qx.contractClasses.map((c) => c.qualifiedName)).toContain('QX')

		const issue = struct(qx, 'IssueAsset_input')
		expect(issue.fields.map((f) => [f.name, f.type.name])).toEqual([
			['assetName', 'uint64'],
			['numberOfShares', 'sint64'],
			['unitOfMeasurement', 'uint64'],
			['numberOfDecimalPlaces', 'sint8'],
		])
		expect(naturalScalarSize(issue.fields)).toBe(32)

		const fees = struct(qx, 'Fees_output')
		expect(naturalScalarSize(fees.fields)).toBe(12)

		const ask = struct(qx, 'AssetAskOrders_output')
		const orders = ask.fields.find((f) => f.name === 'orders')!
		expect(orders.type.name).toBe('Array')
		expect(orders.type.templateArgs?.[0]).toEqual({
			kind: 'type',
			type: { name: 'Order' },
		})
		expect(orders.type.templateArgs?.[1]).toEqual({
			kind: 'value',
			expression: '256',
		})
		expect(
			qx.structs.some(
				(s) => s.qualifiedName === 'QX::AssetAskOrders_output::Order',
			),
		).toBe(true)

		expect(qx.calls.find((c) => c.name === 'IssueAsset')?.kind).toBe(
			'procedure',
		)
		expect(qx.calls.find((c) => c.name === 'Fees')?.kind).toBe('function')
		expect(
			qx.calls.find((c) => c.name === '_NumberOfReservedShares')?.visibility,
		).toBe('private')

		const registrations = new Map(qx.registrations.map((r) => [r.name, r]))
		expect(registrations.get('IssueAsset')?.inputType).toBe(1)
		expect(registrations.get('TransferShareManagementRights')?.inputType).toBe(
			9,
		)
		expect(
			qx.registrations.filter(
				(r) => r.inputType === null && r.kind !== 'notification',
			),
		).toHaveLength(0)
	})

	test('Qearn: constants, arrays lengths, and enums', () => {
		const qearn = parseCore('Qearn.h')
		const constants = new Map(qearn.constants.map((c) => [c.name, c.value]))
		expect(constants.get('QEARN_MAX_LOCKS')).toBe(4194304)
		expect(constants.get('QEARN_MAX_EPOCHS')).toBe(4096)
		expect(constants.get('QEARN_INITIAL_EPOCH')).toBe(138)

		const state = struct(qearn, 'StateData')
		const rounds = state.fields.find((f) => f.name === '_initialRoundInfo')!
		expect(rounds.type.name).toBe('Array')
		expect(rounds.type.templateArgs?.[0]).toEqual({
			kind: 'type',
			type: { name: 'RoundInfo' },
		})
		expect(rounds.type.templateArgs?.[1]).toEqual({
			kind: 'value',
			expression: 'QEARN_MAX_EPOCHS',
		})

		const logInfo = qearn.enums.find((e) => e.name === 'QEARNLogInfo')!
		expect(logInfo.values.map((v) => [v.name, v.value])).toEqual([
			['QearnSuccessLocking', 0],
			['QearnFailedTransfer', 1],
			['QearnLimitLocking', 2],
			['QearnOverflowUser', 3],
			['QearnInvalidInput', 4],
			['QearnSuccessEarlyUnlocking', 5],
			['QearnSuccessFullyUnlocking', 6],
		])
	})

	test('QUtil: shareholder voting expansion and notifications', () => {
		const qutil = parseCore('QUtil.h')
		const shareholderCalls = qutil.calls
			.filter(
				(c) => c.scope === 'QUTIL' && /^(Set|Get)Shareholder/.test(c.name),
			)
			.map((c) => c.name)
		expect(shareholderCalls).toEqual([
			'SetShareholderProposal',
			'GetShareholderProposal',
			'GetShareholderProposalIndices',
			'GetShareholderProposalFees',
			'SetShareholderVotes',
			'GetShareholderVotes',
			'GetShareholderVotingResults',
		])

		const byName = new Map(qutil.registrations.map((r) => [r.name, r]))
		expect(
			qutil.registrations
				.filter((r) => r.kind !== 'notification')
				.every((r) => typeof r.inputTypeExpression === 'string'),
		).toBe(true)
		expect(byName.get('GetShareholderProposalFees')?.inputType).toBe(65531)
		expect(byName.get('GetShareholderProposalIndices')?.inputType).toBe(65532)
		expect(byName.get('GetShareholderProposal')?.inputType).toBe(65533)
		expect(byName.get('GetShareholderVotes')?.inputType).toBe(65534)
		expect(byName.get('GetShareholderVotingResults')?.inputType).toBe(65535)
		expect(byName.get('SetShareholderProposal')?.inputType).toBe(65534)
		expect(byName.get('SetShareholderVotes')?.inputType).toBe(65535)
		expect(byName.get('NotifyPriceOracleReply')?.kind).toBe('notification')
		expect(byName.get('NotifyPriceOracleReply')?.inputType).toBeNull()

		expect(
			qutil.structs.some((s) => s.name === 'GetShareholderProposal_output'),
		).toBe(true)
		expect(
			qutil.typedefs.find((t) => t.name === 'SetShareholderVotes_input')?.target
				.name,
		).toBe('QPI::ProposalMultiVoteDataV1')
	})

	test('Nostromo: scoped enums and static_cast registration ids', () => {
		const nost = parseCore('Nostromo.h')
		const procedureId = nost.enums.find((e) => e.name === 'EProcedureId')!
		expect(procedureId.underlyingType).toBe('uint8')
		expect(procedureId.isScoped).toBe(true)
		expect(procedureId.values[0]).toMatchObject({
			name: 'CreateAuction',
			value: 1,
		})

		const functionId = nost.enums.find((e) => e.name === 'EFunctionId')!
		expect(functionId.underlyingType).toBe('uint16')
		expect(
			functionId.values.find((v) => v.name === 'GetNostromoFeePool')?.value,
		).toBe(24)

		const registrations = new Map(nost.registrations.map((r) => [r.name, r]))
		expect(registrations.get('CreateAuction')?.inputType).toBe(1)
		expect(registrations.get('PlaceBid')?.inputType).toBe(2)
		expect(registrations.get('GetAuctionByIndex')?.inputType).toBe(1)
		expect(
			nost.registrations.filter(
				(r) => r.inputType === null && r.kind !== 'notification',
			),
		).toHaveLength(0)

		const core = struct(nost, 'AuctionCore')
		const status = core.fields.find((f) => f.name === 'status')
		expect(status?.type.name).toBe('EAuctionStatus')
	})
})
