import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
	type CppStructDecl,
	type CppTypeRef,
	parseContract,
	parseCpp,
	walkStructs,
} from '../parser.ts'

const fixtures = join(import.meta.dir, '..', '..', 'fixtures')
const simpleSource = readFileSync(
	join(fixtures, 'contracts', 'simple-contract.h'),
	'utf8',
)
const tokenSource = readFileSync(
	join(fixtures, 'contracts', 'token-contract.h'),
	'utf8',
)

function findStruct(
	structs: readonly CppStructDecl[],
	name: string,
): CppStructDecl {
	const found = [...walkStructs(structs)].find((decl) => decl.name === name)
	if (found === undefined) throw new Error(`Missing test struct ${name}`)
	return found
}

function typeName(type: CppTypeRef): string {
	return type.kind === 'named' ? type.name : type.kind
}

describe('parseCpp', () => {
	test('parses top-level structs, enums, typedefs, and constants', () => {
		const module = parseCpp(simpleSource, { fileName: 'simple-contract.h' })
		expect(module.fileName).toBe('simple-contract.h')
		expect(module.structs.map((decl) => decl.name)).toEqual([
			'SIMPLE2',
			'SIMPLE',
		])
		expect(module.structs[1]?.bases).toEqual(['ContractBase'])
		expect(module.structs[1]?.description).toBe(
			'Contract used by the parser and layout tests.',
		)
	})

	test('parses nested structs and fields', () => {
		const { contract } = parseContract(simpleSource)
		expect(contract).toBeDefined()
		const item = findStruct([contract as CppStructDecl], 'Item')
		expect(item.qualifiedName).toBe('SIMPLE::Item')
		expect(item.description).toBe('One item stored in contract state.')
		expect(
			item.fields.map((field) => [field.name, typeName(field.type)]),
		).toEqual([
			['owner', 'id'],
			['amount', 'uint64'],
		])
		const queryOutput = findStruct([contract as CppStructDecl], 'Query_output')
		expect(queryOutput.structs.map((decl) => decl.name)).toEqual(['Entry'])
	})

	test('parses multiple declarators sharing a type', () => {
		const module = parseCpp('struct A { sint64 first, second; id a, b; };')
		const fields = module.structs[0]?.fields ?? []
		expect(fields.map((field) => field.name)).toEqual([
			'first',
			'second',
			'a',
			'b',
		])
	})

	test('parses arrays, templates, and qualified type names', () => {
		const { contract } = parseContract(tokenSource)
		const state = findStruct([contract as CppStructDecl], 'StateData')
		const orders = state.fields.find((field) => field.name === 'assetOrders')
		expect(orders?.type.name).toBe('Collection')
		expect(orders?.type.templateArgs).toHaveLength(2)
		expect(orders?.type.templateArgs[0]?.type?.name).toBe('AssetOrder')
		expect(orders?.type.templateArgs[1]?.expression).toBe('TOKEN_SLOTS')

		const askOrder = state.fields.find((field) => field.name === 'askOrder')
		expect(askOrder?.type.name).toBe('Orders_output::Order')
	})

	test('evaluates enum underlying types and member expressions', () => {
		const module = parseCpp('enum class Flag : uint8 { A = 1, B, C = 2 * 4 };')
		const enumDecl = module.enums[0]
		expect(enumDecl?.name).toBe('Flag')
		expect(enumDecl?.underlyingType?.name).toBe('uint8')
		expect(enumDecl?.members.map((member) => member.name)).toEqual([
			'A',
			'B',
			'C',
		])
		expect(enumDecl?.members[2]?.expression).toBe('2 * 4')
	})

	test('parses typedef and using aliases inside contracts', () => {
		const source = `
			struct A : public ContractBase {
				typedef uint64 Amount;
				using Identifier = id;
				struct X_input { Amount amount; Identifier who; };
				struct X_output { Amount amount; };
				PUBLIC_FUNCTION(X) {}
				REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(X, 1); }
			};
		`
		const { contract } = parseContract(source)
		expect(contract?.typedefs.map((alias) => alias.name)).toEqual([
			'Amount',
			'Identifier',
		])
		const input = findStruct([contract as CppStructDecl], 'X_input')
		expect(input.fields.map((field) => field.type.name)).toEqual([
			'Amount',
			'Identifier',
		])
	})

	test('parses contract call macros, bodies, visibility, and registrations', () => {
		const { contract } = parseContract(simpleSource)
		expect(
			contract?.calls.map((call) => [
				call.name,
				call.kind,
				call.visibility,
				call.hasLocals,
			]),
		).toEqual([
			['Ping', 'function', 'public', false],
			['Query', 'function', 'public', false],
			['Add', 'procedure', 'public', true],
		])
		expect(
			contract?.registrations.map(({ kind, name, inputType }) => ({
				kind,
				name,
				inputType,
			})),
		).toEqual([
			{ kind: 'function', name: 'Ping', inputType: 1 },
			{ kind: 'function', name: 'Query', inputType: 2 },
			{ kind: 'procedure', name: 'Add', inputType: 1 },
		])
	})

	test('skips private calls and function bodies without confusing field parsing', () => {
		const { contract } = parseContract(tokenSource)
		const privateCall = contract?.calls.find(
			(call) => call.name === '_NumberOfReservedShares',
		)
		expect(privateCall?.visibility).toBe('private')
		const state = findStruct([contract as CppStructDecl], 'StateData')
		expect(state.fields.map((field) => field.name)).toContain('reservedOutput')
		expect(state.fields).toHaveLength(20)
	})

	test('collects #define and constexpr constants', () => {
		const defines = parseCpp(
			'#define N 4\n#define M N * 2\nstruct A { uint8 x[N]; };',
		)
		expect(defines.constants.N).toBe('4')
		expect(defines.constants.M).toBe('N * 2')

		const constants = parseCpp(tokenSource).constants
		expect(constants.TOKEN_MAX_ORDERS).toBe('8192')
		expect(constants.TOKEN_SLOTS).toBe('TOKEN_MAX_ORDERS * X_MULTIPLIER')
	})

	test('skips comments between a declaration name and its body', () => {
		const source = `
			struct A // contract struct
			{
				struct B // nested struct
				{
					uint64 value;
				} instance;

				union // anonymous union
				{
					uint32 small;
					uint64 large;
				};
			};
		`
		const module = parseCpp(source)
		const a = module.structs[0]
		const b = a?.structs[0]
		expect(a?.name).toBe('A')
		expect(b?.name).toBe('B')
		expect(a?.fields[0]?.name).toBe('instance')
		expect(a?.fields[0]?.type.name).toBe('A::B')
		expect(a?.fields[1]?.name).toMatch(/^__anonymous_union_\d+$/)
		expect(a?.fields[1]?.type.name).toBe(a?.fields[1]?.name)
	})

	test('skips #if 0 regions but keeps #else branches', () => {
		const withoutElse = parseCpp(
			'#if 0\nstruct Hidden {};\n#endif\nstruct Kept {};',
		)
		expect(withoutElse.structs.map((decl) => decl.name)).toEqual(['Kept'])

		const withElse = parseCpp(
			'#if 0\nstruct Hidden {};\n#else\nstruct Shown {};\n#endif',
		)
		expect(withElse.structs.map((decl) => decl.name)).toEqual(['Shown'])
	})

	test('does not treat using namespace as a declaration', () => {
		const module = parseCpp('using namespace QPI;\nstruct A {};')
		expect(module.typedefs).toEqual([])
		expect(module.structs.map((decl) => decl.name)).toEqual(['A'])
	})

	test('returns undefined contract when no ContractBase derivative exists', () => {
		const parsed = parseContract('struct A { uint64 x; };')
		expect(parsed.contract).toBeUndefined()
	})
})
