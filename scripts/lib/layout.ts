/**
 * C++ memory layout for the Qubic ABI.
 *
 * Contract inputs and outputs are copied to and from the contract as raw
 * struct memory (`copyMem(input, inputPtr, sizeof(input))` in core). The wire
 * layout is therefore exactly what the C++ compiler produces on x86-64:
 * natural alignment, interior padding, and trailing padding. It is NOT packed.
 *
 * Reference points from qubic/core:
 * - `src/qpi/qpi_types.h`: scalar typedefs, `id` (m256i), `bit`, `uint128`
 * - `src/qpi/qpi_containers.h`: `Array<T, L>`, `BitArray<L>`
 * - `src/platform/m256.h`: `m256i` has four uint64 members (size 32, align 8)
 * - `src/platform/uint128.h`: `uint128_t` has two uint64 members (size 16, align 8)
 *
 * State-only containers (HashMap, HashSet, Collection, ...) are rejected when
 * they leak into call I/O; they are not part of the ABI subset.
 */

import type {
	ContractEnum,
	ContractField,
	ContractStruct,
} from '../../src/types.js'
import { evaluateIntegerExpression } from './cpp.js'
import type {
	CppEnum,
	CppField,
	CppStruct,
	CppTypeRef,
	ParsedCppFile,
	ScalarFieldKind,
} from './model.js'

export type LayoutKind = 'scalar' | 'enum' | 'struct' | 'array' | 'bitArray'

export interface LayoutType {
	kind: LayoutKind
	size: number
	align: number
	scalar?: ScalarFieldKind
	struct?: CppStruct
	qualifiedName?: string
	enum?: CppEnum
	arrayLength?: number
	item?: LayoutType
	bits?: number
}

const SCALARS: Record<
	string,
	{ kind: ScalarFieldKind; size: number; align: number }
> = {
	uint8: { kind: 'uint8', size: 1, align: 1 },
	sint8: { kind: 'sint8', size: 1, align: 1 },
	uint16: { kind: 'uint16', size: 2, align: 2 },
	sint16: { kind: 'sint16', size: 2, align: 2 },
	uint32: { kind: 'uint32', size: 4, align: 4 },
	sint32: { kind: 'sint32', size: 4, align: 4 },
	uint64: { kind: 'uint64', size: 8, align: 8 },
	sint64: { kind: 'sint64', size: 8, align: 8 },
	uint128: { kind: 'uint128', size: 16, align: 8 },
	id: { kind: 'id', size: 32, align: 8 },
	bit: { kind: 'bit', size: 1, align: 1 },
	bool: { kind: 'bool', size: 1, align: 1 },
	// Spelled the same in the parser after canonicalization.
	m256i: { kind: 'id', size: 32, align: 8 },
}

const STATE_ONLY_CONTAINERS = new Set([
	'HashMap',
	'HashSet',
	'Collection',
	'LinkedList',
	'Pool',
	'ProposalAndVotingByShareholders',
	'ProposalVoting',
	'ProposalWithAllVoteData',
])

/** Builtin constants that live in `namespace QPI` and are not parsed. */
const BUILTIN_CONSTANTS: Record<string, number> = {
	X_MULTIPLIER: 1,
	NULL_INDEX: -1,
	NUMBER_OF_COMPUTORS: 676,
	QUORUM: 451,
}

export class LayoutError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'LayoutError'
	}
}

function required<T>(value: T | undefined, message: string): T {
	if (value === undefined) throw new LayoutError(message)
	return value
}

interface RegisteredTypedef {
	ref: CppTypeRef
	scope: string
}

/** All declarations visible while laying out one or more contracts. */
export class TypeRegistry {
	readonly structs = new Map<string, CppStruct>()
	readonly enums = new Map<string, CppEnum>()
	readonly typedefs = new Map<string, RegisteredTypedef>()
	readonly constantExpressions = new Map<string, string>()
	readonly constantValues = new Map<string, number>()
	readonly enumValues = new Map<string, number>()

	addModule(
		module: ParsedCppFile,
		options: { scope?: string; unqualifiedAliases?: boolean } = {},
	): void {
		const prefix = normalizeScope(options.scope ?? '')
		const aliases = options.unqualifiedAliases ?? true
		for (const decl of module.structs) this.addStruct(decl, prefix, aliases)
		for (const decl of module.enums) this.addEnum(decl, prefix, aliases)
		for (const decl of module.typedefs) {
			this.addTypedef(
				decl.qualifiedName || decl.name,
				decl.target,
				prefix,
				aliases,
			)
			if (decl.name !== decl.qualifiedName)
				this.addTypedef(decl.name, decl.target, prefix, aliases)
		}
		for (const constant of module.constants) {
			const key = qualify(prefix, constant.qualifiedName || constant.name)
			this.constantExpressions.set(key, constant.expression)
			if (constant.value !== null) this.constantValues.set(key, constant.value)
			if (prefix === '') {
				this.constantExpressions.set(constant.name, constant.expression)
				if (constant.value !== null)
					this.constantValues.set(constant.name, constant.value)
			}
		}
	}

	addStruct(decl: CppStruct, prefix = '', unqualifiedAliases = true): void {
		const qualified =
			prefix === '' ? decl.qualifiedName : qualify(prefix, decl.qualifiedName)
		this.structs.set(qualified, decl)
		// Builtins are parsed without their C++ namespace. Also expose the
		// source-qualified name and the unqualified name so both `QPI::Asset`
		// and `Asset` resolve consistently.
		if (!this.structs.has(decl.qualifiedName))
			this.structs.set(decl.qualifiedName, decl)
		const short = prefix === '' ? decl.name : qualify(prefix, decl.name)
		if (unqualifiedAliases && !this.structs.has(short)) {
			this.structs.set(short, decl)
		}
	}

	addEnum(decl: CppEnum, prefix = '', unqualifiedAliases = true): void {
		const qualified =
			prefix === '' ? decl.qualifiedName : qualify(prefix, decl.qualifiedName)
		this.enums.set(qualified, decl)
		if (!this.enums.has(decl.qualifiedName))
			this.enums.set(decl.qualifiedName, decl)
		const short = prefix === '' ? decl.name : qualify(prefix, decl.name)
		if (unqualifiedAliases && !this.enums.has(short))
			this.enums.set(short, decl)
		for (const member of decl.values) {
			const value =
				member.value ??
				this.evaluateInteger(member.expression ?? '0', decl.qualifiedName)
			this.enumValues.set(`${qualified}::${member.name}`, value)
			this.enumValues.set(`${decl.qualifiedName}::${member.name}`, value)
			this.enumValues.set(`${decl.name}::${member.name}`, value)
		}
	}

	addTypedef(
		name: string,
		ref: CppTypeRef,
		prefix = '',
		unqualifiedAliases = true,
	): void {
		const qualified = prefix === '' ? name : qualify(prefix, name)
		this.typedefs.set(qualified, { ref, scope: prefix })
		if (unqualifiedAliases && !this.typedefs.has(name))
			this.typedefs.set(name, { ref, scope: prefix })
	}

	addConstant(name: string, expression: string, scope = ''): void {
		this.constantExpressions.set(qualify(scope, name), expression)
		this.constantExpressions.set(name, expression)
	}

	resolveType(ref: CppTypeRef, scope = ''): LayoutType {
		if (ref.isPointer) {
			throw new LayoutError(
				`Pointers are not valid in QPI call I/O: ${ref.name}`,
			)
		}
		if (ref.arrayLengths && ref.arrayLengths.length > 0) {
			let type = this.resolveType({ ...ref, arrayLengths: undefined }, scope)
			for (const dimension of [...ref.arrayLengths].reverse()) {
				const length = this.evaluateInteger(dimension, scope)
				type = {
					kind: 'array',
					size: type.size * length,
					align: type.align,
					arrayLength: length,
					item: type,
				}
			}
			return type
		}

		const name = cleanName(ref.name)
		const scalar = SCALARS[name] ?? SCALARS[normalizeScalar(name)]
		if (scalar) {
			return {
				kind: 'scalar',
				size: scalar.size,
				align: scalar.align,
				scalar: scalar.kind,
			}
		}

		if (name === 'Array' || name === 'QPI::Array') {
			const itemArg = ref.templateArgs?.[0]
			const lengthArg = ref.templateArgs?.[1]
			const itemRef = itemArg?.kind === 'type' ? itemArg.type : undefined
			const lengthExpr =
				lengthArg?.kind === 'value' ? lengthArg.expression : undefined
			if (itemRef === undefined || lengthExpr === undefined) {
				throw new LayoutError(
					`Cannot resolve Array template arguments: ${ref.name}`,
				)
			}
			const item = this.resolveType(itemRef, scope)
			const length = this.evaluateInteger(lengthExpr, scope)
			return {
				kind: 'array',
				size: item.size * length,
				align: item.align,
				arrayLength: length,
				item,
			}
		}

		if (name === 'BitArray' || name === 'QPI::BitArray') {
			const arg = ref.templateArgs?.[0]
			const expr = arg?.kind === 'value' ? arg.expression : undefined
			if (expr === undefined)
				throw new LayoutError(`Cannot resolve BitArray length: ${ref.name}`)
			return bitArrayType(this.evaluateInteger(expr, scope))
		}

		if (/^bit_\d+$/.test(name)) return bitArrayType(Number(name.slice(4)))

		const last = name.split('::').at(-1) ?? name
		if (STATE_ONLY_CONTAINERS.has(last)) {
			throw new LayoutError(
				`State-only container ${name} is not valid in QPI call I/O`,
			)
		}

		return this.resolveNamed(name, scope)
	}

	private resolveNamed(name: string, scope: string): LayoutType {
		for (const candidate of lookupCandidates(name, scope)) {
			const struct = this.structs.get(candidate)
			if (struct !== undefined) {
				const layout = layoutDeclaredStruct(struct, this)
				return {
					kind: 'struct',
					size: layout.byteLength,
					align: layout.alignment,
					struct,
					qualifiedName: struct.qualifiedName || candidate,
				}
			}
			const enumDecl = this.enums.get(candidate)
			if (enumDecl !== undefined) {
				const size = enumSize(enumDecl, this)
				return {
					kind: 'enum',
					size: size.size,
					align: size.align,
					enum: enumDecl,
					qualifiedName: enumDecl.qualifiedName || candidate,
				}
			}
			const alias = this.typedefs.get(candidate)
			if (alias !== undefined) {
				const resolved = this.resolveType(alias.ref, alias.scope)
				return {
					...resolved,
					qualifiedName: resolved.qualifiedName ?? candidate,
				}
			}
		}
		throw new LayoutError(
			`Unknown ABI type "${name}" in scope "${scope || '<global>'}"`,
		)
	}

	resolveEnumValue(expression: string, scope = ''): number | undefined {
		let cleaned = expression.trim()
		const cast = /^static_cast\s*<[^>]+>\s*\((.*)\)$/s.exec(cleaned)
		if (cast) cleaned = (cast[1] ?? '').trim()
		if (/^-?\d+$/.test(cleaned)) return Number(cleaned)
		for (const candidate of lookupCandidates(cleaned, scope)) {
			const value = this.enumValues.get(candidate)
			if (value !== undefined) return value
		}
		return undefined
	}

	/** Evaluate a constant expression, resolving dependent constants recursively. */
	evaluateInteger(
		expression: string,
		scope = '',
		stack: string[] = [],
	): number {
		const trimmed = expression.trim()
		const direct = BUILTIN_CONSTANTS[trimmed]
		if (direct !== undefined) return direct
		const enumValue = this.resolveEnumValue(trimmed, scope)
		if (enumValue !== undefined) return enumValue

		for (const candidate of lookupCandidates(trimmed, scope)) {
			const cached = this.constantValues.get(candidate)
			if (cached !== undefined) return cached
			const raw = this.constantExpressions.get(candidate)
			if (raw !== undefined) {
				if (stack.includes(candidate)) {
					throw new LayoutError(
						`Circular constant reference: ${[...stack, candidate].join(' -> ')}`,
					)
				}
				const resolved = this.evaluateDependencies(raw, candidate, [
					...stack,
					candidate,
				])
				this.constantValues.set(candidate, resolved)
				return resolved
			}
		}

		if (/^[A-Za-z_]\w*(?:::\w+)*$/.test(trimmed)) {
			throw new LayoutError(
				`Unknown constant "${trimmed}" in scope "${scope || '<global>'}"`,
			)
		}

		const resolved = this.evaluateDependencies(trimmed, scope, [
			...stack,
			trimmed,
		])
		return resolved
	}

	private evaluateDependencies(
		expression: string,
		scope: string,
		stack: string[],
	): number {
		if (stack.length > 32) {
			throw new LayoutError(
				`Constant recursion limit exceeded: ${[...stack, expression].join(' -> ')}`,
			)
		}
		expression = normalizeQpiConstantHelpers(expression)
		const identifiers = new Set<string>()
		for (const match of expression.matchAll(
			/(?<![0-9A-Za-z_])[A-Za-z_]\w*(?:::\w+)*/g,
		)) {
			const name = match[0]
			if (name === 'true' || name === 'false') continue
			identifiers.add(name)
		}
		const values = new Map<string, number>(Object.entries(BUILTIN_CONSTANTS))
		for (const identifier of identifiers) {
			const value = this.evaluateInteger(identifier, scope, stack)
			values.set(identifier, value)
			values.set(identifier.split('::').at(-1) ?? identifier, value)
		}
		const evaluated = evaluateIntegerExpression(expression, values)
		if (evaluated === null) {
			throw new LayoutError(
				`Cannot evaluate integer expression "${expression}" in scope "${scope || '<global>'}"`,
			)
		}
		return evaluated
	}
}

function bitArrayType(bits: number): LayoutType {
	// QPI BitArray<L> stores L bits in ceil(L / 64) uint64 words. The smallest
	// instance is one uint64, so `bit_2` is 8 bytes, not 1.
	if (bits <= 0 || (bits & (bits - 1)) !== 0) {
		throw new LayoutError(`BitArray length must be a power of two, got ${bits}`)
	}
	const words = Math.ceil(bits / 64)
	return {
		kind: 'bitArray',
		size: words * 8,
		align: 8,
		arrayLength: words,
		bits,
	}
}

/** Lay out one struct with natural C++ alignment. */
export function layoutDeclaredStruct(
	decl: CppStruct,
	registry: TypeRegistry,
): ContractStruct {
	const fields: ContractField[] = []
	const isUnion = decl.kind === 'union'
	let offset = 0
	let alignment = 1
	let unionSize = 0

	for (const field of decl.fields) {
		const type = registry.resolveType(field.type, decl.qualifiedName)
		const fieldOffset = isUnion ? 0 : alignTo(offset, type.align)
		fields.push(describeField(field, type, fieldOffset))
		offset = fieldOffset + type.size
		alignment = Math.max(alignment, type.align)
		unionSize = Math.max(unionSize, type.size)
	}

	const size = isUnion
		? alignTo(unionSize, alignment)
		: alignTo(offset, alignment)
	return {
		name: decl.qualifiedName || decl.name,
		fields,
		byteLength: size === 0 ? 1 : size,
		alignment,
	}
}

function describeField(
	field: CppField,
	type: LayoutType,
	offset: number,
): ContractField {
	const base = {
		name: field.name,
		offset,
		byteLength: type.size,
		...(field.description === undefined
			? {}
			: { description: field.description }),
	}
	switch (type.kind) {
		case 'scalar':
			return {
				...base,
				type: required(type.scalar, `Missing scalar kind for ${field.name}`),
			}
		case 'enum':
			return {
				...base,
				type: 'enum',
				enumRef: required(
					type.qualifiedName,
					`Missing enum name for ${field.name}`,
				),
			}
		case 'struct':
			return {
				...base,
				type: 'struct',
				structRef: required(
					type.qualifiedName,
					`Missing struct name for ${field.name}`,
				),
			}
		case 'bitArray':
			return {
				...base,
				type: 'array',
				array: {
					length: required(
						type.arrayLength,
						`Missing bit array length for ${field.name}`,
					),
					itemType: 'uint64',
					itemByteLength: 8,
				},
			}
		case 'array': {
			const item = required(
				type.item,
				`Missing array item type for ${field.name}`,
			)
			const itemDescriptor = describeItem(item)
			return {
				...base,
				type: 'array',
				array: {
					length: required(
						type.arrayLength,
						`Missing array length for ${field.name}`,
					),
					itemType: itemDescriptor.type,
					itemByteLength: item.size,
					...(itemDescriptor.structRef === undefined
						? {}
						: { itemStructRef: itemDescriptor.structRef }),
					...(itemDescriptor.enumRef === undefined
						? {}
						: { itemEnumRef: itemDescriptor.enumRef }),
				},
			}
		}
	}
}

function describeItem(type: LayoutType): {
	type: Exclude<ContractField['type'], 'array'>
	structRef?: string
	enumRef?: string
} {
	switch (type.kind) {
		case 'scalar':
			return {
				type: required(type.scalar, 'Missing nested scalar field kind'),
			}
		case 'enum':
			return {
				type: 'enum',
				enumRef: required(type.qualifiedName, 'Missing nested enum name'),
			}
		case 'struct':
			return {
				type: 'struct',
				structRef: required(type.qualifiedName, 'Missing nested struct name'),
			}
		default:
			throw new LayoutError('Nested arrays are not valid in QPI call I/O')
	}
}

export function enumSize(
	decl: CppEnum,
	registry: TypeRegistry,
): {
	size: number
	align: number
	underlying: ScalarFieldKind
} {
	if (decl.underlyingType !== null) {
		const resolved = registry.resolveType(
			{ name: decl.underlyingType, templateArgs: [] },
			decl.qualifiedName,
		)
		if (resolved.kind !== 'scalar') {
			throw new LayoutError(
				`Enum ${decl.qualifiedName} has a non-scalar underlying type`,
			)
		}
		return {
			size: resolved.size,
			align: resolved.align,
			underlying: required(
				resolved.scalar,
				`Missing scalar kind for enum ${decl.qualifiedName}`,
			),
		}
	}
	return { size: 4, align: 4, underlying: 'sint32' }
}

export function buildContractEnum(
	decl: CppEnum,
	registry: TypeRegistry,
): ContractEnum {
	const size = enumSize(decl, registry)
	const values: ContractEnum['values'] = []
	let next = 0
	for (const member of decl.values) {
		const value =
			member.value ??
			(member.expression === undefined
				? next
				: registry.evaluateInteger(member.expression, decl.qualifiedName))
		values.push({ name: member.name, value })
		next = value + 1
	}
	return {
		name: decl.qualifiedName,
		underlyingType: size.underlying,
		byteLength: size.size,
		values,
	}
}

export function alignTo(value: number, alignment: number): number {
	return Math.ceil(value / alignment) * alignment
}

function normalizeScope(scope: string): string {
	return scope.replace(/^::/, '').replace(/::$/, '')
}

function qualify(scope: string, name: string): string {
	return scope === '' ? name : `${scope}::${name}`
}

function cleanName(name: string): string {
	return name
		.replace(/^const\s+/, '')
		.replace(/^volatile\s+/, '')
		.replace(/^struct\s+/, '')
		.replace(/^class\s+/, '')
		.replace(/^enum\s+/, '')
		.replace(/^::/, '')
}

function normalizeScalar(name: string): string {
	return name.replace(/\s+/g, ' ').trim()
}

function lookupCandidates(name: string, scope: string): string[] {
	const candidates: string[] = []
	const parts = normalizeScope(scope).split('::').filter(Boolean)
	for (let index = parts.length; index >= 0; index--) {
		candidates.push([...parts.slice(0, index), name].join('::'))
	}
	if (!name.startsWith('QPI::')) candidates.push(`QPI::${name}`)
	candidates.push(name)
	return [...new Set(candidates)]
}

/**
 * Replace QPI's integer helper calls in constant expressions with operators.
 * Contracts use `div(a, b)` / `mod(a, b)` in array bounds (for example QTF).
 * Nested calls are handled by repeatedly rewriting the innermost call.
 */
function normalizeQpiConstantHelpers(expression: string): string {
	const operators: Record<string, string> = {
		div: '/',
		mod: '%',
		smul: '*',
		sadd: '+',
		ssub: '-',
	}
	let current = expression
	for (let iteration = 0; iteration < 8; iteration++) {
		let changed = false
		current = current.replace(
			/\b(div|mod|smul|sadd|ssub)\s*(?:<[^<>]*>)?\s*\(([^()]*)\)/g,
			(_match, fn, args) => {
				const parts = splitArguments(args)
				if (parts.length !== 2) return _match
				changed = true
				return `((${parts[0]}) ${operators[fn]} (${parts[1]}))`
			},
		)
		if (!changed) break
	}
	return current
}

function splitArguments(args: string): string[] {
	const parts: string[] = []
	let depth = 0
	let start = 0
	for (let index = 0; index < args.length; index++) {
		const char = args[index]
		if (char === '(') depth++
		else if (char === ')') depth--
		else if (char === ',' && depth === 0) {
			parts.push(args.slice(start, index).trim())
			start = index + 1
		}
	}
	parts.push(args.slice(start).trim())
	return parts
}
