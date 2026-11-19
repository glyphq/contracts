import { CppParseError } from './cpp-error.ts'
import { type CppToken, tokenize } from './tokenizer.ts'

/**
 * The parser intentionally models C++ declarations, not C++ semantics. It
 * keeps every type name as written so the layout engine can resolve it against
 * either the contract itself or the built-in QPI type registry.
 */
export type CppStructKind = 'struct' | 'class' | 'union'

export interface CppTemplateArgument {
	kind: 'type' | 'value' | 'ambiguous'
	/** Set when the argument can be parsed as a type. */
	type?: CppTypeRef
	/** Raw expression text, with tokens separated by spaces. */
	expression?: string
}

export interface CppTypeRef {
	kind: 'named' | 'pointer' | 'reference' | 'array' | 'unknown'
	/** Unqualified name for pointers/arrays is empty; scalars keep their spelling. */
	name: string
	qualifiers: string[]
	templateArgs: CppTemplateArgument[]
	/** Pointee or element type for pointers, references, and arrays. */
	of?: CppTypeRef
	/** Array bound expression, or `null` for an unsized array. */
	length?: string | null
	/** Original spelling, useful for diagnostics. */
	raw?: string
}

export interface CppFieldDecl {
	name: string
	type: CppTypeRef
	/** Bit-field width, when present. Bit-fields are not part of the QPI ABI. */
	bitWidth?: string
	isStatic?: boolean
	line: number
	description?: string
}

export interface CppEnumMember {
	name: string
	expression?: string
	line: number
}

export interface CppEnumDecl {
	name: string
	qualifiedName: string
	/** Underlying type after `:`, if written. */
	underlyingType?: CppTypeRef
	members: CppEnumMember[]
	line: number
	description?: string
}

export interface CppTypedefDecl {
	name: string
	qualifiedName: string
	type: CppTypeRef
	line: number
	description?: string
}

export type CppCallKind = 'function' | 'procedure'

export interface CppCallDecl {
	kind: CppCallKind
	name: string
	visibility: 'public' | 'protected' | 'private'
	hasLocals: boolean
	line: number
	description?: string
}

export interface CppRegistration {
	kind: CppCallKind | 'notification'
	name: string
	inputType: number | null
	line: number
}

export interface CppStructDecl {
	kind: CppStructKind
	name: string
	qualifiedName: string
	bases: string[]
	fields: CppFieldDecl[]
	structs: CppStructDecl[]
	enums: CppEnumDecl[]
	typedefs: CppTypedefDecl[]
	calls: CppCallDecl[]
	registrations: CppRegistration[]
	line: number
	description?: string
}

export interface CppModule {
	fileName?: string
	structs: CppStructDecl[]
	enums: CppEnumDecl[]
	typedefs: CppTypedefDecl[]
	/** Simple object-like `#define` values, keyed by macro name. */
	constants: Record<string, string>
	includes: string[]
}

export interface ParsedContract {
	module: CppModule
	/** Top-level struct deriving from `ContractBase`. */
	contract: CppStructDecl | undefined
}

export interface ParseOptions {
	fileName?: string
}

const ACCESS_SPECIFIERS = new Set(['public', 'private', 'protected'])
const DECLARATION_QUALIFIERS = new Set([
	'const',
	'volatile',
	'static',
	'constexpr',
	'consteval',
	'constinit',
	'inline',
	'mutable',
	'friend',
	'virtual',
	'explicit',
	'extern',
	'register',
	'typename',
])
const TYPE_KEYWORDS = new Set(['struct', 'class', 'union', 'enum'])
const BUILTIN_WORDS = new Set([
	'void',
	'bool',
	'char',
	'short',
	'int',
	'long',
	'float',
	'double',
	'signed',
	'unsigned',
	'auto',
])
const CALL_MACRO_PATTERN =
	/^(PUBLIC|PRIVATE)_(FUNCTION|PROCEDURE)(_WITH_LOCALS)?$/
const REGISTER_PATTERN =
	/^REGISTER_USER_(FUNCTION|PROCEDURE|PROCEDURE_NOTIFICATION)$/

function isIdentifier(token: CppToken | undefined): token is CppToken {
	return token?.kind === 'identifier'
}

function cleanComment(raw: string): string {
	if (raw.startsWith('//')) {
		return raw.slice(2).trim()
	}
	const body = raw.slice(2, -2)
	return body
		.split('\n')
		.map((line) => line.replace(/^\s*\*?\s?/, '').trimEnd())
		.join('\n')
		.trim()
}

function tokensToExpression(tokens: readonly CppToken[]): string {
	let output = ''
	for (const token of tokens) {
		if (output.length === 0) {
			output = token.value
			continue
		}
		const needsSpace = !/^[),\]>]$/.test(token.value) && !/[([<]$/.test(output)
		output += needsSpace ? ` ${token.value}` : token.value
	}
	return output
}

class TokenCursor {
	private index = 0
	private readonly tokens: CppToken[]

	constructor(tokens: CppToken[]) {
		this.tokens = tokens
	}

	get position(): number {
		return this.index
	}

	atEnd(): boolean {
		return this.index >= this.tokens.length
	}

	peek(ahead = 0): CppToken | undefined {
		return this.tokens[this.index + ahead]
	}

	next(): CppToken | undefined {
		const token = this.tokens[this.index]
		if (token !== undefined) this.index += 1
		return token
	}

	eat(value: string): boolean {
		if (this.peek()?.value === value) {
			this.index += 1
			return true
		}
		return false
	}

	remaining(): number {
		return this.tokens.length - this.index
	}

	rest(): CppToken[] {
		return this.tokens.slice(this.index)
	}
}

/**
 * Parse the C++ subset used by Qubic contract headers.
 *
 * The parser accepts full contract headers, including function bodies,
 * methods, templates used only in state, and preprocessor directives. It only
 * materialises declarations; bodies and attributes are skipped with balanced
 * token matching.
 */
export function parseCpp(
	source: string,
	options: ParseOptions = {},
): CppModule {
	return new CppParser(
		tokenize(source, {
			fileName: options.fileName,
			includeComments: true,
			includePreprocessor: true,
		}),
		options.fileName,
	).parseModule()
}

/** Parse a header and locate the top-level `ContractBase` derivative. */
export function parseContract(
	source: string,
	options: ParseOptions = {},
): ParsedContract {
	const module = parseCpp(source, options)
	const contract = module.structs.find((decl) =>
		decl.bases.some(
			(base) => base === 'ContractBase' || base.endsWith('::ContractBase'),
		),
	)
	return { module, contract }
}

/** Iterate a struct and every struct nested inside it. */
export function* walkStructs(
	structs: readonly CppStructDecl[],
): Generator<CppStructDecl> {
	for (const decl of structs) {
		yield decl
		yield* walkStructs(decl.structs)
	}
}

class CppParser {
	private readonly tokens: CppToken[]
	private readonly fileName: string | undefined
	private position = 0
	private readonly constants: Record<string, string> = {}
	private readonly includes: string[] = []

	constructor(tokens: CppToken[], fileName: string | undefined) {
		this.tokens = tokens
		this.fileName = fileName
	}

	parseModule(): CppModule {
		const module: CppModule = {
			...(this.fileName === undefined ? {} : { fileName: this.fileName }),
			structs: [],
			enums: [],
			typedefs: [],
			constants: this.constants,
			includes: this.includes,
		}

		while (!this.atEnd()) {
			const description = this.skipTrivia()
			const token = this.peek()
			if (token === undefined) break
			const value = token.value

			if (value === ';') {
				this.consume()
				continue
			}

			if (value === 'namespace') {
				this.skipNamespace()
				continue
			}

			if (value === 'using') {
				const alias = this.parseUsing(undefined, description)
				if (alias !== undefined) module.typedefs.push(alias)
				continue
			}

			if (value === 'typedef') {
				const aliases = this.parseTypedef(undefined, description)
				module.typedefs.push(...aliases)
				continue
			}

			if (value === 'enum') {
				const decl = this.parseEnum(undefined, description)
				if (decl !== undefined) module.enums.push(decl)
				continue
			}

			if (value === 'struct' || value === 'class' || value === 'union') {
				const decl = this.parseStruct(undefined, description)
				if (decl !== undefined) module.structs.push(decl)
				continue
			}

			if (value === 'template') {
				this.skipTemplateHeader()
				continue
			}

			if (value === 'extern' && this.peek(1)?.kind === 'string') {
				this.skipStatement()
				continue
			}

			if (value === 'constexpr' || value === 'const' || value === 'static') {
				this.parseTopLevelConstant()
				continue
			}

			// Unknown top-level construct: skip a balanced statement or block. This
			// keeps the parser useful in the presence of unrelated helper code.
			this.skipStatement()
		}

		return module
	}

	private atEnd(): boolean {
		return this.rawPeek()?.kind === 'eof'
	}

	/** Peek at the raw stream, including comments and preprocessor tokens. */
	private rawPeek(ahead = 0): CppToken | undefined {
		return this.tokens[this.position + ahead]
	}

	private rawConsume(): CppToken | undefined {
		const token = this.tokens[this.position]
		if (token !== undefined) this.position += 1
		return token
	}

	/**
	 * Consume comments and preprocessor directives that sit between syntactic
	 * tokens, such as `struct Foo // comment\n {`. Declarations collect their
	 * doc comments with {@link skipTrivia} before this happens.
	 */
	private skipIgnorable(): void {
		while (true) {
			const token = this.rawPeek()
			if (token === undefined) return
			if (token.kind === 'comment') {
				this.rawConsume()
				continue
			}
			if (token.kind === 'preprocessor') {
				this.consumeDirective(token)
				continue
			}
			return
		}
	}

	/** Handle one directive token and skip `#if 0` regions. */
	private consumeDirective(token: CppToken): void {
		this.handleDirective(token.value)
		this.rawConsume()
		if (/^#\s*if\s+0\b/.test(token.value)) this.skipDisabledConditional()
	}

	private skipDisabledConditional(): void {
		let depth = 1
		while (!this.atEnd()) {
			const token = this.rawPeek()
			if (token === undefined) return
			if (token.kind === 'preprocessor') {
				const directive = token.value
				if (/^#\s*if/.test(directive)) {
					depth += 1
				} else if (/^#\s*endif\b/.test(directive)) {
					depth -= 1
					this.rawConsume()
					if (depth === 0) return
					continue
				} else if (depth === 1 && /^#\s*(else|elif)\b/.test(directive)) {
					// The alternative branch is active; let the normal parser see it.
					this.rawConsume()
					return
				}
				this.rawConsume()
				continue
			}
			this.rawConsume()
		}
	}

	private peek(ahead = 0): CppToken | undefined {
		this.skipIgnorable()
		if (ahead === 0) return this.rawPeek(0)
		let index = this.position
		let remaining = ahead
		while (remaining > 0) {
			index += 1
			const token = this.tokens[index]
			if (token === undefined) return undefined
			if (token.kind === 'comment' || token.kind === 'preprocessor') continue
			remaining -= 1
		}
		return this.tokens[index]
	}

	private consume(): CppToken | undefined {
		this.skipIgnorable()
		return this.rawConsume()
	}

	private error(
		message: string,
		token: CppToken | undefined = this.peek(),
	): never {
		throw new CppParseError(message, {
			fileName: this.fileName,
			line: token?.line ?? 1,
			column: token?.column ?? 1,
			offset: token?.offset ?? 0,
		})
	}

	private expect(value: string): CppToken {
		const token = this.peek()
		if (token?.value !== value) {
			this.error(
				`Expected "${value}" but found "${token?.value ?? 'end of file'}"`,
			)
		}
		return this.consume() as CppToken
	}

	/**
	 * Skip comments and preprocessor directives. Returns the text of the
	 * contiguous comment group immediately before the next declaration.
	 */
	private skipTrivia(): string | undefined {
		const comments: CppToken[] = []
		while (true) {
			const token = this.rawPeek()
			if (token === undefined || token.kind === 'eof') break
			if (token.kind === 'comment') {
				comments.push(token)
				this.rawConsume()
				continue
			}
			if (token.kind === 'preprocessor') {
				this.consumeDirective(token)
				continue
			}
			break
		}

		if (comments.length === 0) return undefined
		const next = this.rawPeek()
		const last = comments[comments.length - 1]
		if (next !== undefined && last !== undefined && next.line - last.line > 2) {
			return undefined
		}
		return (
			comments
				.map((comment) => cleanComment(comment.value))
				.filter(Boolean)
				.join('\n') || undefined
		)
	}

	private handleDirective(directive: string): void {
		const define = /^#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/s.exec(
			directive,
		)
		if (define !== null) {
			const name = define[1]
			const body = define[2]
			if (name !== undefined && body !== undefined && !body.includes('\\')) {
				this.constants[name] = body.trim()
			}
			return
		}
		const include = /^#\s*include\s+([<"].+[>"])$/.exec(directive)
		if (include !== null) {
			const target = include[1]
			if (target !== undefined)
				this.includes.push(target.replace(/^[<"]|[>"]$/g, ''))
		}
	}

	private skipNamespace(): void {
		this.consume() // namespace
		if (isIdentifier(this.peek())) this.consume()
		if (this.peek()?.value !== '{') {
			this.skipStatement()
			return
		}
		this.skipBalanced('{', '}')
	}

	private parseUsing(
		owner: CppStructDecl | undefined,
		description: string | undefined,
	): CppTypedefDecl | undefined {
		const start = this.consume() // using
		if (this.peek()?.value === 'namespace') {
			this.skipStatement()
			return undefined
		}
		const nameToken = this.peek()
		if (!isIdentifier(nameToken)) {
			this.skipStatement()
			return undefined
		}
		this.consume()
		if (!this.eat('=')) {
			this.skipStatement()
			return undefined
		}
		const tokens = this.collectUntilSemicolon()
		this.expect(';')
		const type = this.parseTypeFromTokens(tokens)
		return {
			name: nameToken.value,
			qualifiedName:
				owner === undefined
					? nameToken.value
					: `${owner.qualifiedName}::${nameToken.value}`,
			type,
			line: start?.line ?? nameToken.line,
			...(description === undefined ? {} : { description }),
		}
	}

	private parseTypedef(
		owner: CppStructDecl | undefined,
		description: string | undefined,
	): CppTypedefDecl[] {
		const start = this.consume() // typedef
		const tokens = this.collectUntilSemicolon()
		this.expect(';')

		// Anonymous struct/union typedefs: `typedef struct { ... } Alias;`
		const first = tokens[0]
		if (
			first !== undefined &&
			TYPE_KEYWORDS.has(first.value) &&
			tokens[1]?.value === '{'
		) {
			const bodyEnd = matchingBrace(tokens, 1)
			const aliasTokens = bodyEnd >= 0 ? tokens.slice(bodyEnd + 1) : []
			const aliasName = aliasTokens.find(
				(token) => token.kind === 'identifier',
			)?.value
			if (aliasName === undefined) return []
			return [
				{
					name: aliasName,
					qualifiedName:
						owner === undefined
							? aliasName
							: `${owner.qualifiedName}::${aliasName}`,
					type: {
						kind: 'unknown',
						name: aliasName,
						qualifiers: [],
						templateArgs: [],
						raw: tokensToExpression(tokens),
					},
					line: start?.line ?? first.line,
					...(description === undefined ? {} : { description }),
				},
			]
		}

		const parsed = parseDeclarators(tokens)
		const aliases: CppTypedefDecl[] = []
		for (const declarator of parsed) {
			aliases.push({
				name: declarator.name,
				qualifiedName:
					owner === undefined
						? declarator.name
						: `${owner.qualifiedName}::${declarator.name}`,
				type: declarator.type,
				line: start?.line ?? first?.line ?? 1,
				...(description === undefined ? {} : { description }),
			})
		}
		return aliases
	}

	private parseTopLevelConstant(): void {
		const tokens = this.collectUntilSemicolon()
		this.expect(';')
		const equals = tokens.findIndex((token) => token.value === '=')
		if (equals <= 0) return
		const nameToken = tokens
			.slice(0, equals)
			.reverse()
			.find((token) => token.kind === 'identifier')
		if (nameToken === undefined) return
		const expression = tokensToExpression(tokens.slice(equals + 1))
		if (expression.length > 0) this.constants[nameToken.value] = expression
	}

	private parseEnum(
		owner: CppStructDecl | undefined,
		description: string | undefined,
	): CppEnumDecl | undefined {
		const start = this.consume() // enum
		if (this.peek()?.value === 'class' || this.peek()?.value === 'struct')
			this.consume()
		let name = ''
		const nameToken = this.peek()
		if (isIdentifier(nameToken)) {
			name = nameToken.value
			this.consume()
		}
		let underlyingType: CppTypeRef | undefined
		if (this.eat(':')) {
			const typeTokens = this.collectUntil(
				(token) =>
					token.value === '{' || token.value === ';' || token.value === ',',
			)
			underlyingType = this.parseTypeFromTokens(typeTokens)
		}
		if (this.peek()?.value !== '{') {
			this.skipStatement()
			return undefined
		}

		const line = start?.line ?? nameToken?.line ?? 1
		const members: CppEnumMember[] = []
		this.consume() // {
		while (!this.atEnd() && this.peek()?.value !== '}') {
			const member = this.peek()
			if (member === undefined) break
			if (member.value === ',') {
				this.consume()
				continue
			}
			if (!isIdentifier(member)) {
				this.consume()
				continue
			}
			this.consume()
			let expression: string | undefined
			if (this.eat('=')) {
				const expressionTokens = this.collectUntil(
					(token) => token.value === ',' || token.value === '}',
				)
				expression = tokensToExpression(expressionTokens)
			}
			members.push({
				name: member.value,
				line: member.line,
				...(expression === undefined ? {} : { expression }),
			})
			this.eat(',')
		}
		this.expect('}')

		if (name.length === 0) {
			// Anonymous enums are only interesting for their constants. Give them a
			// stable synthetic name so consumers can still report them.
			name = `__anonymous_enum_${String(line)}`
		}

		// An anonymous enum may be followed by a declarator list.
		if (this.peek()?.value !== ';') this.skipStatement()

		return {
			name,
			qualifiedName:
				owner === undefined ? name : `${owner.qualifiedName}::${name}`,
			...(underlyingType === undefined ? {} : { underlyingType }),
			members,
			line,
			...(description === undefined ? {} : { description }),
		}
	}

	private parseStruct(
		owner: CppStructDecl | undefined,
		description: string | undefined,
		consumeTerminator = true,
	): CppStructDecl | undefined {
		const keyword = this.consume()
		if (keyword === undefined) return undefined
		const kind = keyword.value as CppStructKind

		// Attributes before the name: `struct [[nodiscard]] Foo`.
		this.skipAttributes()

		let name = ''
		const nameToken = this.peek()
		if (isIdentifier(nameToken)) {
			name = nameToken.value
			this.consume()
		}
		this.skipAttributes()
		if (this.peek()?.value === 'final') this.consume()

		const bases: string[] = []
		if (this.eat(':')) {
			while (!this.atEnd() && this.peek()?.value !== '{') {
				if (this.peek()?.value === ';') break
				if (
					this.peek()?.value === 'virtual' ||
					ACCESS_SPECIFIERS.has(this.peek()?.value ?? '')
				) {
					this.consume()
					continue
				}
				if (isIdentifier(this.peek())) {
					const base = this.parseQualifiedName()
					if (base.length > 0) bases.push(base)
				} else {
					this.consume()
				}
			}
		}

		if (this.peek()?.value !== '{') {
			this.skipStatement()
			return undefined
		}

		const line = keyword.line
		const qualifiedName =
			name.length === 0
				? `__anonymous_${kind}_${String(line)}`
				: owner === undefined
					? name
					: `${owner.qualifiedName}::${name}`
		const decl: CppStructDecl = {
			kind,
			name: name.length === 0 ? qualifiedName : name,
			qualifiedName,
			bases,
			fields: [],
			structs: [],
			enums: [],
			typedefs: [],
			calls: [],
			registrations: [],
			line,
			...(description === undefined ? {} : { description }),
		}

		this.consume() // {
		this.parseStructBody(decl)
		this.expect('}')

		if (!consumeTerminator) return decl

		// A definition may declare variables: `} instance;`
		if (this.peek()?.value !== ';') this.skipStatement()
		else this.consume()

		return decl
	}

	private parseStructBody(decl: CppStructDecl): void {
		let access: 'public' | 'protected' | 'private' =
			decl.kind === 'class' ? 'private' : 'public'

		while (!this.atEnd() && this.rawPeek()?.value !== '}') {
			const description = this.skipTrivia()
			const token = this.peek()
			if (token === undefined) break
			if (token.value === '}') break
			if (token.value === ';') {
				this.consume()
				continue
			}

			if (ACCESS_SPECIFIERS.has(token.value) && this.peek(1)?.value === ':') {
				access = token.value as typeof access
				this.consume()
				this.consume()
				continue
			}

			if (token.value === 'template') {
				this.skipTemplateHeader()
				continue
			}

			if (token.value === 'using') {
				const alias = this.parseUsing(decl, description)
				if (alias !== undefined) decl.typedefs.push(alias)
				continue
			}

			if (token.value === 'typedef') {
				decl.typedefs.push(...this.parseTypedef(decl, description))
				continue
			}

			if (token.value === 'enum') {
				const enumDecl = this.parseEnum(decl, description)
				if (enumDecl !== undefined) decl.enums.push(enumDecl)
				continue
			}

			if (
				token.value === 'struct' ||
				token.value === 'class' ||
				token.value === 'union'
			) {
				if (this.isStructDefinition()) {
					const child = this.parseStruct(decl, description, false)
					if (child !== undefined) {
						decl.structs.push(child)
						this.parseNestedStructDeclarators(decl, child)
					}
					continue
				}
			}

			if (token.kind === 'identifier') {
				const callMatch = CALL_MACRO_PATTERN.exec(token.value)
				if (callMatch !== null) {
					this.parseCallMacro(decl, access, callMatch, description)
					continue
				}
				if (token.value === 'REGISTER_USER_FUNCTIONS_AND_PROCEDURES') {
					this.parseRegistrationBlock(decl)
					continue
				}
				if (REGISTER_PATTERN.test(token.value)) {
					const registration = this.parseRegistration(decl)
					if (registration !== undefined) decl.registrations.push(registration)
					continue
				}
			}

			if (token.value === 'friend' || token.value === 'static_assert') {
				this.skipStatement()
				continue
			}

			this.parseMemberDeclaration(decl, description)
		}
	}

	/**
	 * A nested aggregate may declare instances: `struct Order { ... } order;`
	 * Anonymous aggregates with no declarator contribute their storage directly
	 * to the enclosing struct, so a synthetic field is added to keep the layout
	 * engine aware of the bytes they occupy.
	 */
	private parseNestedStructDeclarators(
		owner: CppStructDecl,
		child: CppStructDecl,
	): void {
		const tokens = this.collectUntil((token) => token.value === ';')
		this.expect(';')

		if (tokens.length === 0) {
			if (!child.name.startsWith('__anonymous_')) return
			owner.fields.push({
				name: `__anonymous_${child.kind}_${String(child.line)}`,
				type: {
					kind: 'named',
					name: child.qualifiedName,
					qualifiers: [],
					templateArgs: [],
					raw: child.qualifiedName,
				},
				line: child.line,
			})
			return
		}

		const typeToken: CppToken = {
			kind: 'identifier',
			value: child.qualifiedName,
			line: child.line,
			column: 1,
			offset: 0,
		}
		owner.fields.push(...parseDeclarators([typeToken, ...tokens]))
	}

	private isStructDefinition(): boolean {
		let depth = 0
		for (let offset = 1; this.peek(offset) !== undefined; offset += 1) {
			const token = this.peek(offset)
			if (token === undefined) return false
			const value = token.value
			if (value === '<') depth += 1
			else if (value === '>') depth -= 1
			else if (value === '>>') depth -= 2
			else if (value === '{' && depth <= 0) return true
			else if (value === ';' && depth <= 0) return false
			else if (value === '(' || value === '=') return false
		}
		return false
	}

	private parseCallMacro(
		decl: CppStructDecl,
		access: 'public' | 'protected' | 'private',
		match: RegExpExecArray,
		description: string | undefined,
	): void {
		this.consume() // macro
		this.expect('(')
		const nameToken = this.peek()
		let name = ''
		if (isIdentifier(nameToken)) {
			name = nameToken.value
			this.consume()
		}
		this.skipToClosingParen()

		const visibility =
			match[1] === 'PUBLIC'
				? 'public'
				: match[1] === 'PRIVATE'
					? 'private'
					: access
		const kind: CppCallKind = match[2] === 'FUNCTION' ? 'function' : 'procedure'
		decl.calls.push({
			kind,
			name,
			visibility,
			hasLocals: match[3] !== undefined,
			line: nameToken?.line ?? this.peek()?.line ?? 1,
			...(description === undefined ? {} : { description }),
		})

		// PUBLIC_FUNCTION / PUBLIC_PROCEDURE macros are followed by the function
		// body. Other macro spellings may only be declarations.
		if (this.peek()?.value === '{') {
			this.skipBalanced('{', '}')
		} else if (this.peek()?.value === ';') {
			this.consume()
		}
	}

	private parseRegistrationBlock(decl: CppStructDecl): void {
		this.consume() // macro name
		if (this.peek()?.value === '(') this.skipBalanced('(', ')')
		if (this.peek()?.value !== '{') {
			this.skipStatement()
			return
		}

		this.consume() // {
		let depth = 1
		while (!this.atEnd() && depth > 0) {
			const token = this.peek()
			if (token === undefined) break
			if (token.value === '{') {
				depth += 1
				this.consume()
				continue
			}
			if (token.value === '}') {
				depth -= 1
				this.consume()
				continue
			}
			if (token.kind === 'identifier' && REGISTER_PATTERN.test(token.value)) {
				const registration = this.parseRegistration(decl)
				if (registration !== undefined) decl.registrations.push(registration)
				continue
			}
			if (token.kind === 'comment' || token.kind === 'preprocessor') {
				this.consume()
				continue
			}
			this.skipStatement()
		}
	}

	private parseRegistration(decl: CppStructDecl): CppRegistration | undefined {
		void decl
		const macro = this.consume()
		if (macro === undefined) return undefined
		const match = REGISTER_PATTERN.exec(macro.value)
		if (match === null) return undefined

		this.expect('(')
		const nameToken = this.peek()
		let name = ''
		if (isIdentifier(nameToken)) {
			name = nameToken.value
			this.consume()
		}

		let inputType: number | null = null
		if (this.eat(',')) {
			const numberToken = this.peek()
			if (numberToken?.kind === 'number') {
				this.consume()
				inputType = parseIntegerLiteral(numberToken.value)
			}
		}
		this.skipToClosingParen()
		if (this.peek()?.value === ';') this.consume()

		const kind =
			match[1] === 'FUNCTION'
				? 'function'
				: match[1] === 'PROCEDURE'
					? 'procedure'
					: 'notification'
		return { kind, name, inputType, line: nameToken?.line ?? macro.line }
	}

	private parseMemberDeclaration(
		decl: CppStructDecl,
		description: string | undefined,
	): void {
		// Scan to the end of this member. A top-level `{` before `;` means a
		// function body (or brace initialiser), and a top-level `(` means the
		// declaration is a method rather than data.
		const start = this.position
		let sawParen = false
		let end = -1
		let endKind: 'semicolon' | 'block' | 'close' = 'semicolon'
		let parenDepth = 0
		let bracketDepth = 0
		let braceDepth = 0

		for (let scan = this.position; scan < this.tokens.length; scan += 1) {
			const token = this.tokens[scan]
			if (token === undefined || token.kind === 'eof') break
			const value = token.value
			if (value === '(') {
				if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0)
					sawParen = true
				parenDepth += 1
			} else if (value === ')') {
				parenDepth -= 1
			} else if (value === '[') {
				bracketDepth += 1
			} else if (value === ']') {
				bracketDepth -= 1
			} else if (value === '{') {
				if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
					end = scan
					endKind = sawParen ? 'block' : 'block'
					break
				}
				braceDepth += 1
			} else if (value === '}') {
				if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
					end = scan
					endKind = 'close'
					break
				}
				braceDepth -= 1
			} else if (
				value === ';' &&
				parenDepth === 0 &&
				bracketDepth === 0 &&
				braceDepth === 0
			) {
				end = scan
				endKind = 'semicolon'
				break
			}
		}

		if (end === -1) {
			this.skipStatement()
			return
		}

		if (endKind === 'close') {
			this.position = end
			return
		}

		if (endKind === 'block') {
			if (sawParen) {
				// Method or function definition. Skip the parameter list and body.
				this.position = end
				this.skipBalanced('{', '}')
				if (this.peek()?.value === ';') this.consume()
				return
			}
			// Brace initialiser on a data member. Include it in the declaration and
			// let parseDeclarators ignore the initialiser.
			const declarationTokens = this.tokens.slice(start, end)
			this.position = end
			this.skipBalanced('{', '}')
			if (this.peek()?.value === ';') {
				const terminator = this.peek()
				this.consume()
				const fields = parseDeclarators(
					declarationTokens,
					description,
					terminator?.line,
				)
				decl.fields.push(...fields)
			}
			return
		}

		const declarationTokens = this.tokens.slice(start, end)
		const semicolon = this.peek()
		this.position = end + 1
		if (sawParen) return
		const fields = parseDeclarators(
			declarationTokens,
			description,
			semicolon?.line,
		)
		decl.fields.push(...fields)
	}

	private parseQualifiedName(): string {
		const parts: string[] = []
		const first = this.peek()
		if (!isIdentifier(first)) return ''
		parts.push(first.value)
		this.consume()
		while (true) {
			if (this.peek()?.value === '<') {
				this.skipAngles()
			}
			if (this.peek()?.value !== '::') break
			this.consume()
			const part = this.peek()
			if (!isIdentifier(part)) break
			parts.push(part.value)
			this.consume()
		}
		return parts.join('::')
	}

	private skipAttributes(): void {
		while (this.peek()?.value === '[' && this.peek(1)?.value === '[') {
			this.skipBalanced('[', ']', true)
		}
		if (
			this.peek()?.value === 'alignas' ||
			this.peek()?.value === '__attribute__'
		) {
			this.consume()
			if (this.peek()?.value === '(') this.skipBalanced('(', ')')
		}
	}

	private skipTemplateHeader(): void {
		this.consume() // template
		if (this.peek()?.value === '<') this.skipAngles()
	}

	private skipAngles(): void {
		let depth = 0
		while (!this.atEnd()) {
			const token = this.peek()
			if (token === undefined) return
			if (token.value === '<') {
				depth += 1
				this.consume()
			} else if (token.value === '>') {
				depth -= 1
				this.consume()
				if (depth <= 0) return
			} else if (token.value === '>>') {
				depth -= 2
				this.consume()
				if (depth <= 0) return
			} else {
				this.consume()
			}
		}
	}

	private collectUntil(predicate: (token: CppToken) => boolean): CppToken[] {
		const result: CppToken[] = []
		let paren = 0
		let bracket = 0
		let brace = 0
		let angle = 0
		while (!this.atEnd()) {
			const token = this.peek()
			if (token === undefined) break
			if (
				paren === 0 &&
				bracket === 0 &&
				brace === 0 &&
				angle === 0 &&
				predicate(token)
			)
				break
			if (token.value === '(') paren += 1
			else if (token.value === ')') paren -= 1
			else if (token.value === '[') bracket += 1
			else if (token.value === ']') bracket -= 1
			else if (token.value === '{') brace += 1
			else if (token.value === '}') {
				if (brace === 0) break
				brace -= 1
			} else if (token.value === '<') angle += 1
			else if (token.value === '>') angle = Math.max(0, angle - 1)
			else if (token.value === '>>') angle = Math.max(0, angle - 2)
			result.push(token)
			this.consume()
		}
		return result
	}

	private collectUntilSemicolon(): CppToken[] {
		return this.collectUntil((token) => token.value === ';')
	}

	private skipStatement(): void {
		let paren = 0
		let bracket = 0
		while (!this.atEnd()) {
			const token = this.peek()
			if (token === undefined) return
			const value = token.value
			if (value === '(') paren += 1
			else if (value === ')') paren -= 1
			else if (value === '[') bracket += 1
			else if (value === ']') bracket -= 1
			else if (value === '{' && paren === 0 && bracket === 0) {
				this.skipBalanced('{', '}')
				if (this.peek()?.value === ';') this.consume()
				return
			} else if (value === ';' && paren === 0 && bracket === 0) {
				this.consume()
				return
			} else if (value === '}' && paren === 0 && bracket === 0) {
				return
			}
			this.consume()
		}
	}

	private skipBalanced(open: string, close: string, doubleOpen = false): void {
		const first = this.peek()
		if (first?.value !== open) return
		let depth = 0
		while (!this.atEnd()) {
			const token = this.peek()
			if (token === undefined) return
			if (token.value === open) {
				depth += 1
				this.consume()
				if (doubleOpen) {
					if (this.peek()?.value === open) {
						depth += 1
						this.consume()
					}
				}
				continue
			}
			if (token.value === close) {
				depth -= 1
				this.consume()
				if (doubleOpen) {
					if (this.peek()?.value === close) {
						depth -= 1
						this.consume()
					}
				}
				if (depth <= 0) return
				continue
			}
			this.consume()
		}
	}

	/** Skip tokens through the closing `)` of an already-opened argument list. */
	private skipToClosingParen(): void {
		let depth = 1
		while (!this.atEnd()) {
			const token = this.consume()
			if (token === undefined) return
			if (token.value === '(') depth += 1
			else if (token.value === ')') {
				depth -= 1
				if (depth === 0) return
			}
		}
	}

	private eat(value: string): boolean {
		if (this.peek()?.value === value) {
			this.consume()
			return true
		}
		return false
	}

	private parseTypeFromTokens(tokens: CppToken[]): CppTypeRef {
		const cursor = new TokenCursor(tokens)
		return parseType(cursor, tokens)
	}
}

/** Find the index of the `}` matching the `{` at `openIndex`. */
function matchingBrace(tokens: readonly CppToken[], openIndex: number): number {
	let depth = 0
	for (let index = openIndex; index < tokens.length; index += 1) {
		const value = tokens[index]?.value
		if (value === '{') depth += 1
		else if (value === '}') {
			depth -= 1
			if (depth === 0) return index
		}
	}
	return -1
}

/** Parse a numeric literal with C++ digit separators and integer suffixes. */
export function parseIntegerLiteral(raw: string): number {
	const clean = raw.replace(/'/g, '').replace(/[uUlLzZ]+$/g, '')
	if (/^0[xX]/.test(clean)) return Number.parseInt(clean.slice(2), 16)
	if (/^0[bB]/.test(clean)) return Number.parseInt(clean.slice(2), 2)
	if (/^0[0-7]+$/.test(clean)) return Number.parseInt(clean.slice(1), 8)
	const value = Number(clean)
	if (!Number.isFinite(value)) {
		throw new Error(`Unsupported integer literal ${JSON.stringify(raw)}`)
	}
	return value
}

/**
 * Parse one or more declarators sharing a type specifier, as found inside a
 * struct body (`sint64 a, b;`, `id ids[4];`, `Array<T, N> values;`).
 */
function parseDeclarators(
	tokens: CppToken[],
	description?: string,
	line?: number,
): CppFieldDecl[] {
	if (tokens.length === 0) return []
	const cursor = new TokenCursor(tokens)

	let isStatic = false
	let isTypedef = false
	while (
		cursor.peek() !== undefined &&
		DECLARATION_QUALIFIERS.has(cursor.peek()?.value ?? '')
	) {
		const qualifier = cursor.next()?.value
		if (qualifier === 'static') isStatic = true
		if (qualifier === 'extern') {
			// `extern` data members still occupy storage in this subset.
		}
		if (qualifier === 'friend' || qualifier === 'virtual') return []
		if (qualifier === 'using') isTypedef = true
	}
	void isTypedef

	const baseType = parseType(cursor, tokens)
	const fields: CppFieldDecl[] = []

	while (!cursor.atEnd()) {
		// Pointer/reference declarator prefixes.
		let type = baseType
		while (true) {
			const token = cursor.peek()
			if (token?.value === '*') {
				cursor.next()
				type = {
					kind: 'pointer',
					name: '',
					qualifiers: [],
					templateArgs: [],
					of: type,
					raw: `*${type.raw ?? ''}`,
				}
			} else if (token?.value === '&') {
				cursor.next()
				type = {
					kind: 'reference',
					name: '',
					qualifiers: [],
					templateArgs: [],
					of: type,
				}
			} else if (token?.value === '&&') {
				cursor.next()
				type = {
					kind: 'reference',
					name: '',
					qualifiers: [],
					templateArgs: [],
					of: type,
				}
			} else {
				break
			}
		}

		const nameToken = cursor.peek()
		if (nameToken === undefined || nameToken.kind !== 'identifier') {
			// Constructor/destructor/operator or malformed declaration: stop.
			break
		}
		// A function declarator has a `(` before its `;`.
		if (nameToken.value === 'operator' || nameToken.value === '~') break
		cursor.next()
		const name = nameToken.value

		// Array bounds.
		while (cursor.peek()?.value === '[') {
			cursor.next()
			const boundTokens: CppToken[] = []
			let depth = 0
			while (!cursor.atEnd()) {
				const token = cursor.peek()
				if (token === undefined) break
				if (token.value === ']' && depth === 0) {
					cursor.next()
					break
				}
				if (token.value === '[') depth += 1
				else if (token.value === ']') depth -= 1
				boundTokens.push(token as CppToken)
				cursor.next()
			}
			type = {
				kind: 'array',
				name: '',
				qualifiers: [],
				templateArgs: [],
				of: type,
				length:
					boundTokens.length === 0 ? null : tokensToExpression(boundTokens),
			}
		}

		let bitWidth: string | undefined
		if (cursor.peek()?.value === ':') {
			cursor.next()
			const widthTokens: CppToken[] = []
			while (
				!cursor.atEnd() &&
				cursor.peek()?.value !== ',' &&
				cursor.peek()?.value !== '='
			) {
				widthTokens.push(cursor.next() as CppToken)
			}
			bitWidth = tokensToExpression(widthTokens)
		}

		// Skip initialisers, including brace initialisers and commas inside them.
		if (cursor.peek()?.value === '=' || cursor.peek()?.value === '{') {
			let depth = 0
			while (!cursor.atEnd()) {
				const token = cursor.peek()
				if (token === undefined) break
				if (token.value === '{' || token.value === '(' || token.value === '[')
					depth += 1
				else if (
					token.value === '}' ||
					token.value === ')' ||
					token.value === ']'
				)
					depth -= 1
				else if (token.value === ',' && depth === 0) break
				cursor.next()
			}
		}

		fields.push({
			name,
			type,
			...(bitWidth === undefined ? {} : { bitWidth }),
			...(isStatic ? { isStatic: true } : {}),
			line: nameToken.line,
			...(description === undefined ? {} : { description }),
		})

		// Handle constructor-style initialisers: `Type name(1);`
		if (cursor.peek()?.value === '(') break

		if (cursor.peek()?.value === ',') {
			cursor.next()
			// Pointer stars may follow the comma in `char *a, *b`.
			continue
		}
		break
	}

	void line
	return fields.filter((field) => !field.isStatic)
}

function parseType(
	cursor: TokenCursor,
	allTokens: readonly CppToken[],
): CppTypeRef {
	const start = cursor.position
	const qualifiers: string[] = []

	while (true) {
		const token = cursor.peek()
		if (token === undefined) break
		if (DECLARATION_QUALIFIERS.has(token.value)) {
			qualifiers.push(token.value)
			cursor.next()
			continue
		}
		break
	}

	// Elaborated type specifiers: `struct Foo`, `enum class Bar`.
	if (cursor.peek()?.value === 'enum' && cursor.peek(1)?.value === 'class') {
		cursor.next()
		cursor.next()
	} else if (TYPE_KEYWORDS.has(cursor.peek()?.value ?? '')) {
		cursor.next()
	}

	const parts: string[] = []
	let templateArgs: CppTemplateArgument[] = []
	const first = cursor.peek()

	if (first === undefined) {
		return { kind: 'unknown', name: '', qualifiers, templateArgs: [] }
	}

	if (
		first.kind === 'number' ||
		first.kind === 'string' ||
		first.kind === 'char'
	) {
		cursor.next()
		return {
			kind: 'unknown',
			name: tokensToExpression(allTokens.slice(start, cursor.position)),
			qualifiers,
			templateArgs: [],
		}
	}

	// Builtin multi-word types: unsigned long long, signed char, ...
	if (first.kind === 'identifier' && BUILTIN_WORDS.has(first.value)) {
		parts.push(cursor.next()?.value ?? '')
		while (
			cursor.peek()?.kind === 'identifier' &&
			BUILTIN_WORDS.has(cursor.peek()?.value ?? '')
		) {
			parts.push(cursor.next()?.value ?? '')
		}
		return {
			kind: 'named',
			name: parts.join(' '),
			qualifiers,
			templateArgs: [],
			raw: parts.join(' '),
		}
	}

	if (first.kind !== 'identifier') {
		cursor.next()
		return {
			kind: 'unknown',
			name: tokensToExpression(allTokens.slice(start, cursor.position)),
			qualifiers,
			templateArgs: [],
		}
	}

	// Qualified name, with optional template argument lists per component.
	while (true) {
		const token = cursor.peek()
		if (token === undefined || token.kind !== 'identifier') break
		parts.push(token.value)
		cursor.next()
		if (cursor.peek()?.value === '<') {
			templateArgs = parseTemplateArguments(cursor)
		}
		if (cursor.peek()?.value !== '::') break
		cursor.next()
	}

	const name = parts.join('::')
	let type: CppTypeRef = {
		kind: 'named',
		name,
		qualifiers,
		templateArgs,
		raw: name,
	}

	while (true) {
		const token = cursor.peek()
		if (token?.value === '*') {
			cursor.next()
			type = {
				kind: 'pointer',
				name: '',
				qualifiers: [],
				templateArgs: [],
				of: type,
				raw: `*${type.raw ?? ''}`,
			}
		} else if (token?.value === '&' || token?.value === '&&') {
			cursor.next()
			type = {
				kind: 'reference',
				name: '',
				qualifiers: [],
				templateArgs: [],
				of: type,
				raw: `&${type.raw ?? ''}`,
			}
		} else {
			break
		}
	}

	// Const/volatile after the base type applies to the type.
	while (
		cursor.peek()?.value === 'const' ||
		cursor.peek()?.value === 'volatile'
	) {
		const qualifier = cursor.next()?.value
		if (qualifier !== undefined && !type.qualifiers.includes(qualifier))
			type.qualifiers.push(qualifier)
	}

	return type
}

function parseTemplateArguments(cursor: TokenCursor): CppTemplateArgument[] {
	const args: CppTemplateArgument[] = []
	if (cursor.peek()?.value !== '<') return args
	cursor.next()

	while (true) {
		const argumentTokens: CppToken[] = []
		let paren = 0
		let bracket = 0
		let brace = 0
		let angle = 0

		while (true) {
			const token = cursor.peek()
			if (token === undefined) break
			const value = token.value
			if (
				paren === 0 &&
				bracket === 0 &&
				brace === 0 &&
				angle === 0 &&
				(value === ',' || value === '>')
			)
				break
			if (
				paren === 0 &&
				bracket === 0 &&
				brace === 0 &&
				angle === 0 &&
				value === '>>'
			)
				break
			if (value === '(') paren += 1
			else if (value === ')') paren -= 1
			else if (value === '[') bracket += 1
			else if (value === ']') bracket -= 1
			else if (value === '{') brace += 1
			else if (value === '}') brace -= 1
			else if (value === '<') angle += 1
			else if (value === '>') angle = Math.max(0, angle - 1)
			else if (value === '>>') angle = Math.max(0, angle - 2)
			argumentTokens.push(token as CppToken)
			cursor.next()
		}

		if (argumentTokens.length > 0) {
			args.push(classifyTemplateArgument(argumentTokens))
		}

		const delimiter = cursor.peek()?.value
		if (delimiter === ',') {
			cursor.next()
			continue
		}
		if (delimiter === '>') {
			cursor.next()
			break
		}
		if (delimiter === '>>') {
			// Split the token: consume the first `>` and leave one for the caller.
			const token = cursor.peek() as CppToken
			cursor.next()
			const rest = token as CppToken
			// Reinsert a synthetic single-angle token at the cursor position.
			const replacement: CppToken = { ...rest, value: '>' }
			;(cursor as unknown as { tokens: CppToken[] }).tokens.splice(
				cursor.position,
				0,
				replacement,
			)
			;(cursor as unknown as { index: number }).index = cursor.position
			break
		}
		break
	}

	return args
}

function classifyTemplateArgument(tokens: CppToken[]): CppTemplateArgument {
	const expression = tokensToExpression(tokens)
	const hasValueOperator = tokens.some((token) =>
		[
			'+',
			'-',
			'*',
			'/',
			'%',
			'<<',
			'>>',
			'|',
			'&',
			'^',
			'~',
			'!',
			'?',
			':',
			'(',
			')',
			'.',
			'->',
		].includes(token.value),
	)
	const first = tokens[0]
	const isLiteral =
		first?.kind === 'number' ||
		first?.kind === 'char' ||
		first?.kind === 'string'

	if (isLiteral || hasValueOperator) {
		return { kind: 'value', expression }
	}

	const cursor = new TokenCursor(tokens)
	const type = parseType(cursor, tokens)
	if (cursor.atEnd() && (type.kind !== 'unknown' || type.name.length > 0)) {
		return { kind: 'ambiguous', type, expression }
	}
	return { kind: 'value', expression }
}
