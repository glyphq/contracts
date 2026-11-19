/**
 * Build-time-only typed model for the restricted QPI C++ subset used by
 * Qubic smart contracts.
 *
 * Assumptions / scope
 * -------------------
 * - This module is consumed by the generator, never by browser code. It has
 *   no runtime dependencies (no fs, no Bun, no `src/types.ts`) so the parser
 *   can be tested and run independently of the published package.
 * - The model mirrors the declarations that exist in contract headers. It is
 *   deliberately close to source: layout (padding, offsets, sizes) is computed
 *   later by `layout.ts`, and the generator maps these shapes onto the public
 *   `ContractDefinition` types in `src/types.ts`.
 * - Names are stored both unqualified (`name`) and as a fully qualified name
 *   (`qualifiedName`, e.g. `QX::AssetAskOrders_output::Order`). Lookup is done
 *   with `qualifyTypeName`/`LayoutRegistry`, which understand nested scopes.
 * - Doc comments are attached only when they immediately precede the
 *   declaration (blank lines are allowed, other declarations are not).
 */

/** Scalar kinds understood by the ABI layout engine. Mirrors src/types.ts. */
export type ScalarFieldKind =
	| 'uint8'
	| 'sint8'
	| 'uint16'
	| 'sint16'
	| 'uint32'
	| 'sint32'
	| 'uint64'
	| 'sint64'
	| 'uint128'
	| 'id'
	| 'bit'
	| 'bool'

/** A parsed C++ type reference. */
export interface CppTypeRef {
	/**
	 * Canonical or source type name. Builtin spellings are normalized
	 * (`unsigned int` -> `uint32`), user types keep their source qualification
	 * (`QX::Fees_input`, `Order`, `QPI::Asset`).
	 */
	name: string
	/** Template arguments, e.g. `Array<Order, 256>` -> [Order, 256]. */
	templateArgs?: CppTemplateArg[]
	/** C-style array dimensions (`Type name[N]`). */
	arrayLengths?: string[]
	/** True for pointer/reference declarations (unsupported for ABI fields). */
	isPointer?: boolean
}

/** One template argument: either a type or a value expression. */
export type CppTemplateArg =
	| { kind: 'type'; type: CppTypeRef }
	| { kind: 'value'; expression: string }

/** A struct/class/union field declaration. */
export interface CppField {
	name: string
	type: CppTypeRef
	/** 1-based source line of the declaration. */
	line: number
	/** Doc comment immediately preceding the field, if any. */
	description?: string
	/** Initializer expression, kept for diagnostics; never part of layout. */
	initializer?: string
}

/** A parsed struct, class, or union definition. */
export interface CppStruct {
	/** Unqualified name (`Fees_input`, `Order`, `QX`). */
	name: string
	/** Fully qualified name (`QX::Fees_input`, `QX::AssetAskOrders_output::Order`). */
	qualifiedName: string
	/** Enclosing scope (`QX`, `QX::AssetAskOrders_output`, or `""`). */
	scope: string
	kind: 'struct' | 'class' | 'union'
	bases: string[]
	fields: CppField[]
	nestedStructs: CppStruct[]
	nestedEnums: CppEnum[]
	description?: string
	line: number
	/** True when declared with `template <...>`. Such structs are not instantiated by layouts. */
	isTemplate: boolean
	templateParameters: string[]
}

/** One enumerator. */
export interface CppEnumValue {
	name: string
	/** Evaluated value, or `null` if the expression could not be resolved. */
	value: number | null
	/** Raw initializer expression when one was written. */
	expression?: string
	description?: string
}

/** A parsed enum, including `enum class X : uint8`. */
export interface CppEnum {
	name: string
	qualifiedName: string
	scope: string
	/** Underlying type from `: underlying`, canonicalized; `null` means C++ `int`. */
	underlyingType: string | null
	/** True for `enum class` / `enum struct`. */
	isScoped: boolean
	values: CppEnumValue[]
	description?: string
	line: number
}

/** A `constexpr`/`static constexpr` constant or an object-like `#define`. */
export interface CppConstant {
	name: string
	qualifiedName: string
	scope: string
	expression: string
	value: number | null
	/** Canonical C++ type when declared with constexpr; `null` for macros. */
	type: string | null
	source: 'constexpr' | 'define' | 'enum'
	description?: string
	line: number
}

/** A `typedef X Y;` or `using Y = X;` alias. */
export interface CppTypedef {
	name: string
	qualifiedName: string
	scope: string
	target: CppTypeRef
	description?: string
	line: number
	kind: 'typedef' | 'using'
}

/** A PUBLIC_* / PRIVATE_* call declaration. */
export interface CppCallDecl {
	name: string
	kind: 'procedure' | 'function'
	visibility: 'public' | 'private'
	hasLocals: boolean
	/** Struct references derived from the QPI naming convention. */
	inputStructRef: string
	outputStructRef: string
	localsStructRef: string
	/** Enclosing contract class, e.g. `QX`. */
	scope: string
	description?: string
	line: number
}

/** One REGISTER_USER_* invocation. */
export interface CppRegistration {
	kind: 'function' | 'procedure' | 'notification'
	name: string
	/** Raw input-type expression (function/procedure registrations). */
	inputTypeExpression?: string
	/** Evaluated registration id, or `null` when it could not be resolved. */
	inputType: number | null
	line: number
}

/** A macro invocation the generator may need to expand (e.g. IMPLEMENT_*). */
export interface CppMacroInvocation {
	name: string
	args: string[]
	line: number
}

/** Object-like or function-like macro captured by the preprocessor-lite pass. */
export interface CppMacroDefinition {
	name: string
	/** Empty string for function-like macros without a body (none expected). */
	value: string
	/** Parameter names for function-like macros. */
	parameters?: string[]
	line: number
}

/** Everything extracted from one contract header. */
export interface ParsedCppFile {
	/** Path as supplied to `parseCppFile` (usually `contracts/Qx.h`). */
	path: string
	/** Flattened list of all structs (nested ones included), in source order. */
	structs: CppStruct[]
	/** Flattened list of all enums. */
	enums: CppEnum[]
	/** Flattened list of constants, including enum members with `source: "enum"`. */
	constants: CppConstant[]
	typedefs: CppTypedef[]
	macros: CppMacroDefinition[]
	includes: string[]
	calls: CppCallDecl[]
	registrations: CppRegistration[]
	macroInvocations: CppMacroInvocation[]
	/** Top-level structs deriving from `ContractBase` (usually one per file). */
	contractClasses: CppStruct[]
}

/** One contract block from `contract_def.h`. */
export interface ContractDefEntry {
	index: number
	/** `CONTRACT_STATE_TYPE`, e.g. `QX`. */
	stateType: string
	/** `CONTRACT_STATE2_TYPE`, e.g. `QX2`. */
	state2Type: string | null
	/** Header file name as written in `#include "contracts/..."`, e.g. `Qx.h`. */
	fileName: string
	/** Include path as written, e.g. `contracts/Qx.h`. */
	includePath: string
	/** Asset name from `contractDescriptions`, e.g. `QX`; `null` when absent. */
	assetName: string | null
	constructionEpoch: number | null
	destructionEpoch: number | null
	/** Raw `sizeof(...)` operand from `contractDescriptions`, useful for stateSize. */
	stateSizeExpression: string | null
	line: number
}

/** Result of `parseContractDef`. */
export interface ParsedContractDef {
	entries: ContractDefEntry[]
	/** Entries keyed by on-chain contract index. */
	byIndex: Map<number, ContractDefEntry>
	/** Entries keyed by `CONTRACT_STATE_TYPE`. */
	byStateType: Map<string, ContractDefEntry>
}

/** Layout of one struct as computed from the C++ ABI rules. */
export interface ComputedStructLayout {
	name: string
	fields: ComputedField[]
	/** `sizeof(struct)`, including trailing padding. */
	byteLength: number
	/** `alignof(struct)`. */
	alignment: number
}

/**
 * ContractField-shaped descriptor. Intentionally structurally compatible with
 * `ContractField` in `src/types.ts` so the generator can copy it over.
 */
export interface ComputedField {
	name: string
	type: ScalarFieldKind | 'enum' | 'struct' | 'array'
	offset: number
	byteLength: number
	structRef?: string
	enumRef?: string
	array?: {
		length: number
		itemType: ScalarFieldKind | 'enum' | 'struct'
		itemByteLength: number
		itemStructRef?: string
		itemEnumRef?: string
	}
	description?: string
}

/** A resolved type in the layout engine. */
export interface ResolvedType {
	kind: 'scalar' | 'enum' | 'struct' | 'array'
	/** Canonical name (`uint32`, `QX::Fees_input`, `Array`). */
	name: string
	size: number
	alignment: number
	/** Present for scalars. */
	scalar?: ScalarFieldKind
	/** Present for enums. */
	enumRef?: string
	/** Present for structs. */
	structRef?: string
	/** Present for arrays. */
	item?: ResolvedType
	length?: number
}

/** Error thrown for declarations outside the supported subset. */
export class CppModelError extends Error {
	readonly path?: string
	readonly line?: number

	constructor(
		message: string,
		options: { path?: string; line?: number; cause?: unknown } = {},
	) {
		const location = options.path
			? `${options.path}:${options.line ?? 1}`
			: options.line !== undefined
				? `line ${options.line}`
				: undefined
		super(location ? `${location}: ${message}` : message, {
			cause: options.cause,
		})
		this.name = 'CppModelError'
		this.path = options.path
		this.line = options.line
	}
}
