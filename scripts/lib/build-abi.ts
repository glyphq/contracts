/**
 * Build the public ContractDefinition metadata from qubic/core sources.
 *
 * This layer is intentionally stricter than the C++ parser:
 * - every registered user call must resolve to a public declaration and a
 *   concrete input/output layout;
 * - unknown constants, enum IDs, or types abort generation instead of
 *   producing silently wrong offsets;
 * - calls are sorted by registered inputType, which is the canonical call
 *   identifier used by transactions and RPC.
 */

import { contractIndexToIdentity } from '@qubic.org/crypto'
import type {
	ContractCall,
	ContractCallKind,
	ContractDefinition,
	ContractEnum,
	ContractField,
	ContractStruct,
	StructScope,
} from '../../src/types.js'
import { parseContractDef, parseCppFile } from './cpp.js'
import type { CoreSource } from './fetch-core.js'
import {
	buildContractEnum,
	LayoutError,
	type LayoutType,
	layoutDeclaredStruct,
	TypeRegistry,
} from './layout.js'
import type {
	ContractDefEntry,
	CppCallDecl,
	CppRegistration,
	ParsedCppFile,
} from './model.js'
import {
	QPI_BUILTIN_SOURCE,
	QPI_CONTAINER_ALIAS_SOURCE,
} from './qpi-builtins.js'

export interface BuildResult {
	contracts: ContractDefinition[]
	qpi: StructScope
	warnings: string[]
}

/** Raised when qubic/core contains something the generator cannot model safely. */
export class AbiBuildError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'AbiBuildError'
	}
}

function required<T>(value: T | undefined, message: string): T {
	if (value === undefined) throw new AbiBuildError(message)
	return value
}

interface ParsedContract {
	entry: ContractDefEntry
	module: ParsedCppFile
	contract: ParsedCppFile['contractClasses'][number]
}

export function buildContracts(source: CoreSource): BuildResult {
	const contractDef = source.files.get('src/contract_core/contract_def.h')
	if (contractDef === undefined) {
		throw new AbiBuildError('Missing src/contract_core/contract_def.h')
	}

	const definition = parseContractDef(contractDef)
	const registry = new TypeRegistry()
	const warnings: string[] = []

	// The restricted parser understands namespaces, so the real QPI headers can
	// supply types that are not needed by call I/O but are referenced by state
	// and local structs, such as QPI::Entity.
	const nativeQpiModules: ParsedCppFile[] = []
	for (const path of [
		'src/qpi/qpi_types.h',
		'src/qpi/qpi_containers.h',
		'src/qpi/qpi_date_time.h',
		'src/qpi/qpi_proposals.h',
	]) {
		const text = source.files.get(path)
		if (text === undefined) {
			throw new AbiBuildError(`Missing QPI header ${path}`)
		}
		const module = parseCppFile(text, path)
		nativeQpiModules.push(module)
		registry.addModule(module, { unqualifiedAliases: false })
	}

	// The mirror instantiates ABI-critical templates and flattens unions that
	// the C++ parser cannot resolve without a full template engine.
	const builtins = parseCppFile(QPI_BUILTIN_SOURCE, 'qpi-builtins.h')
	registry.addModule(builtins, { scope: 'QPI' })
	registry.addModule(
		parseCppFile(QPI_CONTAINER_ALIAS_SOURCE, 'qpi-container-aliases.h'),
		{
			scope: 'QPI',
		},
	)
	const price = builtins.structs.find((decl) => decl.qualifiedName === 'Price')
	if (price !== undefined) {
		registry.addStruct(price, 'OI')
		for (const decl of builtins.structs) {
			if (decl.qualifiedName.startsWith('Price::'))
				registry.addStruct(decl, 'OI')
		}
	}

	const qpi: StructScope = { structs: {}, enums: {} }
	const qpiDecls = new Map<string, ParsedCppFile['structs'][number]>()
	// The hand-written mirror is authoritative for ABI-critical QPI types
	// because it instantiates templates and flattens unions exactly. Native
	// headers only fill in types the mirror does not cover, such as
	// QPI::Entity.
	for (const decl of builtins.structs) {
		const qualified = decl.qualifiedName || decl.name
		qpiDecls.set(
			qualified.startsWith('QPI::') ? qualified : `QPI::${qualified}`,
			decl,
		)
	}
	for (const module of nativeQpiModules) {
		for (const decl of module.structs) {
			if (decl.isTemplate) continue
			const qualified = decl.qualifiedName || decl.name
			if (!qualified.startsWith('QPI::') || qpiDecls.has(qualified)) continue
			if (
				[...qpiDecls.keys()].some((parent) =>
					qualified.startsWith(`${parent}::`),
				)
			) {
				continue
			}
			qpiDecls.set(qualified, decl)
		}
	}
	for (const module of nativeQpiModules) {
		for (const decl of module.enums) {
			const qualified = decl.qualifiedName || decl.name
			if (qualified.includes('::__anonymous_enum_')) continue
			try {
				qpi.enums[qualified] = buildContractEnum(decl, registry)
			} catch (error) {
				if (!(error instanceof LayoutError)) throw error
			}
		}
	}
	for (const [qualified, decl] of qpiDecls) {
		try {
			addStruct(qualified, decl, 'QPI', registry, qpi.structs, qpi.enums)
		} catch (error) {
			if (!(error instanceof LayoutError)) throw error
		}
	}

	const parsed = new Map<string, ParsedContract>()
	for (const entry of definition.entries) {
		const path = `src/contracts/${entry.fileName}`
		const text = source.files.get(path)
		if (text === undefined) {
			throw new AbiBuildError(`Missing contract header ${path}`)
		}
		const module = parseCppFile(text, entry.fileName)
		const contract = module.contractClasses[0]
		if (contract === undefined) {
			throw new AbiBuildError(`No ContractBase struct found in ${path}`)
		}
		if (contract.name !== entry.stateType) {
			throw new AbiBuildError(
				`${path} defines ${contract.name}, expected ${entry.stateType} from contract_def.h`,
			)
		}
		registry.addModule(module)
		parsed.set(entry.stateType, { entry, module, contract })
	}

	injectKnownMacroCalls(registry, parsed)

	const contracts: ContractDefinition[] = []
	for (const entry of definition.entries) {
		const contract = parsed.get(entry.stateType)
		if (contract === undefined) continue
		contracts.push(buildOneContract(contract, registry, warnings))
	}

	contracts.sort((a, b) => a.index - b.index)
	return { contracts, qpi, warnings }
}

function buildOneContract(
	parsed: ParsedContract,
	registry: TypeRegistry,
	warnings: string[],
): ContractDefinition {
	const { entry, module, contract } = parsed
	const structs: Record<string, ContractStruct> = {}
	const enums: Record<string, ContractEnum> = {}
	const callByName = new Map(module.calls.map((call) => [call.name, call]))

	const procedures: ContractCall[] = []
	const functions: ContractCall[] = []
	const notifications: ContractCall[] = []
	const seen = new Set<string>()

	for (const registration of module.registrations) {
		const inputType = resolveRegistrationInputType(
			registration,
			registry,
			entry.stateType,
		)
		const callDecl = callByName.get(registration.name)

		if (registration.kind === 'notification') {
			if (callDecl === undefined) {
				warnings.push(
					`${entry.stateType}: notification ${registration.name} has no declaration`,
				)
				continue
			}
			notifications.push(
				buildCall(
					entry.stateType,
					registration.name,
					'notification',
					null,
					callDecl,
					registry,
					structs,
					enums,
				),
			)
			continue
		}

		if (callDecl === undefined) {
			throw new AbiBuildError(
				`${entry.stateType}: registered ${registration.kind} ${registration.name} has no declaration`,
			)
		}
		if (inputType === null) {
			throw new AbiBuildError(
				`${entry.stateType}: cannot resolve inputType for ${registration.kind} ${registration.name}`,
			)
		}
		const key = `${registration.kind}:${inputType}`
		if (seen.has(key)) {
			warnings.push(
				`${entry.stateType}: duplicate ${registration.kind} inputType ${inputType}`,
			)
			continue
		}
		seen.add(key)

		const call = buildCall(
			entry.stateType,
			registration.name,
			registration.kind,
			inputType,
			callDecl,
			registry,
			structs,
			enums,
		)
		if (registration.kind === 'function') functions.push(call)
		else procedures.push(call)
	}

	functions.sort((a, b) => (a.inputType ?? 0) - (b.inputType ?? 0))
	procedures.sort((a, b) => (a.inputType ?? 0) - (b.inputType ?? 0))
	notifications.sort((a, b) => a.name.localeCompare(b.name))

	// Include every struct declared in the contract header, not just the ones
	// reachable from call I/O. State, logger, and local structs are useful for
	// explorers and debugging, and they share the same C++ memory layout.
	const skipped: string[] = []
	for (const decl of module.structs) {
		const qualified = decl.qualifiedName || decl.name
		if (qualified === '') continue
		try {
			addStruct(qualified, decl, entry.stateType, registry, structs, enums)
		} catch (error) {
			if (!(error instanceof LayoutError)) throw error
			skipped.push(qualified)
		}
	}
	if (skipped.length > 0) {
		const sample = skipped.slice(0, 3).join(', ')
		const suffix = skipped.length > 3 ? ', ...' : ''
		warnings.push(
			`${entry.stateType}: skipped ${skipped.length} struct(s) with state-only containers (${sample}${suffix})`,
		)
	}

	return {
		index: entry.index,
		name: entry.stateType,
		assetName: entry.assetName ?? entry.stateType,
		contractAddress: contractIndexToIdentity(entry.index),
		fileName: entry.fileName,
		constructionEpoch: entry.constructionEpoch,
		destructionEpoch: entry.destructionEpoch,
		stateSize: null,
		source: {
			path: `src/contracts/${entry.fileName}`,
			line: contract.line,
		},
		procedures,
		functions,
		notifications,
		structs,
		enums,
	}
}

function buildCall(
	contractName: string,
	name: string,
	kind: ContractCallKind,
	inputType: number | null,
	decl: CppCallDecl,
	registry: TypeRegistry,
	structs: Record<string, ContractStruct>,
	enums: Record<string, ContractEnum>,
): ContractCall {
	const input = registry.resolveType(
		{ name: decl.inputStructRef },
		decl.scope || contractName,
	)
	const output = registry.resolveType(
		{ name: decl.outputStructRef },
		decl.scope || contractName,
	)
	const inputFields = describeTopLevel(
		input,
		contractName,
		registry,
		structs,
		enums,
	)
	const outputFields = describeTopLevel(
		output,
		contractName,
		registry,
		structs,
		enums,
	)

	return {
		kind,
		name,
		inputType,
		inputSize: input.size,
		outputSize: output.size,
		inputAlignment: input.align,
		outputAlignment: output.align,
		inputFields,
		outputFields,
		...(decl.description === undefined
			? {}
			: { description: decl.description }),
	}
}

/**
 * Convert a call I/O type to a field list. QPI procedures may use a scalar or
 * array typedef as input/output; expose those as a single `value` field so the
 * wire shape stays explicit.
 */
function describeTopLevel(
	type: LayoutType,
	contractName: string,
	registry: TypeRegistry,
	structs: Record<string, ContractStruct>,
	enums: Record<string, ContractEnum>,
): ContractField[] {
	switch (type.kind) {
		case 'scalar':
			return [
				{
					name: 'value',
					type: required(type.scalar, `${contractName}: missing scalar kind`),
					offset: 0,
					byteLength: type.size,
				},
			]
		case 'enum':
			return describeTopLevelEnum(type, registry, enums)
		case 'array':
			return [
				describeTopLevelArray(type, contractName, registry, structs, enums),
			]
		case 'struct': {
			const decl = required(type.struct, `${contractName}: missing struct type`)
			const qualified = type.qualifiedName ?? decl.qualifiedName
			addStruct(qualified, decl, contractName, registry, structs, enums)
			return layoutDeclaredStruct(decl, registry).fields
		}
		default:
			throw new AbiBuildError(
				`${contractName}: unsupported call I/O type ${type.kind}`,
			)
	}
}

function describeTopLevelEnum(
	type: LayoutType,
	registry: TypeRegistry,
	enums: Record<string, ContractEnum>,
): ContractField[] {
	const qualified = required(
		type.qualifiedName,
		'Enum call I/O is missing a qualified name',
	)
	if (type.enum !== undefined)
		enums[qualified] = buildContractEnum(type.enum, registry)
	return [
		{
			name: 'value',
			type: 'enum',
			enumRef: qualified,
			offset: 0,
			byteLength: type.size,
		},
	]
}

function describeTopLevelArray(
	type: LayoutType,
	contractName: string,
	registry: TypeRegistry,
	structs: Record<string, ContractStruct>,
	enums: Record<string, ContractEnum>,
): ContractField {
	const item = required(
		type.item,
		`${contractName}: array is missing an item type`,
	)
	const itemField = describeArrayItem(
		item,
		contractName,
		registry,
		structs,
		enums,
	)
	return {
		name: 'value',
		type: 'array',
		offset: 0,
		byteLength: type.size,
		array: {
			length: required(
				type.arrayLength,
				`${contractName}: array is missing a length`,
			),
			itemType: itemField.type,
			itemByteLength: item.size,
			...(itemField.structRef === undefined
				? {}
				: { itemStructRef: itemField.structRef }),
			...(itemField.enumRef === undefined
				? {}
				: { itemEnumRef: itemField.enumRef }),
		},
	}
}

function describeArrayItem(
	type: LayoutType,
	contractName: string,
	registry: TypeRegistry,
	structs: Record<string, ContractStruct>,
	enums: Record<string, ContractEnum>,
): {
	type: Exclude<ContractField['type'], 'array'>
	structRef?: string
	enumRef?: string
} {
	switch (type.kind) {
		case 'scalar':
			return {
				type: required(type.scalar, `${contractName}: missing scalar kind`),
			}
		case 'enum': {
			const qualified = required(
				type.qualifiedName,
				`${contractName}: enum is missing a qualified name`,
			)
			if (type.enum !== undefined)
				enums[qualified] = buildContractEnum(type.enum, registry)
			return { type: 'enum', enumRef: qualified }
		}
		case 'struct': {
			const decl = required(
				type.struct,
				`${contractName}: nested struct is missing a type`,
			)
			const qualified = type.qualifiedName ?? decl.qualifiedName
			addStruct(qualified, decl, contractName, registry, structs, enums)
			return { type: 'struct', structRef: qualified }
		}
		default:
			throw new AbiBuildError(
				`${contractName}: nested arrays are not supported in QPI call I/O`,
			)
	}
}

function addStruct(
	qualified: string,
	decl: import('./model.js').CppStruct,
	contractName: string,
	registry: TypeRegistry,
	structs: Record<string, ContractStruct>,
	enums: Record<string, ContractEnum>,
): void {
	if (structs[qualified] !== undefined) return
	const layout = layoutDeclaredStruct(decl, registry)
	for (const field of layout.fields)
		addReferencedTypes(field, contractName, registry, structs, enums)
	structs[qualified] = { ...layout, name: qualified }
}

function addReferencedTypes(
	field: ContractField,
	contractName: string,
	registry: TypeRegistry,
	structs: Record<string, ContractStruct>,
	enums: Record<string, ContractEnum>,
): void {
	if (field.type === 'enum' && field.enumRef !== undefined) {
		const decl = registry.enums.get(field.enumRef)
		if (decl !== undefined)
			enums[field.enumRef] = buildContractEnum(decl, registry)
		return
	}
	if (field.type === 'struct' && field.structRef !== undefined) {
		const decl = registry.structs.get(field.structRef)
		if (decl === undefined)
			throw new AbiBuildError(
				`${contractName}: unresolved struct ${field.structRef}`,
			)
		addStruct(field.structRef, decl, contractName, registry, structs, enums)
		return
	}
	if (field.type === 'array' && field.array !== undefined) {
		const { itemStructRef, itemEnumRef } = field.array
		if (itemStructRef !== undefined) {
			const decl = registry.structs.get(itemStructRef)
			if (decl === undefined)
				throw new AbiBuildError(
					`${contractName}: unresolved struct ${itemStructRef}`,
				)
			addStruct(itemStructRef, decl, contractName, registry, structs, enums)
		}
		if (itemEnumRef !== undefined) {
			const decl = registry.enums.get(itemEnumRef)
			if (decl !== undefined)
				enums[itemEnumRef] = buildContractEnum(decl, registry)
		}
	}
}

function resolveRegistrationInputType(
	registration: CppRegistration,
	registry: TypeRegistry,
	contractName: string,
): number | null {
	if (registration.inputType !== null) return registration.inputType
	if (registration.inputTypeExpression === undefined) return null
	return (
		registry.resolveEnumValue(registration.inputTypeExpression, contractName) ??
		null
	)
}

/**
 * QUtil uses IMPLEMENT_DEFAULT_SHAREHOLDER_PROPOSAL_VOTING and
 * REGISTER_SHAREHOLDER_PROPOSAL_VOTING from qpi_macros.h. The parser does not
 * expand C preprocessor macros, so add the generated structs, declarations,
 * and stable registration IDs (65531-65535) explicitly.
 */
function injectKnownMacroCalls(
	registry: TypeRegistry,
	parsed: Map<string, ParsedContract>,
): void {
	const quutil = parsed.get('QUTIL')
	if (quutil === undefined) return
	const usesMacro = quutil.module.macroInvocations.some(
		(invocation) =>
			invocation.name === 'IMPLEMENT_DEFAULT_SHAREHOLDER_PROPOSAL_VOTING',
	)
	if (!usesMacro) return

	const synthetic = `
typedef ProposalDataYesNo ProposalDataT;
struct SetShareholderProposal_input { ProposalDataT proposal; };
struct SetShareholderProposal_output { uint16 value; };
struct GetShareholderProposal_input { uint16 proposalIndex; };
struct GetShareholderProposal_output { ProposalDataT proposal; id proposerPubicKey; };
struct GetShareholderProposalIndices_input { bit activeProposals; sint32 prevProposalIndex; };
struct GetShareholderProposalIndices_output { uint16 numOfIndices; Array<uint16, 64> indices; };
struct GetShareholderProposalFees_input { };
struct GetShareholderProposalFees_output { sint64 setProposalFee; sint64 setVoteFee; };
struct SetShareholderVotes_input { ProposalMultiVoteDataV1 vote; };
struct SetShareholderVotes_output { bit value; };
struct GetShareholderVotes_input { id voter; uint16 proposalIndex; };
struct GetShareholderVotes_output { ProposalMultiVoteDataV1 value; };
struct GetShareholderVotingResults_input { uint16 proposalIndex; };
struct GetShareholderVotingResults_output { ProposalSummarizedVotingDataV1 value; };
`
	const module = parseCppFile(synthetic, 'qutil-shareholder-macro.h')
	registry.addModule(module, { scope: 'QUTIL' })

	const definitions: Array<[string, ContractCallKind, number]> = [
		['SetShareholderProposal', 'procedure', 65534],
		['SetShareholderVotes', 'procedure', 65535],
		['GetShareholderProposalFees', 'function', 65531],
		['GetShareholderProposalIndices', 'function', 65532],
		['GetShareholderProposal', 'function', 65533],
		['GetShareholderVotes', 'function', 65534],
		['GetShareholderVotingResults', 'function', 65535],
	]

	for (const [name, kind, inputType] of definitions) {
		if (!quutil.module.calls.some((call) => call.name === name)) {
			quutil.module.calls.push({
				name,
				kind: kind === 'notification' ? 'procedure' : kind,
				visibility: 'public',
				hasLocals: false,
				inputStructRef: `QUTIL::${name}_input`,
				outputStructRef: `QUTIL::${name}_output`,
				localsStructRef: `QUTIL::${name}_locals`,
				scope: 'QUTIL',
				line: quutil.contract.line,
			})
		}
		if (
			!quutil.module.registrations.some(
				(registration) => registration.name === name,
			)
		) {
			quutil.module.registrations.push({
				kind: kind === 'notification' ? 'notification' : kind,
				name,
				inputType,
				inputTypeExpression: String(inputType),
				line: quutil.contract.line,
			})
		}
	}
}
