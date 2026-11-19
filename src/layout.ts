import {
	type CppEnumDecl,
	type CppModule,
	type CppStructDecl,
	type CppTemplateArgument,
	type CppTypeRef,
	type ParsedContract,
	parseContract,
	parseCpp,
} from './parser.ts'
import type {
	ContractArrayInfo,
	ContractCall,
	ContractCallKind,
	ContractEnum,
	ContractField,
	ContractFieldKind,
	ContractStruct,
	ScalarFieldKind,
} from './types.ts'
import { ContractAbiError } from './types.ts'

/** Error raised when a declaration cannot be laid out with natural C++ rules. */
export class ContractLayoutError extends ContractAbiError {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options)
		this.name = 'ContractLayoutError'
	}
}

export interface ScalarLayout {
	kind: 'scalar'
	name: string
	size: number
	alignment: number
	fieldKind: ScalarFieldKind
}

export interface StructLayoutField {
	name: string
	type: ResolvedType
	offset: number
	size: number
	alignment: number
	bitWidth?: string
	description?: string
}

export interface StructLayout {
	kind: 'struct'
	name: string
	decl: CppStructDecl
	size: number
	alignment: number
	fields: StructLayoutField[]
	isUnion: boolean
}

export interface EnumLayout {
	kind: 'enum'
	name: string
	decl: CppEnumDecl
	size: number
	alignment: number
	fieldKind: ScalarFieldKind
	values: { name: string; value: number }[]
}

export interface ArrayLayout {
	kind: 'array'
	name: string
	item: ResolvedType
	length: number
	size: number
	alignment: number
}

export interface PointerLayout {
	kind: 'pointer'
	name: string
	size: 8
	alignment: 8
}

export interface UnknownLayout {
	kind: 'unknown'
	name: string
	reason: string
	size: 0
	alignment: 1
}

export type ResolvedType =
	| ScalarLayout
	| StructLayout
	| EnumLayout
	| ArrayLayout
	| PointerLayout
	| UnknownLayout

export interface LayoutOptions {
	/** Extra constants available to array bounds and enum values. */
	constants?: Record<string, number | bigint | string>
	/**
	 * Parse and resolve built-in QPI structs. Enabled by default; disable only
	 * when supplying a custom type registry.
	 */
	includeQpiTypes?: boolean
}

export interface ContractAbi {
	/** Contract index when supplied by the caller (contract_def.h is not parsed here). */
	index?: number
	name: string
	assetName?: string
	fileName?: string
	sourcePath?: string
	/** 1-based line of the contract struct declaration. */
	line: number
	/** Layout of `StateData`, when it can be resolved with the supported subset. */
	state: ContractStruct | null
	stateSize: number | null
	structs: Record<string, ContractStruct>
	enums: Record<string, ContractEnum>
	procedures: ContractCall[]
	functions: ContractCall[]
	notifications: ContractCall[]
}

export interface BuildContractAbiOptions extends LayoutOptions {
	contractIndex?: number
	assetName?: string
	sourcePath?: string
}

const SCALARS: Record<
	string,
	{ size: number; alignment: number; fieldKind: ScalarFieldKind }
> = {
	bit: { size: 1, alignment: 1, fieldKind: 'bit' },
	bool: { size: 1, alignment: 1, fieldKind: 'bool' },
	char: { size: 1, alignment: 1, fieldKind: 'sint8' },
	signedchar: { size: 1, alignment: 1, fieldKind: 'sint8' },
	unsignedchar: { size: 1, alignment: 1, fieldKind: 'uint8' },
	sint8: { size: 1, alignment: 1, fieldKind: 'sint8' },
	uint8: { size: 1, alignment: 1, fieldKind: 'uint8' },
	int8: { size: 1, alignment: 1, fieldKind: 'sint8' },
	uint8_t: { size: 1, alignment: 1, fieldKind: 'uint8' },
	int8_t: { size: 1, alignment: 1, fieldKind: 'sint8' },
	sint16: { size: 2, alignment: 2, fieldKind: 'sint16' },
	uint16: { size: 2, alignment: 2, fieldKind: 'uint16' },
	short: { size: 2, alignment: 2, fieldKind: 'sint16' },
	unsignedshort: { size: 2, alignment: 2, fieldKind: 'uint16' },
	int16_t: { size: 2, alignment: 2, fieldKind: 'sint16' },
	uint16_t: { size: 2, alignment: 2, fieldKind: 'uint16' },
	sint32: { size: 4, alignment: 4, fieldKind: 'sint32' },
	uint32: { size: 4, alignment: 4, fieldKind: 'uint32' },
	int: { size: 4, alignment: 4, fieldKind: 'sint32' },
	unsignedint: { size: 4, alignment: 4, fieldKind: 'uint32' },
	int32_t: { size: 4, alignment: 4, fieldKind: 'sint32' },
	uint32_t: { size: 4, alignment: 4, fieldKind: 'uint32' },
	sint64: { size: 8, alignment: 8, fieldKind: 'sint64' },
	uint64: { size: 8, alignment: 8, fieldKind: 'uint64' },
	longlong: { size: 8, alignment: 8, fieldKind: 'sint64' },
	unsignedlonglong: { size: 8, alignment: 8, fieldKind: 'uint64' },
	int64_t: { size: 8, alignment: 8, fieldKind: 'sint64' },
	uint64_t: { size: 8, alignment: 8, fieldKind: 'uint64' },
	uint128: { size: 16, alignment: 8, fieldKind: 'uint128' },
	uint128_t: { size: 16, alignment: 8, fieldKind: 'uint128' },
	id: { size: 32, alignment: 8, fieldKind: 'id' },
	m256i: { size: 32, alignment: 8, fieldKind: 'id' },
}

const UNSUPPORTED_SCALARS: Record<string, { size: number; alignment: number }> =
	{
		float: { size: 4, alignment: 4 },
		double: { size: 8, alignment: 8 },
		longdouble: { size: 16, alignment: 16 },
		void: { size: 0, alignment: 1 },
	}

const BUILTIN_CONSTANTS: Record<string, number> = {
	X_MULTIPLIER: 1,
	NULL_INDEX: -1,
	QUORUM: 451,
	NUMBER_OF_COMPUTORS: 676,
}

function roundUp(value: number, alignment: number): number {
	if (alignment <= 1) return value
	return Math.ceil(value / alignment) * alignment
}

function normalizeScalarName(name: string): string {
	return name.replace(/::/g, '').replace(/\s+/g, '').toLowerCase()
}

function isScalarKind(value: string): value is ScalarFieldKind {
	return (
		value === 'uint8' ||
		value === 'sint8' ||
		value === 'uint16' ||
		value === 'sint16' ||
		value === 'uint32' ||
		value === 'sint32' ||
		value === 'uint64' ||
		value === 'sint64' ||
		value === 'uint128' ||
		value === 'id' ||
		value === 'bit' ||
		value === 'bool'
	)
}

/** Layout engine for the C++ declaration AST produced by {@link parseCpp}. */
export class CppLayoutEngine {
	readonly module: CppModule
	private readonly options: LayoutOptions
	private readonly structByQualifiedName = new Map<string, CppStructDecl>()
	private readonly typedefByQualifiedName = new Map<string, CppTypeRef>()
	private readonly enumByQualifiedName = new Map<string, CppEnumDecl>()
	private readonly parentByQualifiedName = new Map<string, string>()
	private readonly builtins = new Map<string, ResolvedType>()
	private readonly layoutCache = new Map<CppStructDecl, StructLayout>()
	private readonly layoutInProgress = new Set<CppStructDecl>()
	private readonly constantCache = new Map<string, number>()
	private readonly constantInProgress = new Set<string>()
	private readonly typedefInProgressNames = new Set<string>()

	constructor(module: CppModule, options: LayoutOptions = {}) {
		this.module = module
		this.options = options
		this.indexModule(module)
		this.registerBuiltins(options.includeQpiTypes !== false)
	}

	/** Resolve a type reference in the scope of a declaration. */
	resolveType(type: CppTypeRef, scope?: CppStructDecl): ResolvedType {
		switch (type.kind) {
			case 'array':
				return this.resolveArray(type, scope)
			case 'pointer':
			case 'reference':
				return {
					kind: 'pointer',
					name: type.raw ?? type.name,
					size: 8,
					alignment: 8,
				}
			case 'named':
				return this.resolveNamed(type, scope)
			case 'unknown':
				return {
					kind: 'unknown',
					name: type.raw ?? type.name,
					reason: 'Unsupported C++ type syntax',
					size: 0,
					alignment: 1,
				}
		}
	}

	/** Compute the natural C++ layout of a struct or union. */
	layoutStruct(decl: CppStructDecl): StructLayout {
		const cached = this.layoutCache.get(decl)
		if (cached !== undefined) return cached
		if (this.layoutInProgress.has(decl)) {
			throw new ContractLayoutError(
				`Recursive by-value layout for struct ${decl.qualifiedName}`,
			)
		}
		this.layoutInProgress.add(decl)
		try {
			const layout = this.computeStructLayout(decl)
			this.layoutCache.set(decl, layout)
			return layout
		} finally {
			this.layoutInProgress.delete(decl)
		}
	}

	/** Resolve a struct by qualified name or short name. */
	findStruct(name: string, scope?: CppStructDecl): StructLayout | undefined {
		const decl = this.findStructDecl(name, scope)
		return decl === undefined ? undefined : this.layoutStruct(decl)
	}

	/** Evaluate a constant expression using module constants and built-ins. */
	evaluate(
		expression: string,
		extraConstants?: Record<string, number>,
	): number {
		const evaluator = new ExpressionEvaluator((name) =>
			this.resolveConstant(name, extraConstants),
		)
		return evaluator.evaluate(expression)
	}

	/** Convert a parsed contract header into generator-friendly ABI metadata. */
	buildContractAbi(
		parsed: ParsedContract,
		options: BuildContractAbiOptions = {},
	): ContractAbi {
		const contract = parsed.contract
		if (contract === undefined) {
			throw new ContractLayoutError(
				'No contract struct deriving from ContractBase was found',
			)
		}

		const structs: Record<string, ContractStruct> = {}
		const enums: Record<string, ContractEnum> = {}
		const registrationByName = new Map(
			contract.registrations.map((registration) => [
				registration.name,
				registration,
			]),
		)

		const layoutCall = (
			name: string,
			kind: ContractCallKind,
			inputType: number | null,
			description?: string,
		): ContractCall => {
			const inputTypeRef = this.findInputOutputType(contract, `${name}_input`)
			const outputTypeRef = this.findInputOutputType(contract, `${name}_output`)
			if (inputTypeRef === undefined) {
				throw new ContractLayoutError(
					`Missing ${name}_input in contract ${contract.name}`,
				)
			}
			if (outputTypeRef === undefined) {
				throw new ContractLayoutError(
					`Missing ${name}_output in contract ${contract.name}`,
				)
			}

			const input = this.resolveType(inputTypeRef, contract)
			const output = this.resolveType(outputTypeRef, contract)
			if (input.kind === 'unknown') {
				throw new ContractLayoutError(
					`Cannot resolve input type ${inputTypeRef.raw ?? inputTypeRef.name} for ${name}`,
				)
			}
			if (output.kind === 'unknown') {
				throw new ContractLayoutError(
					`Cannot resolve output type ${outputTypeRef.raw ?? outputTypeRef.name} for ${name}`,
				)
			}

			const inputFields = this.describeFields(input, contract, structs, enums)
			const outputFields = this.describeFields(output, contract, structs, enums)
			return {
				kind,
				name,
				inputType,
				inputSize: input.size,
				outputSize: output.size,
				inputAlignment: input.alignment,
				outputAlignment: output.alignment,
				inputFields,
				outputFields,
				...(description === undefined ? {} : { description }),
			}
		}

		const procedures: ContractCall[] = []
		const functions: ContractCall[] = []
		const notifications: ContractCall[] = []

		for (const registration of contract.registrations) {
			const callDecl = contract.calls.find(
				(call) => call.name === registration.name,
			)
			if (registration.kind === 'notification') {
				notifications.push(
					layoutCall(
						registration.name,
						'notification',
						null,
						callDecl?.description,
					),
				)
				continue
			}
			if (callDecl === undefined || callDecl.visibility !== 'public') continue
			const call = layoutCall(
				registration.name,
				registration.kind,
				registration.inputType,
				callDecl.description,
			)
			if (registration.kind === 'function') functions.push(call)
			else procedures.push(call)
		}

		// Public calls without a registration entry cannot be invoked on-chain.
		// Keep them out of the wire ABI but do not silently claim an inputType.
		for (const call of contract.calls) {
			if (call.visibility !== 'public') continue
			if (registrationByName.has(call.name)) continue
			if (
				call.kind === 'function' &&
				functions.some((entry) => entry.name === call.name)
			)
				continue
			if (
				call.kind === 'procedure' &&
				procedures.some((entry) => entry.name === call.name)
			)
				continue
		}

		functions.sort(
			(a, b) =>
				(a.inputType ?? Number.MAX_SAFE_INTEGER) -
				(b.inputType ?? Number.MAX_SAFE_INTEGER),
		)
		procedures.sort(
			(a, b) =>
				(a.inputType ?? Number.MAX_SAFE_INTEGER) -
				(b.inputType ?? Number.MAX_SAFE_INTEGER),
		)

		const stateDecl = contract.structs.find(
			(child) => child.name === 'StateData' && child.kind === 'struct',
		)
		let state: ContractStruct | null = null
		let stateSize: number | null = null
		if (stateDecl !== undefined) {
			const before = Object.keys(structs)
			try {
				const layout = this.layoutStruct(stateDecl)
				state = this.toContractStruct(layout, structs, enums)
				stateSize = layout.size
			} catch {
				stateSize = null
				for (const key of Object.keys(structs)) {
					if (!before.includes(key)) delete structs[key]
				}
			}
		}

		// Ensure structs referenced by state land in the public map as well, but
		// ignore state-only types the supported subset cannot resolve.
		if (state !== null) structs[state.name] = state

		const abi: ContractAbi = {
			...(options.contractIndex === undefined
				? {}
				: { index: options.contractIndex }),
			name: contract.name,
			assetName: options.assetName ?? contract.name,
			...(parsed.module.fileName === undefined
				? {}
				: { fileName: parsed.module.fileName }),
			sourcePath: options.sourcePath ?? parsed.module.fileName ?? '',
			line: contract.line,
			state,
			stateSize,
			structs,
			enums,
			procedures,
			functions,
			notifications,
		}
		return abi
	}

	private indexModule(module: CppModule): void {
		for (const decl of module.structs) this.indexStruct(decl)
		for (const decl of module.enums)
			this.enumByQualifiedName.set(decl.qualifiedName, decl)
		for (const decl of module.typedefs)
			this.typedefByQualifiedName.set(decl.qualifiedName, decl.type)
	}

	private indexStruct(decl: CppStructDecl): void {
		this.structByQualifiedName.set(decl.qualifiedName, decl)
		const separator = decl.qualifiedName.lastIndexOf('::')
		if (separator !== -1)
			this.parentByQualifiedName.set(
				decl.qualifiedName,
				decl.qualifiedName.slice(0, separator),
			)
		for (const enumDecl of decl.enums)
			this.enumByQualifiedName.set(enumDecl.qualifiedName, enumDecl)
		for (const typedefDecl of decl.typedefs)
			this.typedefByQualifiedName.set(
				typedefDecl.qualifiedName,
				typedefDecl.type,
			)
		for (const child of decl.structs) this.indexStruct(child)
	}

	private registerBuiltins(includeQpi: boolean): void {
		for (const [name, scalar] of Object.entries(SCALARS)) {
			this.builtins.set(name, {
				kind: 'scalar',
				name,
				size: scalar.size,
				alignment: scalar.alignment,
				fieldKind: scalar.fieldKind,
			})
		}

		// QPI container/scalar aliases used in real contracts.
		const scalarAliases: [string, ScalarFieldKind, number][] = [
			['sint8', 'sint8', 1],
			['uint8', 'uint8', 1],
			['sint16', 'sint16', 2],
			['uint16', 'uint16', 2],
			['sint32', 'sint32', 4],
			['uint32', 'uint32', 4],
			['sint64', 'sint64', 8],
			['uint64', 'uint64', 8],
		]
		for (const [base, fieldKind, size] of scalarAliases) {
			for (const length of [2, 4, 8]) {
				this.builtins.set(`${base}_${String(length)}`, {
					kind: 'array',
					name: `${base}_${String(length)}`,
					item: {
						kind: 'scalar',
						name: base,
						size,
						alignment: size,
						fieldKind,
					},
					length,
					size: size * length,
					alignment: size,
				})
			}
		}

		this.builtins.set('id_2', {
			kind: 'array',
			name: 'id_2',
			item: this.scalar('id'),
			length: 2,
			size: 64,
			alignment: 8,
		})
		// QPI currently defines id_4 as Array<id, 8>; mirror that exactly.
		this.builtins.set('id_4', {
			kind: 'array',
			name: 'id_4',
			item: this.scalar('id'),
			length: 8,
			size: 256,
			alignment: 8,
		})
		this.builtins.set('id_8', {
			kind: 'array',
			name: 'id_8',
			item: this.scalar('id'),
			length: 8,
			size: 256,
			alignment: 8,
		})

		for (const bits of [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096]) {
			const size = Math.ceil(bits / 64) * 8
			this.builtins.set(`bit_${String(bits)}`, {
				kind: 'array',
				name: `bit_${String(bits)}`,
				item: {
					kind: 'scalar',
					name: 'bit64',
					size: 8,
					alignment: 8,
					fieldKind: 'uint64',
				},
				length: Math.ceil(bits / 64),
				size,
				alignment: 8,
			})
		}

		if (!includeQpi) return

		this.builtins.set('nodata', {
			kind: 'struct',
			name: 'QPI::NoData',
			decl: emptyStruct('NoData'),
			size: 1,
			alignment: 1,
			fields: [],
			isUnion: false,
		})
		this.builtins.set(
			'asset',
			this.structFromFields('QPI::Asset', [
				{ name: 'issuer', type: this.scalar('id') },
				{ name: 'assetName', type: this.scalar('uint64') },
			]),
		)
		this.builtins.set(
			'entity',
			this.structFromFields('QPI::Entity', [
				{ name: 'publicKey', type: this.scalar('id') },
				{ name: 'incomingAmount', type: this.scalar('sint64') },
				{ name: 'outgoingAmount', type: this.scalar('sint64') },
				{ name: 'numberOfIncomingTransfers', type: this.scalar('uint32') },
				{ name: 'numberOfOutgoingTransfers', type: this.scalar('uint32') },
				{ name: 'latestIncomingTransferTick', type: this.scalar('uint32') },
				{ name: 'latestOutgoingTransferTick', type: this.scalar('uint32') },
			]),
		)

		// QPI callback structs generated by qpi_macros.h.
		const rightsInput = (name: string, finalField: string) =>
			this.structFromFields(name, [
				{ name: 'asset', type: this.builtins.get('asset') as StructLayout },
				{ name: 'owner', type: this.scalar('id') },
				{ name: 'possessor', type: this.scalar('id') },
				{ name: 'numberOfShares', type: this.scalar('sint64') },
				{ name: finalField, type: this.scalar('sint64') },
				{ name: 'otherContractIndex', type: this.scalar('uint16') },
			])
		this.builtins.set(
			'premanagementrightstransfer_input',
			rightsInput('QPI::PreManagementRightsTransfer_input', 'offeredFee'),
		)
		this.builtins.set(
			'postmanagementrightstransfer_input',
			rightsInput('QPI::PostManagementRightsTransfer_input', 'receivedFee'),
		)
		this.builtins.set(
			'premanagementrightstransfer_output',
			this.structFromFields('QPI::PreManagementRightsTransfer_output', [
				{ name: 'allowTransfer', type: this.scalar('bool') },
				{ name: 'requestedFee', type: this.scalar('sint64') },
			]),
		)
		this.builtins.set(
			'postincomingtransfer_input',
			this.structFromFields('QPI::PostIncomingTransfer_input', [
				{ name: 'sourceId', type: this.scalar('id') },
				{ name: 'amount', type: this.scalar('sint64') },
				{ name: 'type', type: this.scalar('uint8') },
			]),
		)

		// Common QPI proposal payloads used by shareholder functions.
		this.builtins.set(
			'dateandtime',
			this.structFromFields('QPI::DateAndTime', [
				{ name: 'value', type: this.scalar('uint64') },
			]),
		)
		this.builtins.set(
			'proposalsinglevotedatav1',
			this.structFromFields('QPI::ProposalSingleVoteDataV1', [
				{ name: 'proposalIndex', type: this.scalar('uint16') },
				{ name: 'proposalType', type: this.scalar('uint16') },
				{ name: 'proposalTick', type: this.scalar('uint32') },
				{ name: 'voteValue', type: this.scalar('sint64') },
			]),
		)
		this.builtins.set(
			'proposalmultivotedatav1',
			this.structFromFields('QPI::ProposalMultiVoteDataV1', [
				{ name: 'proposalIndex', type: this.scalar('uint16') },
				{ name: 'proposalType', type: this.scalar('uint16') },
				{ name: 'proposalTick', type: this.scalar('uint32') },
				{ name: 'voteValues', type: arrayOf(this.scalar('sint64'), 8) },
				{ name: 'voteCounts', type: arrayOf(this.scalar('uint32'), 8) },
			]),
		)
		const summarizedUnion = unionFromFields(
			'QPI::ProposalSummarizedVotingDataV1::Votes',
			[
				{ name: 'optionVoteCount', type: arrayOf(this.scalar('uint32'), 8) },
				{ name: 'scalarVotingResult', type: this.scalar('sint64') },
			],
		)
		this.builtins.set(
			'proposalsummarizedvotingdatav1',
			this.structFromFields('QPI::ProposalSummarizedVotingDataV1', [
				{ name: 'proposalIndex', type: this.scalar('uint16') },
				{ name: 'optionCount', type: this.scalar('uint16') },
				{ name: 'proposalTick', type: this.scalar('uint32') },
				{ name: 'totalVotesAuthorized', type: this.scalar('uint32') },
				{ name: 'totalVotesCasted', type: this.scalar('uint32') },
				{ name: 'votes', type: summarizedUnion },
			]),
		)
		const transfer = this.structFromFields('QPI::ProposalDataYesNo::Transfer', [
			{ name: 'destination', type: this.scalar('id') },
			{ name: 'amount', type: this.scalar('sint64') },
		])
		const variableOptions = this.structFromFields(
			'QPI::ProposalDataYesNo::VariableOptions',
			[
				{ name: 'variable', type: this.scalar('uint64') },
				{ name: 'value', type: this.scalar('sint64') },
			],
		)
		const proposalDataUnion = unionFromFields('QPI::ProposalDataYesNo::Data', [
			{ name: 'transfer', type: transfer },
			{ name: 'variableOptions', type: variableOptions },
		])
		this.builtins.set(
			'proposaldatayesno',
			this.structFromFields('QPI::ProposalDataYesNo', [
				{ name: 'url', type: arrayOf(this.scalar('uint8'), 256) },
				{ name: 'epoch', type: this.scalar('uint16') },
				{ name: 'type', type: this.scalar('uint16') },
				{ name: 'tick', type: this.scalar('uint32') },
				{ name: 'data', type: proposalDataUnion },
			]),
		)
	}

	private scalar(name: ScalarFieldKind): ScalarLayout {
		const scalar = SCALARS[name]
		if (scalar === undefined)
			throw new ContractLayoutError(`Unknown scalar ${name}`)
		return {
			kind: 'scalar',
			name,
			size: scalar.size,
			alignment: scalar.alignment,
			fieldKind: scalar.fieldKind,
		}
	}

	private structFromFields(
		name: string,
		fields: { name: string; type: ResolvedType }[],
	): StructLayout {
		let offset = 0
		let alignment = 1
		const laidOut: StructLayoutField[] = []
		for (const field of fields) {
			offset = roundUp(offset, field.type.alignment)
			laidOut.push({
				...field,
				offset,
				size: field.type.size,
				alignment: field.type.alignment,
			})
			offset += field.type.size
			alignment = Math.max(alignment, field.type.alignment)
		}
		const decl = emptyStruct(name)
		return {
			kind: 'struct',
			name,
			decl,
			size: roundUp(Math.max(offset, 1), alignment),
			alignment,
			fields: laidOut,
			isUnion: false,
		}
	}

	private computeStructLayout(decl: CppStructDecl): StructLayout {
		const isUnion = decl.kind === 'union'
		let offset = 0
		let maxSize = 0
		let alignment = 1
		const fields: StructLayoutField[] = []

		// ContractBase is an empty base and does not contribute to layout under
		// the empty-base optimisation. Other non-empty bases are laid out first.
		for (const baseName of decl.bases) {
			if (baseName === 'ContractBase' || baseName === 'QPI::ContractBase')
				continue
			const base = this.resolveNamedType(
				{ kind: 'named', name: baseName, qualifiers: [], templateArgs: [] },
				decl,
			)
			if (base.kind === 'struct') {
				if (!isUnion) {
					offset = roundUp(offset, base.alignment)
					offset += base.size
				}
				maxSize = Math.max(maxSize, base.size)
				alignment = Math.max(alignment, base.alignment)
			}
		}

		for (const field of decl.fields) {
			const type = this.resolveType(field.type, decl)
			if (type.kind === 'unknown') {
				throw new ContractLayoutError(
					`Cannot lay out field ${decl.qualifiedName}::${field.name}: ${type.reason}`,
				)
			}
			if (field.bitWidth !== undefined) {
				throw new ContractLayoutError(
					`Bit-field ${decl.qualifiedName}::${field.name} is not supported by the QPI ABI`,
				)
			}

			if (isUnion) {
				fields.push({
					name: field.name,
					type,
					offset: 0,
					size: type.size,
					alignment: type.alignment,
					...(field.description === undefined
						? {}
						: { description: field.description }),
				})
				maxSize = Math.max(maxSize, type.size)
				alignment = Math.max(alignment, type.alignment)
			} else {
				offset = roundUp(offset, type.alignment)
				fields.push({
					name: field.name,
					type,
					offset,
					size: type.size,
					alignment: type.alignment,
					...(field.description === undefined
						? {}
						: { description: field.description }),
				})
				offset += type.size
				alignment = Math.max(alignment, type.alignment)
			}
		}

		const size = isUnion
			? roundUp(Math.max(maxSize, 1), alignment)
			: roundUp(Math.max(offset, 1), alignment)
		return {
			kind: 'struct',
			name: decl.qualifiedName,
			decl,
			size,
			alignment,
			fields,
			isUnion,
		}
	}

	private resolveArray(
		type: CppTypeRef,
		scope: CppStructDecl | undefined,
	): ResolvedType {
		if (
			type.of === undefined ||
			type.length === undefined ||
			type.length === null
		) {
			return {
				kind: 'unknown',
				name: type.raw ?? 'array',
				reason: 'Array bound is missing',
				size: 0,
				alignment: 1,
			}
		}
		const item = this.resolveType(type.of, scope)
		if (item.kind === 'unknown') return item
		let length: number
		try {
			length = this.evaluate(type.length)
		} catch (error) {
			return {
				kind: 'unknown',
				name: type.raw ?? 'array',
				reason: `Cannot evaluate array bound ${type.length}: ${(error as Error).message}`,
				size: 0,
				alignment: 1,
			}
		}
		if (!Number.isInteger(length) || length < 0) {
			return {
				kind: 'unknown',
				name: type.raw ?? 'array',
				reason: `Invalid array bound ${String(length)}`,
				size: 0,
				alignment: 1,
			}
		}
		return {
			kind: 'array',
			name: type.raw ?? 'array',
			item,
			length,
			size: item.size * length,
			alignment: item.alignment,
		}
	}

	private resolveNamed(
		type: CppTypeRef,
		scope: CppStructDecl | undefined,
	): ResolvedType {
		const name = type.name
		if (name.length === 0) {
			return {
				kind: 'unknown',
				name: type.raw ?? '',
				reason: 'Missing type name',
				size: 0,
				alignment: 1,
			}
		}

		if (type.templateArgs.length > 0) {
			return this.resolveTemplate(name, type.templateArgs, scope)
		}

		const scalar = SCALARS[normalizeScalarName(name)]
		if (scalar !== undefined) {
			return {
				kind: 'scalar',
				name,
				size: scalar.size,
				alignment: scalar.alignment,
				fieldKind: scalar.fieldKind,
			}
		}
		const unsupported = UNSUPPORTED_SCALARS[normalizeScalarName(name)]
		if (unsupported !== undefined) {
			if (unsupported.size === 0)
				return {
					kind: 'unknown',
					name,
					reason: 'void has no size',
					size: 0,
					alignment: 1,
				}
			// Float types exist in C++ but are not part of the QPI wire ABI. They
			// still have a natural layout for state-size purposes.
			return {
				kind: 'unknown',
				name,
				reason: `${name} is not a QPI ABI scalar`,
				size: 0,
				alignment: 1,
			}
		}

		return this.resolveNamedType(type, scope)
	}

	private resolveNamedType(
		type: CppTypeRef,
		scope: CppStructDecl | undefined,
	): ResolvedType {
		const name = type.name
		const builtinKey = normalizeScalarName(name.replace(/^QPI::/, ''))
		const builtin = this.builtins.get(builtinKey)
		// An explicitly QPI-qualified name can never be shadowed by a contract
		// declaration. Unqualified names prefer contract-local declarations.
		if (
			builtin !== undefined &&
			(name.startsWith('QPI::') || !this.isShadowed(name, scope))
		)
			return builtin

		const struct = this.findStructDecl(name, scope)
		if (struct !== undefined) return this.layoutStruct(struct)

		const enumDecl = this.findEnumDecl(name, scope)
		if (enumDecl !== undefined) return this.layoutEnum(enumDecl)

		const typedef = this.findTypedef(name, scope)
		if (typedef !== undefined) {
			const key = `${scope?.qualifiedName ?? ''}::${name}`
			if (this.typedefInProgressNames.has(key)) {
				return {
					kind: 'unknown',
					name,
					reason: 'Recursive typedef',
					size: 0,
					alignment: 1,
				}
			}
			this.typedefInProgressNames.add(key)
			try {
				const resolved = this.resolveType(typedef, scope)
				if (resolved.kind !== 'unknown') return resolved
			} finally {
				this.typedefInProgressNames.delete(key)
			}
		}

		// Container aliases such as `Array<T, N>` are resolved before this point.
		return {
			kind: 'unknown',
			name,
			reason: `Unknown type ${name}`,
			size: 0,
			alignment: 1,
		}
	}

	private resolveTemplate(
		name: string,
		args: CppTemplateArgument[],
		scope: CppStructDecl | undefined,
	): ResolvedType {
		const short =
			name
				.replace(/^QPI::/, '')
				.split('::')
				.pop() ?? name
		const displayName = templateDisplayName(short, args)
		switch (short) {
			case 'Array':
			case 'SlowAnySizeArray': {
				const item = this.templateTypeArg(args[0], scope)
				const length = this.templateValueArg(args[1])
				if (
					item === undefined ||
					length === undefined ||
					!Number.isInteger(length) ||
					length < 0
				) {
					return {
						kind: 'unknown',
						name,
						reason: 'Invalid Array arguments',
						size: 0,
						alignment: 1,
					}
				}
				return {
					kind: 'array',
					name: displayName,
					item,
					length,
					size: item.size * length,
					alignment: item.alignment,
				}
			}
			case 'BitArray': {
				const bits = this.templateValueArg(args[0])
				if (bits === undefined || !Number.isInteger(bits) || bits < 0) {
					return {
						kind: 'unknown',
						name,
						reason: 'Invalid BitArray size',
						size: 0,
						alignment: 1,
					}
				}
				const words = Math.ceil(bits / 64)
				return {
					kind: 'array',
					name: displayName,
					item: {
						kind: 'scalar',
						name: 'uint64',
						size: 8,
						alignment: 8,
						fieldKind: 'uint64',
					},
					length: words,
					size: words * 8,
					alignment: 8,
				}
			}
			case 'Collection': {
				const item = this.templateTypeArg(args[0], scope)
				const capacity = this.templateValueArg(args[1])
				if (item === undefined || capacity === undefined || capacity <= 0) {
					return {
						kind: 'unknown',
						name,
						reason: 'Invalid Collection arguments',
						size: 0,
						alignment: 1,
					}
				}
				return this.collectionLayout(displayName, item, capacity)
			}
			case 'HashMap': {
				const key = this.templateTypeArg(args[0], scope)
				const value = this.templateTypeArg(args[1], scope)
				const capacity = this.templateValueArg(args[2])
				if (
					key === undefined ||
					value === undefined ||
					capacity === undefined ||
					capacity <= 0
				) {
					return {
						kind: 'unknown',
						name,
						reason: 'Invalid HashMap arguments',
						size: 0,
						alignment: 1,
					}
				}
				return this.hashMapLayout(displayName, key, value, capacity)
			}
			case 'ProposalDataV1': {
				return this.proposalDataV1Layout(displayName)
			}
			case 'HashSet': {
				const key = this.templateTypeArg(args[0], scope)
				const capacity = this.templateValueArg(args[1])
				if (key === undefined || capacity === undefined || capacity <= 0) {
					return {
						kind: 'unknown',
						name,
						reason: 'Invalid HashSet arguments',
						size: 0,
						alignment: 1,
					}
				}
				return this.hashSetLayout(displayName, key, capacity)
			}
			default:
				return {
					kind: 'unknown',
					name,
					reason: `Unsupported template ${name}`,
					size: 0,
					alignment: 1,
				}
		}
	}

	private templateTypeArg(
		arg: CppTemplateArgument | undefined,
		scope: CppStructDecl | undefined,
	): ResolvedType | undefined {
		if (arg === undefined) return undefined
		if (arg.type !== undefined) {
			const resolved = this.resolveType(arg.type, scope)
			return resolved.kind === 'unknown' ? undefined : resolved
		}
		return undefined
	}

	private templateValueArg(
		arg: CppTemplateArgument | undefined,
	): number | undefined {
		if (arg === undefined) return undefined
		const expression = arg.expression ?? arg.type?.name
		if (expression === undefined) return undefined
		try {
			return this.evaluate(expression)
		} catch {
			return undefined
		}
	}

	private proposalDataV1Layout(name: string): ResolvedType {
		const transfer = this.structFromFields(`${name}::Transfer`, [
			{ name: 'destination', type: this.scalar('id') },
			{ name: 'amounts', type: arrayOf(this.scalar('sint64'), 4) },
		])
		const transferInEpoch = this.structFromFields(`${name}::TransferInEpoch`, [
			{ name: 'destination', type: this.scalar('id') },
			{ name: 'amount', type: this.scalar('sint64') },
			{ name: 'targetEpoch', type: this.scalar('uint16') },
		])
		const variableOptions = this.structFromFields(`${name}::VariableOptions`, [
			{ name: 'variable', type: this.scalar('uint64') },
			{ name: 'values', type: arrayOf(this.scalar('sint64'), 4) },
		])
		const variableScalar = this.structFromFields(`${name}::VariableScalar`, [
			{ name: 'variable', type: this.scalar('uint64') },
			{ name: 'minValue', type: this.scalar('sint64') },
			{ name: 'maxValue', type: this.scalar('sint64') },
			{ name: 'proposedValue', type: this.scalar('sint64') },
		])
		const data = unionFromFields(`${name}::Data`, [
			{ name: 'transfer', type: transfer },
			{ name: 'transferInEpoch', type: transferInEpoch },
			{ name: 'variableOptions', type: variableOptions },
			{ name: 'variableScalar', type: variableScalar },
		])
		return this.structFromFields(name, [
			{ name: 'url', type: arrayOf(this.scalar('uint8'), 256) },
			{ name: 'epoch', type: this.scalar('uint16') },
			{ name: 'type', type: this.scalar('uint16') },
			{ name: 'tick', type: this.scalar('uint32') },
			{ name: 'data', type: data },
		])
	}

	private collectionLayout(
		name: string,
		item: ResolvedType,
		capacity: number,
	): ResolvedType {
		// Matches QPI::Collection<T, L> from src/qpi/qpi_containers.h.
		const pov = this.structFromFields(`${name}::PoV`, [
			{ name: 'value', type: this.scalar('id') },
			{ name: 'population', type: this.scalar('uint64') },
			{ name: 'headIndex', type: this.scalar('sint64') },
			{ name: 'tailIndex', type: this.scalar('sint64') },
			{ name: 'bstRootIndex', type: this.scalar('sint64') },
		])
		const element = this.structFromFields(`${name}::Element`, [
			{ name: 'value', type: item },
			{ name: 'priority', type: this.scalar('sint64') },
			{ name: 'povIndex', type: this.scalar('sint64') },
			{ name: 'bstParentIndex', type: this.scalar('sint64') },
			{ name: 'bstLeftIndex', type: this.scalar('sint64') },
			{ name: 'bstRightIndex', type: this.scalar('sint64') },
		])
		const flagCount = Math.ceil((capacity * 2) / 64)
		const fieldTypes: { name: string; type: ResolvedType }[] = [
			{
				name: '_povs',
				type: {
					kind: 'array',
					name: '',
					item: pov,
					length: capacity,
					size: pov.size * capacity,
					alignment: pov.alignment,
				},
			},
			{
				name: '_povOccupationFlags',
				type: arrayOf(this.scalar('uint64'), flagCount),
			},
			{
				name: '_elements',
				type: {
					kind: 'array',
					name: '',
					item: element,
					length: capacity,
					size: element.size * capacity,
					alignment: element.alignment,
				},
			},
			{ name: '_population', type: this.scalar('uint64') },
			{ name: '_markRemovalCounter', type: this.scalar('uint64') },
		]
		return this.structFromFields(name, fieldTypes)
	}

	private hashMapLayout(
		name: string,
		key: ResolvedType,
		value: ResolvedType,
		capacity: number,
	): ResolvedType {
		const element = this.structFromFields(`${name}::Element`, [
			{ name: 'key', type: key },
			{ name: 'value', type: value },
		])
		return this.structFromFields(name, [
			{
				name: '_elements',
				type: {
					kind: 'array',
					name: '',
					item: element,
					length: capacity,
					size: element.size * capacity,
					alignment: element.alignment,
				},
			},
			{
				name: '_occupationFlags',
				type: arrayOf(this.scalar('uint64'), Math.ceil((capacity * 2) / 64)),
			},
			{ name: '_population', type: this.scalar('uint64') },
			{ name: '_markRemovalCounter', type: this.scalar('uint64') },
		])
	}

	private hashSetLayout(
		name: string,
		key: ResolvedType,
		capacity: number,
	): ResolvedType {
		return this.structFromFields(name, [
			{
				name: '_keys',
				type: {
					kind: 'array',
					name: '',
					item: key,
					length: capacity,
					size: key.size * capacity,
					alignment: key.alignment,
				},
			},
			{
				name: '_occupationFlags',
				type: arrayOf(this.scalar('uint64'), Math.ceil((capacity * 2) / 64)),
			},
			{ name: '_population', type: this.scalar('uint64') },
			{ name: '_markRemovalCounter', type: this.scalar('uint64') },
		])
	}

	private layoutEnum(decl: CppEnumDecl): EnumLayout {
		const underlying =
			decl.underlyingType === undefined
				? undefined
				: this.resolveType(decl.underlyingType)
		const fieldKind: ScalarFieldKind =
			underlying?.kind === 'scalar' && isScalarKind(underlying.fieldKind)
				? underlying.fieldKind
				: 'sint32'
		const scalar = SCALARS[fieldKind] ?? SCALARS.sint32
		if (scalar === undefined)
			throw new ContractLayoutError(`Cannot resolve enum ${decl.qualifiedName}`)

		let nextValue = 0
		const values: { name: string; value: number }[] = []
		const local = new Map<string, number>()
		for (const member of decl.members) {
			let value = nextValue
			if (member.expression !== undefined) {
				try {
					const evaluator = new ExpressionEvaluator((name) => {
						const localValue = local.get(name)
						if (localValue !== undefined) return localValue
						return this.resolveConstant(name)
					})
					value = evaluator.evaluate(member.expression)
				} catch {
					value = nextValue
				}
			}
			values.push({ name: member.name, value })
			local.set(member.name, value)
			nextValue = value + 1
		}

		return {
			kind: 'enum',
			name: decl.qualifiedName,
			decl,
			size: scalar.size,
			alignment: scalar.alignment,
			fieldKind,
			values,
		}
	}

	private findStructDecl(
		name: string,
		scope?: CppStructDecl,
	): CppStructDecl | undefined {
		return this.lookupQualified(name, scope, this.structByQualifiedName)
	}

	private findEnumDecl(
		name: string,
		scope?: CppStructDecl,
	): CppEnumDecl | undefined {
		return this.lookupQualified(name, scope, this.enumByQualifiedName)
	}

	private findTypedef(
		name: string,
		scope?: CppStructDecl,
	): CppTypeRef | undefined {
		return this.lookupQualified(name, scope, this.typedefByQualifiedName)
	}

	private lookupQualified<T>(
		name: string,
		scope: CppStructDecl | undefined,
		table: Map<string, T>,
	): T | undefined {
		const clean = name.replace(/^::/, '')
		const direct = table.get(clean)
		if (direct !== undefined) return direct

		if (scope !== undefined) {
			let scopeName: string | undefined = scope.qualifiedName
			while (scopeName !== undefined) {
				const candidate = table.get(`${scopeName}::${clean}`)
				if (candidate !== undefined) return candidate
				scopeName = this.parentByQualifiedName.get(scopeName)
			}
		}

		// Qualified names may be written relative to the contract root.
		const separator = clean.indexOf('::')
		if (separator !== -1 && scope !== undefined) {
			const rootName = scope.qualifiedName.split('::')[0] as string
			const candidate = table.get(`${rootName}::${clean}`)
			if (candidate !== undefined) return candidate
		}

		return undefined
	}

	private isShadowed(name: string, scope: CppStructDecl | undefined): boolean {
		const clean = name.replace(/^QPI::/, '')
		return (
			this.findStructDecl(clean, scope) !== undefined ||
			this.findEnumDecl(clean, scope) !== undefined ||
			this.findTypedef(clean, scope) !== undefined
		)
	}

	private findInputOutputType(
		contract: CppStructDecl,
		name: string,
	): CppTypeRef | undefined {
		const direct = this.findTypedef(name, contract)
		if (direct !== undefined) return direct
		const struct = this.findStructDecl(name, contract)
		if (struct !== undefined) {
			return {
				kind: 'named',
				name: struct.qualifiedName,
				qualifiers: [],
				templateArgs: [],
				raw: struct.qualifiedName,
			}
		}
		return undefined
	}

	private resolveConstant(
		name: string,
		extra?: Record<string, number>,
	): number {
		const clean = name.replace(/^::/, '').split('::').pop() ?? name
		if (extra !== undefined && Object.hasOwn(extra, clean)) {
			return extra[clean] as number
		}
		if (Object.hasOwn(BUILTIN_CONSTANTS, clean)) {
			return BUILTIN_CONSTANTS[clean] as number
		}
		const cached = this.constantCache.get(clean)
		if (cached !== undefined) return cached
		const extraValue = this.options.constants?.[clean]
		if (extraValue !== undefined) {
			const value =
				typeof extraValue === 'number' ? extraValue : Number(extraValue)
			this.constantCache.set(clean, value)
			return value
		}

		const expression = this.module.constants[clean]
		if (expression === undefined) {
			throw new ContractLayoutError(`Unknown constant ${clean}`)
		}
		if (this.constantInProgress.has(clean)) {
			throw new ContractLayoutError(`Recursive constant ${clean}`)
		}
		this.constantInProgress.add(clean)
		try {
			const evaluator = new ExpressionEvaluator((nested) =>
				this.resolveConstant(nested, extra),
			)
			const value = evaluator.evaluate(expression)
			this.constantCache.set(clean, value)
			return value
		} finally {
			this.constantInProgress.delete(clean)
		}
	}

	private describeFields(
		type: ResolvedType,
		scope: CppStructDecl,
		structs: Record<string, ContractStruct>,
		enums: Record<string, ContractEnum>,
	): ContractField[] {
		if (type.kind === 'unknown' || type.kind === 'pointer') {
			throw new ContractLayoutError(
				`Cannot describe ${type.kind} type ${type.name}`,
			)
		}
		if (type.kind !== 'struct') {
			throw new ContractLayoutError(
				`Call input/output must be a struct, got ${type.kind}`,
			)
		}
		this.toContractStruct(type, structs, enums)
		return type.fields.map((field) =>
			this.toContractField(field, scope, structs, enums),
		)
	}

	private toContractField(
		field: StructLayoutField,
		scope: CppStructDecl,
		structs: Record<string, ContractStruct>,
		enums: Record<string, ContractEnum>,
	): ContractField {
		const base = {
			name: field.name,
			offset: field.offset,
			byteLength: field.size,
			...(field.description === undefined
				? {}
				: { description: field.description }),
		}
		return {
			...base,
			...this.describeType(field.type, field.name, scope, structs, enums),
		}
	}

	private describeType(
		type: ResolvedType,
		fieldName: string,
		scope: CppStructDecl,
		structs: Record<string, ContractStruct>,
		enums: Record<string, ContractEnum>,
	): Pick<ContractField, 'type' | 'structRef' | 'enumRef' | 'array'> {
		switch (type.kind) {
			case 'scalar':
				return { type: type.fieldKind }
			case 'enum': {
				const contractEnum = this.toContractEnum(type)
				enums[contractEnum.name] = contractEnum
				return { type: 'enum', enumRef: contractEnum.name }
			}
			case 'struct': {
				const contractStruct = this.toContractStruct(type, structs, enums)
				return { type: 'struct', structRef: contractStruct.name }
			}
			case 'array': {
				const item = type.item
				if (item.kind === 'array') {
					throw new ContractLayoutError(
						`Nested array field ${fieldName} is not representable in ContractField`,
					)
				}
				if (item.kind === 'unknown' || item.kind === 'pointer') {
					throw new ContractLayoutError(
						`Array field ${fieldName} has unsupported item type ${item.name}`,
					)
				}
				const itemType: Exclude<ContractFieldKind, 'array'> =
					item.kind === 'scalar'
						? item.fieldKind
						: item.kind === 'enum'
							? 'enum'
							: 'struct'
				const array: ContractArrayInfo = {
					length: type.length,
					itemType,
					itemByteLength: item.size,
				}
				if (item.kind === 'struct') {
					array.itemStructRef = this.toContractStruct(item, structs, enums).name
				} else if (item.kind === 'enum') {
					array.itemEnumRef = this.toContractEnum(item).name
					enums[array.itemEnumRef] = this.toContractEnum(item)
				}
				return { type: 'array', array }
			}
			case 'unknown':
			case 'pointer':
				throw new ContractLayoutError(
					`Field ${fieldName} has unsupported type ${type.name}`,
				)
		}
		void scope
	}

	private toContractStruct(
		layout: StructLayout,
		structs: Record<string, ContractStruct>,
		enums: Record<string, ContractEnum>,
	): ContractStruct {
		const existing = structs[layout.name]
		if (existing !== undefined) return existing
		const contractStruct: ContractStruct = {
			name: layout.name,
			fields: [],
			byteLength: layout.size,
			alignment: layout.alignment,
		}
		structs[layout.name] = contractStruct
		contractStruct.fields = layout.fields.map((field) =>
			this.toContractField(field, layout.decl, structs, enums),
		)
		return contractStruct
	}

	private toContractEnum(layout: EnumLayout): ContractEnum {
		return {
			name: layout.name,
			underlyingType: layout.fieldKind,
			byteLength: layout.size,
			values: layout.values,
		}
	}
}

function unionFromFields(
	name: string,
	fields: { name: string; type: ResolvedType }[],
): StructLayout {
	let size = 0
	let alignment = 1
	const laidOut: StructLayoutField[] = []
	for (const field of fields) {
		laidOut.push({
			...field,
			offset: 0,
			size: field.type.size,
			alignment: field.type.alignment,
		})
		size = Math.max(size, field.type.size)
		alignment = Math.max(alignment, field.type.alignment)
	}
	const decl = emptyStruct(name)
	return {
		kind: 'struct',
		name,
		decl,
		size: roundUp(Math.max(size, 1), alignment),
		alignment,
		fields: laidOut,
		isUnion: true,
	}
}

function templateDisplayName(
	short: string,
	args: CppTemplateArgument[],
): string {
	const rendered = args.map((arg) => {
		if (arg.type !== undefined && arg.expression === undefined)
			return arg.type.raw ?? arg.type.name
		return arg.expression ?? arg.type?.name ?? '?'
	})
	return `${short}<${rendered.join(', ')}>`
}

function emptyStruct(name: string): CppStructDecl {
	return {
		kind: 'struct',
		name,
		qualifiedName: name,
		bases: [],
		fields: [],
		structs: [],
		enums: [],
		typedefs: [],
		calls: [],
		registrations: [],
		line: 1,
	}
}

function arrayOf(item: ResolvedType, length: number): ArrayLayout {
	return {
		kind: 'array',
		name: '',
		item,
		length,
		size: item.size * length,
		alignment: item.alignment,
	}
}

/** Parse a header and build its ABI in one call. */
export function buildContractAbi(
	source: string,
	options: BuildContractAbiOptions & { fileName?: string } = {},
): ContractAbi {
	const parsed = parseContract(source, { fileName: options.fileName })
	const engine = new CppLayoutEngine(parsed.module, options)
	return engine.buildContractAbi(parsed, options)
}

/** Parse and lay out a header, returning the engine for further queries. */
export function buildLayout(
	source: string,
	options: LayoutOptions & { fileName?: string } = {},
): { parsed: ParsedContract; engine: CppLayoutEngine } {
	const parsed = parseContract(source, { fileName: options.fileName })
	return { parsed, engine: new CppLayoutEngine(parsed.module, options) }
}

interface ExpressionToken {
	kind: 'number' | 'identifier' | 'operator' | 'open' | 'close' | 'eof'
	value: string
}

class ExpressionEvaluator {
	private readonly tokens: ExpressionToken[]
	private position = 0
	private readonly resolve: (name: string) => number

	constructor(resolve: (name: string) => number, tokens?: ExpressionToken[]) {
		this.resolve = resolve
		this.tokens = tokens ?? []
	}

	evaluate(expression: string): number {
		this.tokens.splice(0, this.tokens.length, ...tokenizeExpression(expression))
		this.position = 0
		const value = this.parseBitOr()
		const next = this.peek()
		if (next.kind !== 'eof') {
			throw new ContractLayoutError(
				`Unexpected token ${next.value} in expression ${expression}`,
			)
		}
		const result = Number(value)
		if (!Number.isFinite(result))
			throw new ContractLayoutError(`Expression is not finite: ${expression}`)
		return result
	}

	private peek(): ExpressionToken {
		return this.tokens[this.position] ?? { kind: 'eof', value: '' }
	}

	private next(): ExpressionToken {
		const token = this.peek()
		if (token.kind !== 'eof') this.position += 1
		return token
	}

	private eat(value: string): boolean {
		if (this.peek().value === value) {
			this.position += 1
			return true
		}
		return false
	}

	private parseBitOr(): bigint {
		let value = this.parseBitXor()
		while (this.eat('|')) value |= this.parseBitXor()
		return value
	}

	private parseBitXor(): bigint {
		let value = this.parseBitAnd()
		while (this.eat('^')) value ^= this.parseBitAnd()
		return value
	}

	private parseBitAnd(): bigint {
		let value = this.parseShift()
		while (this.eat('&')) value &= this.parseShift()
		return value
	}

	private parseShift(): bigint {
		let value = this.parseAdditive()
		while (true) {
			if (this.eat('<<')) value <<= this.parseAdditive()
			else if (this.eat('>>')) value >>= this.parseAdditive()
			else break
		}
		return value
	}

	private parseAdditive(): bigint {
		let value = this.parseMultiplicative()
		while (true) {
			if (this.eat('+')) value += this.parseMultiplicative()
			else if (this.eat('-')) value -= this.parseMultiplicative()
			else break
		}
		return value
	}

	private parseMultiplicative(): bigint {
		let value = this.parseUnary()
		while (true) {
			if (this.eat('*')) value *= this.parseUnary()
			else if (this.eat('/')) {
				const divisor = this.parseUnary()
				if (divisor === 0n)
					throw new ContractLayoutError(
						'Division by zero in constant expression',
					)
				value /= divisor
			} else if (this.eat('%')) {
				const divisor = this.parseUnary()
				if (divisor === 0n)
					throw new ContractLayoutError(
						'Division by zero in constant expression',
					)
				value %= divisor
			} else break
		}
		return value
	}

	private parseUnary(): bigint {
		if (this.eat('+')) return this.parseUnary()
		if (this.eat('-')) return -this.parseUnary()
		if (this.eat('~')) return ~this.parseUnary()
		if (this.eat('!')) return this.parseUnary() === 0n ? 1n : 0n
		return this.parsePrimary()
	}

	private skipTemplateArguments(): void {
		let depth = 0
		while (true) {
			const token = this.next()
			if (token.kind === 'eof') return
			if (token.value === '<') depth += 1
			else if (token.value === '>') {
				depth -= 1
				if (depth === 0) return
			}
		}
	}

	private parseFunctionCall(name: string): bigint {
		if (!this.eat('('))
			throw new ContractLayoutError(`Expected "(" after ${name}`)
		const args: bigint[] = []
		if (this.peek().value !== ')') {
			while (true) {
				args.push(this.parseBitOr())
				if (this.eat(',')) continue
				break
			}
		}
		if (!this.eat(')'))
			throw new ContractLayoutError(`Missing ")" in call to ${name}`)
		const first = args[0] ?? 0n
		const second = args[1] ?? 0n
		switch (name.replace(/^QPI::/, '')) {
			case 'div':
				if (second === 0n)
					throw new ContractLayoutError(
						'Division by zero in constant expression',
					)
				return (first + second - 1n) / second
			case 'min':
				return first < second ? first : second
			case 'max':
				return first > second ? first : second
			case 'abs':
				return first < 0n ? -first : first
			default:
				throw new ContractLayoutError(`Unsupported constant function ${name}`)
		}
	}

	private parsePrimary(): bigint {
		const token = this.next()
		if (token.kind === 'number') return parseInteger(token.value)
		if (token.kind === 'identifier') {
			if (token.value === 'true') return 1n
			if (token.value === 'false') return 0n
			if (this.peek().value === '<') this.skipTemplateArguments()
			if (this.peek().value === '(') return this.parseFunctionCall(token.value)
			return BigInt(Math.trunc(this.resolve(token.value)))
		}
		if (token.value === '(') {
			const value = this.parseBitOr()
			if (!this.eat(')'))
				throw new ContractLayoutError(`Missing ")" in constant expression`)
			return value
		}
		throw new ContractLayoutError(
			`Unexpected token ${token.value || 'end of expression'} in constant expression`,
		)
	}
}

function parseInteger(raw: string): bigint {
	const clean = raw.replace(/'/g, '').replace(/[uUlLzZ]+$/g, '')
	if (/^0[xX]/.test(clean)) return BigInt(clean)
	if (/^0[bB]/.test(clean)) return BigInt(`0b${clean.slice(2)}`)
	if (/^0[0-7]+$/.test(clean)) return BigInt(`0o${clean.slice(1)}`)
	if (clean.includes('.')) {
		const value = Number(clean)
		if (!Number.isInteger(value))
			throw new ContractLayoutError(`Non-integer constant ${raw}`)
		return BigInt(value)
	}
	return BigInt(clean)
}

function tokenizeExpression(expression: string): ExpressionToken[] {
	const tokens: ExpressionToken[] = []
	let index = 0
	while (index < expression.length) {
		const char = expression[index] as string
		if (/\s/.test(char)) {
			index += 1
			continue
		}
		if (char === '(') {
			tokens.push({ kind: 'open', value: char })
			index += 1
			continue
		}
		if (char === ')') {
			tokens.push({ kind: 'close', value: char })
			index += 1
			continue
		}
		if (/[0-9]/.test(char)) {
			const start = index
			if (char === '0' && /[xXbB]/.test(expression[index + 1] ?? '')) index += 2
			while (
				index < expression.length &&
				/[0-9A-Fa-f']/.test(expression[index] as string)
			)
				index += 1
			while (
				index < expression.length &&
				/[uUlLzZ]/.test(expression[index] as string)
			)
				index += 1
			tokens.push({ kind: 'number', value: expression.slice(start, index) })
			continue
		}
		if (/[A-Za-z_]/.test(char)) {
			const start = index
			index += 1
			while (
				index < expression.length &&
				/[A-Za-z0-9_:]/.test(expression[index] as string)
			)
				index += 1
			tokens.push({ kind: 'identifier', value: expression.slice(start, index) })
			continue
		}
		const two = expression.slice(index, index + 2)
		if (['<<', '>>'].includes(two)) {
			tokens.push({ kind: 'operator', value: two })
			index += 2
			continue
		}
		if ('+-*/%&|^~!<>,:'.includes(char)) {
			tokens.push({ kind: 'operator', value: char })
			index += 1
			continue
		}
		throw new ContractLayoutError(
			`Unexpected character ${JSON.stringify(char)} in constant expression`,
		)
	}
	tokens.push({ kind: 'eof', value: '' })
	return tokens
}
