import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
	buildContractAbi,
	buildLayout,
	ContractLayoutError,
	CppLayoutEngine,
} from '../layout.ts'
import {
	type CppStructDecl,
	type CppTypeRef,
	parseContract,
} from '../parser.ts'
import type { ContractCall, ContractField, ContractStruct } from '../types.ts'

const fixtures = join(import.meta.dir, '..', '..', 'fixtures')
const simpleSource = readFileSync(
	join(fixtures, 'contracts', 'simple-contract.h'),
	'utf8',
)
const tokenSource = readFileSync(
	join(fixtures, 'contracts', 'token-contract.h'),
	'utf8',
)
const casesSource = readFileSync(join(fixtures, 'layout-cases.h'), 'utf8')

function named(name: string): CppTypeRef {
	return { kind: 'named', name, qualifiers: [], templateArgs: [] }
}

function findContractStruct(
	contract: CppStructDecl,
	name: string,
): CppStructDecl {
	const walk = (decl: CppStructDecl): CppStructDecl | undefined => {
		if (decl.name === name) return decl
		for (const child of decl.structs) {
			const found = walk(child)
			if (found !== undefined) return found
		}
		return undefined
	}
	const found = walk(contract)
	if (found === undefined) throw new Error(`Missing fixture struct ${name}`)
	return found
}

function field(fields: readonly ContractField[], name: string): ContractField {
	const found = fields.find((entry) => entry.name === name)
	if (found === undefined) throw new Error(`Missing field ${name}`)
	return found
}

function call(calls: readonly ContractCall[], name: string): ContractCall {
	const found = calls.find((entry) => entry.name === name)
	if (found === undefined) throw new Error(`Missing call ${name}`)
	return found
}

function struct(
	structs: Record<string, ContractStruct>,
	name: string,
): ContractStruct {
	const found = structs[name]
	if (found === undefined) throw new Error(`Missing struct ${name}`)
	return found
}

describe('CppLayoutEngine natural alignment', () => {
	const { parsed, engine } = buildLayout(casesSource, {
		fileName: 'layout-cases.h',
	})
	const byName = new Map(parsed.module.structs.map((decl) => [decl.name, decl]))

	const cases: [string, number, number, Record<string, number>][] = [
		['EmptyCase', 1, 1, {}],
		['ScalarCase', 24, 8, { first: 0, second: 4, third: 8, fourth: 16 }],
		['NestedCase', 32, 8, { scalars: 0, tail: 24 }],
		['ArrayCase', 72, 8, { values: 0, ids: 8 }],
		['UnionCase', 16, 8, { small: 0, large: 0, bytes: 0 }],
		['UnionHolder', 24, 8, { value: 0, tag: 16 }],
		['AlignmentCase', 32, 8, { lead: 0, wide: 8, trail: 24 }],
		['QpiContainersCase', 152, 8, { items: 0, bits: 128 }],
	]

	for (const [name, size, alignment, offsets] of cases) {
		test(`lays out ${name}`, () => {
			const decl = byName.get(name)
			expect(decl).toBeDefined()
			const layout = engine.layoutStruct(decl as CppStructDecl)
			expect(layout.size).toBe(size)
			expect(layout.alignment).toBe(alignment)
			for (const [fieldName, offset] of Object.entries(offsets)) {
				const layoutField = layout.fields.find(
					(entry) => entry.name === fieldName,
				)
				expect(layoutField?.offset).toBe(offset)
			}
		})
	}

	test('uses natural sizes for scalars and QPI fundamentals', () => {
		const decl: CppStructDecl = {
			kind: 'struct',
			name: 'Scalars',
			qualifiedName: 'Scalars',
			bases: [],
			fields: [
				{ name: 'flag', type: named('bool'), line: 1 },
				{ name: 'tiny', type: named('bit'), line: 1 },
				{ name: 'identity', type: named('id'), line: 1 },
				{ name: 'wide', type: named('uint128'), line: 1 },
			],
			structs: [],
			enums: [],
			typedefs: [],
			calls: [],
			registrations: [],
			line: 1,
		}
		const layout = engine.layoutStruct(decl)
		expect(
			layout.fields.map((entry) => [entry.name, entry.offset, entry.size]),
		).toEqual([
			['flag', 0, 1],
			['tiny', 1, 1],
			['identity', 8, 32],
			['wide', 40, 16],
		])
		expect(layout.size).toBe(56)
		expect(layout.alignment).toBe(8)
	})

	test('evaluates array bounds from #define and constexpr constants', () => {
		const arrayCase = byName.get('ArrayCase')
		const layout = engine.layoutStruct(arrayCase as CppStructDecl)
		const values = layout.fields.find((entry) => entry.name === 'values')
		expect(values?.type.kind).toBe('array')
		expect(values?.type.kind === 'array' ? values.type.length : undefined).toBe(
			4,
		)
		expect(values?.size).toBe(8)
	})

	test('resolves enum underlying type, size, and values', () => {
		const enumDecl = parsed.module.enums[0]
		expect(enumDecl).toBeDefined()
		const resolved = engine.resolveType(named('CaseStatus'))
		expect(resolved.kind).toBe('enum')
		if (resolved.kind !== 'enum') return
		expect(resolved.size).toBe(1)
		expect(resolved.alignment).toBe(1)
		expect(resolved.values).toEqual([
			{ name: 'CASE_PENDING', value: 1 },
			{ name: 'CASE_ACTIVE', value: 2 },
			{ name: 'CASE_DISABLED', value: 8 },
		])
	})

	test('rejects recursive by-value layouts', () => {
		const source = 'struct A { B b; }; struct B { A a; };'
		const { parsed: recursive, engine: recursiveEngine } = buildLayout(source)
		const first = recursive.module.structs[0] as CppStructDecl
		expect(() => recursiveEngine.layoutStruct(first)).toThrow(
			ContractLayoutError,
		)
	})

	test('evaluates constant expressions with C++ integer semantics', () => {
		const { engine: expressionEngine } = buildLayout(
			'#define A 3\n#define B (A * 4 + 2)\nconstexpr uint64 C = B << 1;\nstruct X {};',
		)
		expect(expressionEngine.evaluate('B')).toBe(14)
		expect(expressionEngine.evaluate('C')).toBe(28)
		expect(expressionEngine.evaluate('(1 + 2) * 3')).toBe(9)
		expect(expressionEngine.evaluate('0x10 | 0b1')).toBe(17)
	})
})

describe('contract ABI', () => {
	test('builds calls, sizes, alignments, and metadata for the simple contract', () => {
		const abi = buildContractAbi(simpleSource, {
			fileName: 'simple-contract.h',
			contractIndex: 42,
			assetName: 'SIMPLE',
			sourcePath: 'src/contracts/Simple.h',
		})
		expect(abi.index).toBe(42)
		expect(abi.name).toBe('SIMPLE')
		expect(abi.assetName).toBe('SIMPLE')
		expect(abi.sourcePath).toBe('src/contracts/Simple.h')
		expect(abi.line).toBe(12)
		expect(abi.stateSize).toBe(176)
		expect(abi.state?.name).toBe('SIMPLE::StateData')

		expect(
			abi.functions.map((entry) => [
				entry.name,
				entry.inputType,
				entry.inputSize,
				entry.outputSize,
			]),
		).toEqual([
			['Ping', 1, 1, 8],
			['Query', 2, 4, 392],
		])
		expect(
			abi.procedures.map((entry) => [
				entry.name,
				entry.inputType,
				entry.inputSize,
				entry.outputSize,
			]),
		).toEqual([['Add', 1, 40, 8]])
		expect(abi.notifications).toEqual([])

		const ping = call(abi.functions, 'Ping')
		expect(ping.inputFields).toEqual([])
		expect(field(ping.outputFields, 'value').offset).toBe(0)
		expect(field(ping.outputFields, 'value').byteLength).toBe(8)

		const add = call(abi.procedures, 'Add')
		expect(add.inputAlignment).toBe(8)
		expect(field(add.inputFields, 'owner').type).toBe('id')
		expect(field(add.inputFields, 'owner').offset).toBe(0)
		expect(field(add.inputFields, 'amount').offset).toBe(32)
	})

	test('describes nested structs and arrays by reference', () => {
		const abi = buildContractAbi(simpleSource)
		const query = call(abi.functions, 'Query')
		const entries = field(query.outputFields, 'entries')
		expect(entries.type).toBe('array')
		expect(entries.offset).toBe(0)
		expect(entries.byteLength).toBe(384)
		expect(entries.array).toEqual({
			length: 8,
			itemType: 'struct',
			itemByteLength: 48,
			itemStructRef: 'SIMPLE::Query_output::Entry',
		})
		expect(field(query.outputFields, 'status').type).toBe('enum')
		expect(field(query.outputFields, 'status').enumRef).toBe('SIMPLE::Status')
		expect(field(query.outputFields, 'status').offset).toBe(384)

		const entry = struct(abi.structs, 'SIMPLE::Query_output::Entry')
		expect(entry.byteLength).toBe(48)
		expect(entry.alignment).toBe(8)
		expect(
			entry.fields.map((property) => [
				property.name,
				property.offset,
				property.type,
			]),
		).toEqual([
			['owner', 0, 'id'],
			['amount', 32, 'uint64'],
			['active', 40, 'bool'],
		])
		expect(abi.enums['SIMPLE::Status']).toEqual({
			name: 'SIMPLE::Status',
			underlyingType: 'uint8',
			byteLength: 1,
			values: [
				{ name: 'Disabled', value: 0 },
				{ name: 'Enabled', value: 1 },
			],
		})
	})

	test('lays out collections from the token fixture', () => {
		const abi = buildContractAbi(tokenSource)
		expect(abi.name).toBe('TOKEN')
		expect(abi.stateSize).toBe(2_429_368)
		expect(abi.state?.alignment).toBe(8)

		const assetOrders = struct(
			abi.structs,
			'Collection<AssetOrder, TOKEN_SLOTS>',
		)
		// 8192 PoV slots (64 bytes), 2048 bytes of flags, 8192 elements (80 bytes), 16 bytes of counters.
		expect(assetOrders.byteLength).toBe(1_181_712)
		expect(assetOrders.alignment).toBe(8)
		expect(
			assetOrders.fields.map((entry) => [entry.name, entry.offset]),
		).toEqual([
			['_povs', 0],
			['_povOccupationFlags', 524_288],
			['_elements', 526_336],
			['_population', 1_181_696],
			['_markRemovalCounter', 1_181_704],
		])

		const state = struct(abi.structs, 'TOKEN::StateData')
		expect(field(state.fields, 'earnedAmount').offset).toBe(0)
		expect(field(state.fields, 'issuanceFee').offset).toBe(24)
		expect(field(state.fields, 'assetOrders').offset).toBe(40)
		expect(field(state.fields, 'entityOrders').offset).toBe(1_181_752)
	})

	test('uses registration order and registration ids for call ordering', () => {
		const abi = buildContractAbi(tokenSource)
		expect(abi.functions.map((entry) => [entry.name, entry.inputType])).toEqual(
			[
				['Fees', 1],
				['Orders', 2],
			],
		)
		expect(
			abi.procedures.map((entry) => [entry.name, entry.inputType]),
		).toEqual([
			['Transfer', 2],
			['Issue', 5],
		])
		expect(call(abi.functions, 'Orders').outputSize).toBe(12_288)
		expect(
			field(call(abi.functions, 'Orders').outputFields, 'orders').array,
		).toEqual({
			length: 256,
			itemType: 'struct',
			itemByteLength: 48,
			itemStructRef: 'TOKEN::Orders_output::Order',
		})
		expect(
			field(call(abi.procedures, 'Transfer').inputFields, 'asset').structRef,
		).toBe('QPI::Asset')
	})

	test('handles empty structs as size 1', () => {
		const abi = buildContractAbi(simpleSource)
		const ping = call(abi.functions, 'Ping')
		expect(ping.inputSize).toBe(1)
		expect(ping.inputAlignment).toBe(1)
		expect(ping.inputFields).toEqual([])
	})

	test('throws for a header without a contract', () => {
		expect(() => buildContractAbi('struct A { uint64 x; };')).toThrow(
			ContractLayoutError,
		)
	})

	test('throws when a registered call is missing its input or output type', () => {
		const source = `
			struct A : public ContractBase {
				struct X_output { uint64 value; };
				PUBLIC_FUNCTION(X) {}
				REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(X, 1); }
			};
		`
		expect(() => buildContractAbi(source)).toThrow('Missing X_input')
	})

	test('throws when an ABI field uses an unresolved type', () => {
		const source = `
			struct A : public ContractBase {
				struct X_input { UnknownType value; };
				struct X_output { uint64 value; };
				PUBLIC_FUNCTION(X) {}
				REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(X, 1); }
			};
		`
		expect(() => buildContractAbi(source)).toThrow(ContractLayoutError)
	})

	test('ignores unregistered public calls', () => {
		const source = `
			struct A : public ContractBase {
				struct X_input {};
				struct X_output {};
				struct Y_input {};
				struct Y_output {};
				PUBLIC_FUNCTION(X) {}
				PUBLIC_FUNCTION(Y) {}
				REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(X, 1); }
			};
		`
		const abi = buildContractAbi(source)
		expect(abi.functions.map((entry) => entry.name)).toEqual(['X'])
	})

	test('engine resolves nested structs by short and qualified names', () => {
		const parsed = parseContract(simpleSource)
		const engine = new CppLayoutEngine(parsed.module)
		const contract = parsed.contract as CppStructDecl
		const byShort = engine.findStruct('Query_output::Entry', contract)
		const byQualified = engine.findStruct('SIMPLE::Query_output::Entry')
		expect(byShort?.size).toBe(48)
		expect(byQualified?.size).toBe(48)
		const stateDecl = findContractStruct(contract, 'StateData')
		expect(engine.layoutStruct(stateDecl).size).toBe(176)
	})
})
