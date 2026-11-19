/**
 * Preprocessor-lite, tokenizer, and parser for the restricted QPI C++ subset
 * used by Qubic contract headers.
 *
 * Assumptions / scope
 * -------------------
 * - Contract headers are intentionally simple: structs, enums, typedefs,
 *   constexpr integers, `using` aliases, PUBLIC_/PRIVATE_ call declarations,
 *   and REGISTER_USER_* blocks. Function bodies are opaque and skipped.
 * - Preprocessing is deliberately shallow. `#if 0` branches are dropped,
 *   `#ifdef`/`#ifndef` keep the first branch (contract headers only guard
 *   optional code), object-like macros are captured, and includes are
 *   recorded. No macro expansion is performed on ordinary declarations.
 * - Names with `::` are preserved. Relative names are resolved later by
 *   `qualifyTypeName`/`LayoutRegistry`; the parser does not guess scopes.
 * - Line numbers are 1-based and come from the original text. Preprocessing
 *   blanks skipped lines instead of deleting them, so positions stay valid.
 * - Array lengths and enum values may depend on constants. They are stored as
 *   raw expressions and evaluated by a dedicated pass that handles integer
 *   literals, arithmetic, `static_cast`, and `Enum::Value` lookups.
 */

import {
	type ContractDefEntry,
	type CppCallDecl,
	type CppConstant,
	type CppEnum,
	type CppEnumValue,
	type CppField,
	type CppMacroDefinition,
	type CppMacroInvocation,
	CppModelError,
	type CppRegistration,
	type CppStruct,
	type CppTemplateArg,
	type CppTypedef,
	type CppTypeRef,
	type ParsedContractDef,
	type ParsedCppFile,
} from './model.js'

/* -------------------------------------------------------------------------- */
/* Preprocessor-lite                                                          */
/* -------------------------------------------------------------------------- */

export interface PreprocessResult {
	/** Source with inactive branches and directives blanked out (line count kept). */
	text: string
	includes: string[]
	macros: CppMacroDefinition[]
}

interface CondFrame {
	parentActive: boolean
	active: boolean
	taken: boolean
	sawElse: boolean
}

const DIRECTIVE_RE = /^\s*#\s*([A-Za-z_]\w*)(.*)$/

/**
 * Minimal preprocessor.
 *
 * - Drops `#if 0` branches (and anything nested in an inactive branch).
 * - Keeps the first branch of `#ifdef` / `#ifndef`, matching the main-branch
 *   tolerance required by contract headers.
 * - Records `#include` and `#define`.
 * - Blanks directives and skipped lines, preserving line numbers.
 */
export function preprocess(text: string): PreprocessResult {
	const lines = text.split(/\r?\n/)
	const out: string[] = new Array(lines.length).fill('')
	const includes: string[] = []
	const macros: CppMacroDefinition[] = []
	const stack: CondFrame[] = []
	const macroValues = new Map<string, string>()

	const isActive = () => stack.every((f) => f.active)

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? ''
		const match = DIRECTIVE_RE.exec(line)
		if (!match) {
			if (isActive()) out[i] = line
			continue
		}

		const directive = match[1] ?? ''
		const rest = (match[2] ?? '').trim()
		const parent = stack.length > 0 ? (stack.at(-1) ?? null) : null
		const parentActive = parent ? parent.active : true

		switch (directive) {
			case 'if': {
				const active = parentActive && evaluateCondition(rest, macroValues)
				stack.push({ parentActive, active, taken: active, sawElse: false })
				break
			}
			case 'ifdef': {
				// Contract headers use #ifdef only for optional test code. Treat
				// them as enabled and parse the first branch.
				const active = parentActive
				stack.push({ parentActive, active, taken: active, sawElse: false })
				break
			}
			case 'ifndef': {
				// Header guards and similar: parse the guarded content.
				const active = parentActive
				stack.push({ parentActive, active, taken: active, sawElse: false })
				break
			}
			case 'elif': {
				const frame = stack[stack.length - 1]
				if (frame) {
					if (frame.sawElse) {
						frame.active = false
					} else if (
						!frame.taken &&
						frame.parentActive &&
						evaluateCondition(rest, macroValues)
					) {
						frame.active = true
						frame.taken = true
					} else {
						frame.active = false
					}
				}
				break
			}
			case 'else': {
				const frame = stack[stack.length - 1]
				if (frame) {
					frame.sawElse = true
					frame.active = frame.parentActive && !frame.taken
					if (frame.active) frame.taken = true
				}
				break
			}
			case 'endif': {
				stack.pop()
				break
			}
			case 'define': {
				if (!isActive()) break
				let value = rest
				// Consume backslash continuations, blanking the joined lines.
				while (value.endsWith('\\') && i + 1 < lines.length) {
					value = `${value.slice(0, -1)} ${(lines[i + 1] ?? '').trim()}`
					i++
					out[i] = ''
				}
				const parsed = parseDefine(value, i + 1)
				if (parsed) {
					macros.push(parsed)
					if (!parsed.parameters) macroValues.set(parsed.name, parsed.value)
				}
				break
			}
			case 'undef': {
				if (isActive()) macroValues.delete(rest)
				break
			}
			case 'include': {
				if (!isActive()) break
				const m = /^["<]([^">]+)[">]/.exec(rest)
				if (m?.[1]) includes.push(m[1])
				break
			}
			default:
				// #pragma, #error, #line, ... are irrelevant to declarations.
				break
		}
		// Directive lines are blanked (their effects are captured above).
		out[i] = ''
	}

	// Restore lines that were joined via backslash continuations.
	return { text: out.join('\n'), includes, macros }
}

function evaluateCondition(
	expr: string,
	macros: ReadonlyMap<string, string>,
): boolean {
	const trimmed = expr.trim()
	if (trimmed === '' || trimmed === '0' || trimmed.toLowerCase() === 'false')
		return false
	if (trimmed === '1' || trimmed.toLowerCase() === 'true') return true
	const defined = /^defined\s*\(?\s*([A-Za-z_]\w*)\s*\)?$/.exec(trimmed)
	if (defined) return macros.has(defined[1] ?? '')
	// Fall back to evaluating a plain integer expression; unknown identifiers
	// are treated as defined (contracts only use #if for small toggles).
	const numeric = new Map<string, number>()
	for (const [name, raw] of macros) {
		const parsed = Number(raw)
		numeric.set(name, raw === '' ? 1 : Number.isFinite(parsed) ? parsed : 1)
	}
	const value = evaluateIntegerExpression(trimmed, numeric)
	return value === null ? true : value !== 0
}

function parseDefine(raw: string, line: number): CppMacroDefinition | null {
	const m = /^([A-Za-z_]\w*)(\(([^)]*)\))?(?:\s+(.*))?$/s.exec(raw.trim())
	if (!m) return null
	const name = m[1] ?? ''
	const parameters = m[3]
		? m[3]
				.split(',')
				.map((p) => p.trim())
				.filter(Boolean)
		: undefined
	const value = (m[4] ?? '').trim()
	return { name, value, parameters, line }
}

/* -------------------------------------------------------------------------- */
/* Tokenizer                                                                  */
/* -------------------------------------------------------------------------- */

export type CppTokenKind =
	| 'ident'
	| 'number'
	| 'string'
	| 'char'
	| 'punct'
	| 'doc'
	| 'eof'

export interface CppToken {
	kind: CppTokenKind
	value: string
	/** 1-based line. */
	line: number
	/** 1-based column. */
	column: number
}

const MULTI_PUNCT = [
	'<<=',
	'>>=',
	'->*',
	'::',
	'<<',
	'>>',
	'<=',
	'>=',
	'==',
	'!=',
	'&&',
	'||',
	'++',
	'--',
	'+=',
	'-=',
	'*=',
	'/=',
	'%=',
	'&=',
	'|=',
	'^=',
	'...',
	'##',
]

/**
 * Tokenize source text. Comments become `doc` tokens only when they are
 * `/** ... *\/` or `///`; all other comments are discarded.
 */
export function tokenize(text: string): CppToken[] {
	const tokens: CppToken[] = []
	let i = 0
	let line = 1
	let column = 1

	while (i < text.length) {
		const ch = text.charAt(i)
		const next = text[i + 1]

		if (ch === '\n') {
			line++
			column = 1
			i++
			continue
		}
		if (ch === ' ' || ch === '\t' || ch === '\r') {
			i++
			column++
			continue
		}

		if (ch === '/' && next === '/') {
			const start = i
			const startLine = line
			const startColumn = column
			while (i < text.length && text[i] !== '\n') i++
			const comment = text.slice(start, i).trimEnd()
			if (comment.startsWith('///') || comment.startsWith('//!')) {
				const body = comment.replace(/^\/\/[/!]\s?/, '').trim()
				if (body)
					tokens.push({
						kind: 'doc',
						value: body,
						line: startLine,
						column: startColumn,
					})
			}
			column = startColumn + (i - start)
			continue
		}

		if (ch === '/' && next === '*') {
			const start = i
			const startLine = line
			const startColumn = column
			const isDoc = text[i + 2] === '*' && text[i + 3] !== '/'
			i += 2
			while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
				if (text[i] === '\n') {
					line++
					column = 1
				} else {
					column++
				}
				i++
			}
			if (i < text.length) i += 2
			if (isDoc) {
				const value = cleanBlockDoc(text.slice(start, i))
				if (value)
					tokens.push({
						kind: 'doc',
						value,
						line: startLine,
						column: startColumn,
					})
			}
			column = startColumn
			continue
		}

		if (isIdentStart(ch)) {
			const start = i
			const startColumn = column
			while (i < text.length && isIdentPart(text.charAt(i))) i++
			column += i - start
			tokens.push({
				kind: 'ident',
				value: text.slice(start, i),
				line,
				column: startColumn,
			})
			continue
		}

		if (isDigit(ch) || (ch === '.' && isDigit(next))) {
			const start = i
			const startColumn = column
			while (i < text.length && /[0-9A-Za-z_'.]/.test(text.charAt(i))) i++
			column += i - start
			tokens.push({
				kind: 'number',
				value: text.slice(start, i),
				line,
				column: startColumn,
			})
			continue
		}

		if (ch === '"' || ch === "'") {
			const quote = ch
			const start = i
			const startColumn = column
			i++
			while (i < text.length && text[i] !== quote) {
				if (text[i] === '\\') i++
				if (text[i] === '\n') {
					line++
					column = 1
				}
				i++
			}
			if (i < text.length) i++
			column += i - start
			tokens.push({
				kind: quote === '"' ? 'string' : 'char',
				value: text.slice(start, i),
				line,
				column: startColumn,
			})
			continue
		}

		let punct = ch
		for (const candidate of MULTI_PUNCT) {
			if (text.startsWith(candidate, i)) {
				punct = candidate
				break
			}
		}
		tokens.push({ kind: 'punct', value: punct, line, column })
		i += punct.length
		column += punct.length
	}

	tokens.push({ kind: 'eof', value: '', line, column })
	return tokens
}

function cleanBlockDoc(raw: string): string {
	// raw includes the /** ... */ delimiters.
	let body = raw.replace(/^\/\*\*?/, '').replace(/\*\/$/, '')
	body = body
		.split('\n')
		.map((l) => l.replace(/^\s*\*?\s?/, '').trimEnd())
		.join('\n')
		.trim()
	return body
}

function isIdentStart(ch: string): boolean {
	return /[A-Za-z_]/.test(ch)
}
function isIdentPart(ch: string): boolean {
	return /[A-Za-z0-9_]/.test(ch)
}
function isDigit(ch: string | undefined): boolean {
	return ch !== undefined && /[0-9]/.test(ch)
}

/* -------------------------------------------------------------------------- */
/* Integer expression evaluation                                              */
/* -------------------------------------------------------------------------- */

/** Constant lookup used by {@link evaluateIntegerExpression}. */
export type IntegerConstants =
	| ReadonlyMap<string, number>
	| ReadonlyMap<string, bigint>
	| Readonly<Record<string, number | bigint>>

interface ExprToken {
	kind: 'number' | 'ident' | 'punct'
	value: string
}

class ExprParser {
	private index = 0

	constructor(
		private readonly tokens: ExprToken[],
		private readonly constants: IntegerConstants,
	) {}

	parse(): bigint {
		const value = this.parseOr()
		if (this.index !== this.tokens.length) {
			throw new Error(
				`Unexpected token "${this.peek()?.value ?? '<eof>'}" in expression`,
			)
		}
		return value
	}

	private peek(): ExprToken | undefined {
		return this.tokens[this.index]
	}
	private next(): ExprToken | undefined {
		return this.tokens[this.index++]
	}
	private at(value: string): boolean {
		return this.peek()?.value === value
	}

	private parseOr(): bigint {
		let left = this.parseAnd()
		while (this.at('||')) {
			this.next()
			const right = this.parseAnd()
			left = left !== 0n || right !== 0n ? 1n : 0n
		}
		return left
	}
	private parseAnd(): bigint {
		let left = this.parseBitOr()
		while (this.at('&&')) {
			this.next()
			const right = this.parseBitOr()
			left = left !== 0n && right !== 0n ? 1n : 0n
		}
		return left
	}
	private parseBitOr(): bigint {
		let left = this.parseBitXor()
		while (this.at('|')) {
			this.next()
			left |= this.parseBitXor()
		}
		return left
	}
	private parseBitXor(): bigint {
		let left = this.parseBitAnd()
		while (this.at('^')) {
			this.next()
			left ^= this.parseBitAnd()
		}
		return left
	}
	private parseBitAnd(): bigint {
		let left = this.parseShift()
		while (this.at('&')) {
			this.next()
			left &= this.parseShift()
		}
		return left
	}
	private parseShift(): bigint {
		let left = this.parseAdd()
		while (this.at('<<') || this.at('>>')) {
			const token = this.next()
			if (token === undefined) throw new Error('Unexpected end of expression')
			const op = token.value
			const right = this.parseAdd()
			left = op === '<<' ? left << right : left >> right
		}
		return left
	}
	private parseAdd(): bigint {
		let left = this.parseMul()
		while (this.at('+') || this.at('-')) {
			const token = this.next()
			if (token === undefined) throw new Error('Unexpected end of expression')
			const op = token.value
			const right = this.parseMul()
			left = op === '+' ? left + right : left - right
		}
		return left
	}
	private parseMul(): bigint {
		let left = this.parseUnary()
		while (this.at('*') || this.at('/') || this.at('%')) {
			const token = this.next()
			if (token === undefined) throw new Error('Unexpected end of expression')
			const op = token.value
			const right = this.parseUnary()
			if (op === '*') left *= right
			else if (op === '/') {
				if (right === 0n) throw new Error('Division by zero')
				left /= right
			} else {
				if (right === 0n) throw new Error('Division by zero')
				left %= right
			}
		}
		return left
	}
	private parseUnary(): bigint {
		if (this.at('+')) {
			this.next()
			return this.parseUnary()
		}
		if (this.at('-')) {
			this.next()
			return -this.parseUnary()
		}
		if (this.at('~')) {
			this.next()
			return ~this.parseUnary()
		}
		if (this.at('!')) {
			this.next()
			return this.parseUnary() === 0n ? 1n : 0n
		}
		return this.parsePrimary()
	}
	private parsePrimary(): bigint {
		const token = this.next()
		if (!token) throw new Error('Unexpected end of expression')
		if (token.value === '(') {
			const value = this.parseOr()
			if (!this.at(')')) throw new Error('Missing )')
			this.next()
			return value
		}
		if (token.kind === 'number') return parseIntegerLiteral(token.value)
		if (token.kind === 'ident') {
			if (token.value === 'true') return 1n
			if (token.value === 'false') return 0n
			if (token.value === 'static_cast' || token.value === 'reinterpret_cast') {
				return this.parseCast()
			}
			if (token.value === 'sizeof') {
				throw new Error('sizeof is not supported in integer expressions')
			}
			let name = token.value
			while (this.at('::')) {
				this.next()
				const part = this.next()
				if (part?.kind !== 'ident') throw new Error('Malformed qualified name')
				name += `::${part.value}`
			}
			return this.lookup(name)
		}
		throw new Error(`Unexpected token "${token.value}"`)
	}
	private parseCast(): bigint {
		// static_cast<type>(expr) -> evaluate expr
		if (!this.at('<')) throw new Error('Expected < after static_cast')
		this.next()
		let depth = 1
		while (depth > 0) {
			const token = this.next()
			if (!token) throw new Error('Unterminated static_cast type')
			if (token.value === '<') depth++
			else if (token.value === '>') depth--
			else if (token.value === '>>') depth -= 2
		}
		if (!this.at('(')) throw new Error('Expected ( after static_cast<...>')
		this.next()
		const value = this.parseOr()
		if (!this.at(')')) throw new Error('Missing ) after static_cast')
		this.next()
		return value
	}
	private lookup(name: string): bigint {
		const direct = lookupConstant(this.constants, name)
		if (direct !== undefined) return direct
		if (name.includes('::')) {
			const last = name.slice(name.lastIndexOf('::') + 2)
			const fallback = lookupConstant(this.constants, last)
			if (fallback !== undefined) return fallback
		}
		throw new Error(`Unknown constant "${name}"`)
	}
}

function lookupConstant(
	constants: IntegerConstants,
	name: string,
): bigint | undefined {
	if (constants instanceof Map) {
		const value = constants.get(name)
		if (typeof value === 'number') return BigInt(Math.trunc(value))
		if (typeof value === 'bigint') return value
		return undefined
	}
	const value = (constants as Record<string, number | bigint>)[name]
	if (typeof value === 'number') return BigInt(Math.trunc(value))
	if (typeof value === 'bigint') return value
	return undefined
}

function tokenizeExpression(expr: string): ExprToken[] {
	const tokens: ExprToken[] = []
	let i = 0
	const multi = ['<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '::']
	while (i < expr.length) {
		const ch = expr.charAt(i)
		if (/\s/.test(ch)) {
			i++
			continue
		}
		if (isIdentStart(ch)) {
			const start = i
			while (i < expr.length && isIdentPart(expr.charAt(i))) i++
			tokens.push({ kind: 'ident', value: expr.slice(start, i) })
			continue
		}
		if (isDigit(ch)) {
			const start = i
			while (i < expr.length && /[0-9A-Za-z_'.]/.test(expr.charAt(i))) i++
			tokens.push({ kind: 'number', value: expr.slice(start, i) })
			continue
		}
		const op = multi.find((m) => expr.startsWith(m, i))
		if (op) {
			tokens.push({ kind: 'punct', value: op })
			i += op.length
			continue
		}
		tokens.push({ kind: 'punct', value: ch })
		i++
	}
	return tokens
}

function parseIntegerLiteral(raw: string): bigint {
	const cleaned = raw.replace(/'/g, '').replace(/[uUlL]+$/, '')
	if (/^0[xX][0-9a-fA-F]+$/.test(cleaned)) return BigInt(cleaned)
	if (/^0[bB][01]+$/.test(cleaned)) return BigInt(cleaned)
	if (/^0[0-7]+$/.test(cleaned) && cleaned.length > 1)
		return BigInt(`0o${cleaned.slice(1)}`)
	if (/^[0-9]+$/.test(cleaned)) return BigInt(cleaned)
	// Fall back to Number for forms such as 1e3 (not used by QPI contracts).
	const value = Number(cleaned)
	if (!Number.isFinite(value))
		throw new Error(`Unsupported integer literal "${raw}"`)
	return BigInt(Math.trunc(value))
}

/**
 * Evaluate an integer constant expression.
 *
 * Supports literals (decimal/hex/binary, `'` separators, U/L suffixes),
 * arithmetic and bitwise operators, parentheses, `static_cast<T>(x)`, and
 * identifier lookup (`NAME`, `Enum::VALUE`, `A::B::C`). Returns `null` when the
 * expression references an unknown constant or is not an integer expression.
 *
 * Values outside the JS safe-integer range are also reported as `null` so
 * callers never silently lose precision; the raw expression is always kept in
 * the parsed model.
 */
export function evaluateIntegerExpression(
	expr: string,
	constants: IntegerConstants,
): number | null {
	try {
		const value = new ExprParser(tokenizeExpression(expr), constants).parse()
		if (
			value > BigInt(Number.MAX_SAFE_INTEGER) ||
			value < BigInt(Number.MIN_SAFE_INTEGER)
		) {
			return null
		}
		return Number(value)
	} catch {
		return null
	}
}

/* -------------------------------------------------------------------------- */
/* Token cursor                                                               */
/* -------------------------------------------------------------------------- */

class TokenCursor {
	private index = 0
	private docs: string[] = []

	constructor(readonly tokens: CppToken[]) {}

	get position(): number {
		return this.index
	}
	set position(value: number) {
		this.index = value
	}

	peek(offset = 0): CppToken {
		const token =
			this.tokens[Math.min(this.index + offset, this.tokens.length - 1)]
		if (token === undefined) throw new CppModelError('Unexpected end of input')
		return token
	}
	next(): CppToken {
		const token = this.peek()
		if (this.index < this.tokens.length - 1) this.index++
		return token
	}
	at(value: string): boolean {
		return this.peek().value === value
	}
	atKind(kind: CppTokenKind): boolean {
		return this.peek().kind === kind
	}
	atEnd(): boolean {
		return this.peek().kind === 'eof'
	}
	expect(value: string, path: string): CppToken {
		const token = this.peek()
		if (token.value !== value) {
			throw new CppModelError(
				`Expected "${value}", found "${token.value || '<eof>'}"`,
				{
					path,
					line: token.line,
				},
			)
		}
		return this.next()
	}

	/** Move past doc tokens and return the accumulated doc text, if any. */
	takeDoc(): string | undefined {
		while (this.peek().kind === 'doc') {
			this.docs.push(this.next().value)
		}
		if (this.docs.length === 0) return undefined
		const value = this.docs.join('\n\n').trim()
		this.docs = []
		return value || undefined
	}

	/** Skip a balanced pair of delimiters starting at the current token. */
	skipBalanced(open: string, close: string): void {
		if (!this.at(open)) return
		let depth = 0
		while (!this.atEnd()) {
			const token = this.next()
			if (token.value === open) depth++
			else if (token.value === close) {
				depth--
				if (depth === 0) return
			}
		}
	}

	/** Skip the remainder of a group whose opening delimiter was consumed. */
	skipClosing(open: string, close: string): void {
		let depth = 1
		while (!this.atEnd()) {
			const token = this.next()
			if (token.value === open) depth++
			else if (token.value === close) {
				depth--
				if (depth === 0) return
			}
		}
	}

	/** Skip to the next top-level `;`, consuming it. Also stops at `}`. */
	skipToSemicolon(): void {
		const depth = 0
		while (!this.atEnd()) {
			const token = this.peek()
			if (token.value === '{' || token.value === '(' || token.value === '[') {
				this.skipBalanced(
					token.value,
					token.value === '{' ? '}' : token.value === '(' ? ')' : ']',
				)
				continue
			}
			if (token.value === '}' && depth === 0) return
			this.next()
			if (token.value === ';') return
		}
	}

	/** Skip a function body / initializer brace block if present, then optional `;`. */
	skipBody(): void {
		if (this.at('{')) this.skipBalanced('{', '}')
		if (this.at(';')) this.next()
	}
}

/* -------------------------------------------------------------------------- */
/* Parser                                                                     */
/* -------------------------------------------------------------------------- */

interface ParseContext {
	path: string
	structs: CppStruct[]
	enums: CppEnum[]
	constants: CppConstant[]
	typedefs: CppTypedef[]
	macros: CppMacroDefinition[]
	includes: string[]
	calls: CppCallDecl[]
	registrations: CppRegistration[]
	macroInvocations: CppMacroInvocation[]
	contractClasses: CppStruct[]
	knownTypes: Set<string>
	anonymousCounter: number
}

const BUILTIN_WORDS = new Set([
	'void',
	'bool',
	'char',
	'signed',
	'unsigned',
	'short',
	'long',
	'int',
	'float',
	'double',
	'wchar_t',
])

const CONTAINER_TYPES = new Set([
	'Array',
	'BitArray',
	'SlowAnySizeArray',
	'Collection',
	'HashMap',
	'Vector',
	'LinkedList',
	'Pool',
	'QPI',
	'QPI::Array',
	'QPI::BitArray',
])

const EXTERNAL_TYPE_NAMES = new Set([
	'Asset',
	'DateAndTime',
	'NoData',
	'ProposalDataV1',
	'ProposalDataYesNo',
	'ProposalMultiVoteDataV1',
	'ProposalSingleVoteDataV1',
	'ProposalSummarizedVotingDataV1',
	'OracleNotificationInput',
	'oracleReply',
	'Entity',
	'id',
	'm256i',
	'uint128',
	'bit',
	'ContractBase',
	'QPI::Asset',
	'QPI::DateAndTime',
	'QPI::NoData',
	'QPI::ProposalDataV1',
	'QPI::ProposalMultiVoteDataV1',
	'QPI::ProposalSummarizedVotingDataV1',
	'QPI::OracleNotificationInput',
])

const CALL_MACROS: Record<
	string,
	{
		kind: 'procedure' | 'function'
		visibility: 'public' | 'private'
		hasLocals: boolean
	}
> = {
	PUBLIC_PROCEDURE: {
		kind: 'procedure',
		visibility: 'public',
		hasLocals: false,
	},
	PUBLIC_PROCEDURE_WITH_LOCALS: {
		kind: 'procedure',
		visibility: 'public',
		hasLocals: true,
	},
	PUBLIC_FUNCTION: { kind: 'function', visibility: 'public', hasLocals: false },
	PUBLIC_FUNCTION_WITH_LOCALS: {
		kind: 'function',
		visibility: 'public',
		hasLocals: true,
	},
	PRIVATE_PROCEDURE: {
		kind: 'procedure',
		visibility: 'private',
		hasLocals: false,
	},
	PRIVATE_PROCEDURE_WITH_LOCALS: {
		kind: 'procedure',
		visibility: 'private',
		hasLocals: true,
	},
	PRIVATE_FUNCTION: {
		kind: 'function',
		visibility: 'private',
		hasLocals: false,
	},
	PRIVATE_FUNCTION_WITH_LOCALS: {
		kind: 'function',
		visibility: 'private',
		hasLocals: true,
	},
}

const REGISTRATION_MACROS = new Set([
	'REGISTER_USER_FUNCTION',
	'REGISTER_USER_PROCEDURE',
	'REGISTER_USER_PROCEDURE_NOTIFICATION',
])

const SPECIFIERS = new Set([
	'const',
	'volatile',
	'static',
	'inline',
	'mutable',
	'extern',
	'register',
	'thread_local',
	'constexpr',
	'consteval',
	'typename',
	'friend',
	'virtual',
	'explicit',
])

const ACCESS_LABELS = new Set(['public', 'private', 'protected'])

/**
 * Parse one contract header into a typed model.
 *
 * This never throws for function bodies or unsupported member functions; those
 * are skipped. Throws `CppModelError` only for malformed declarations inside
 * the supported subset (unterminated braces, bad struct syntax, ...).
 */
export function parseCppFile(text: string, path = '<input>'): ParsedCppFile {
	const pre = preprocess(text)
	const tokens = tokenize(pre.text)
	const cursor = new TokenCursor(tokens)

	const ctx: ParseContext = {
		path,
		structs: [],
		enums: [],
		constants: pre.macros.map((macro) => ({
			name: macro.name,
			qualifiedName: macro.name,
			scope: '',
			expression: macro.value,
			value: null,
			type: null,
			source: 'define',
			line: macro.line,
		})),
		typedefs: [],
		macros: pre.macros,
		includes: pre.includes,
		calls: [],
		registrations: [],
		macroInvocations: [],
		contractClasses: [],
		knownTypes: new Set([
			...BUILTIN_WORDS,
			...CONTAINER_TYPES,
			...EXTERNAL_TYPE_NAMES,
			'uint8',
			'sint8',
			'uint16',
			'sint16',
			'uint32',
			'sint32',
			'uint64',
			'sint64',
			'uint128',
			'id',
			'bit',
			'bool',
		]),
		anonymousCounter: 0,
	}

	parseScope(cursor, ctx, '', null, 'file')

	resolveConstants(ctx)
	resolveEnumValues(ctx)
	resolveRegistrations(ctx)
	expandShareholderVoting(ctx)

	return {
		path,
		structs: ctx.structs,
		enums: ctx.enums,
		constants: ctx.constants,
		typedefs: ctx.typedefs,
		macros: ctx.macros,
		includes: ctx.includes,
		calls: ctx.calls,
		registrations: ctx.registrations,
		macroInvocations: ctx.macroInvocations,
		contractClasses: ctx.contractClasses,
	}
}

type ScopeKind = 'file' | 'namespace' | 'struct'

function parseScope(
	cursor: TokenCursor,
	ctx: ParseContext,
	scope: string,
	body: CppStruct | null,
	kind: ScopeKind,
): void {
	while (!cursor.atEnd()) {
		if (kind !== 'file' && cursor.at('}')) return

		const doc = cursor.takeDoc()
		if (cursor.atEnd()) break
		if (kind !== 'file' && cursor.at('}')) return

		const token = cursor.peek()
		const value = token.value

		if (value === ';') {
			cursor.next()
			continue
		}
		if (ACCESS_LABELS.has(value) && cursor.peek(1).value === ':') {
			cursor.next()
			cursor.next()
			continue
		}
		if (value === 'template') {
			const parameters = parseTemplateParameters(cursor, ctx.path)
			parseDeclaration(cursor, ctx, scope, body, kind, doc, parameters)
			continue
		}
		parseDeclaration(cursor, ctx, scope, body, kind, doc, [])
	}
}

function parseDeclaration(
	cursor: TokenCursor,
	ctx: ParseContext,
	scope: string,
	body: CppStruct | null,
	kind: ScopeKind,
	doc: string | undefined,
	templateParameters: string[],
): void {
	const token = cursor.peek()
	const value = token.value

	if (value === '}') {
		// Recovery: unterminated declaration at the end of a scope.
		if (kind !== 'file') return
		cursor.next()
		return
	}

	if (value === 'namespace') {
		cursor.next()
		const name = parseQualifiedName(cursor)
		cursor.expect('{', ctx.path)
		const nested = joinScope(scope, name)
		parseScope(cursor, ctx, nested, null, 'namespace')
		cursor.expect('}', ctx.path)
		if (cursor.at(';')) cursor.next()
		return
	}

	if (value === 'using') {
		parseUsing(cursor, ctx, scope, doc)
		return
	}

	if (value === 'typedef') {
		parseTypedef(cursor, ctx, scope, doc)
		return
	}

	if (value === 'enum') {
		parseEnum(cursor, ctx, scope, body, doc)
		return
	}

	if (value === 'struct' || value === 'class' || value === 'union') {
		parseStruct(cursor, ctx, scope, body, kind, doc, templateParameters)
		return
	}

	if (
		value === 'static_assert' ||
		value === 'ASSERT' ||
		value === 'static_assertion'
	) {
		cursor.next()
		if (cursor.at('(')) cursor.skipBalanced('(', ')')
		if (cursor.at(';')) cursor.next()
		return
	}

	if (value === 'REGISTER_USER_FUNCTIONS_AND_PROCEDURES') {
		parseRegistrationBlock(cursor, ctx)
		return
	}

	if (CALL_MACROS[value]) {
		parseCallMacro(cursor, ctx, scope, doc)
		return
	}

	if (value === 'static' || value === 'constexpr' || value === 'inline') {
		parseSpecifiedDeclaration(cursor, ctx, scope, body, doc)
		return
	}

	if (value === 'operator' || value === '~') {
		skipFunctionLike(cursor)
		return
	}

	if (token.kind === 'ident' && cursor.peek(1).value === '(') {
		// Macro invocation or function declaration/definition at scope level.
		// Known macros with a body are skipped; anything else falls through to
		// field/function parsing where the function detector handles it.
		if (/^[A-Z_][A-Z0-9_]*$/.test(value)) {
			const invocation = parseMacroInvocation(cursor, ctx)
			if (invocation && cursor.at('{')) cursor.skipBalanced('{', '}')
			else if (invocation && cursor.at(';')) cursor.next()
			return
		}
		skipFunctionLike(cursor)
		return
	}

	parseFieldOrFunction(cursor, ctx, body, doc)
}

function parseSpecifiedDeclaration(
	cursor: TokenCursor,
	ctx: ParseContext,
	scope: string,
	body: CppStruct | null,
	doc: string | undefined,
): void {
	const start = cursor.position
	// Consume specifiers.
	while (SPECIFIERS.has(cursor.peek().value)) cursor.next()

	if (cursor.at('struct') || cursor.at('class') || cursor.at('union')) {
		parseStruct(cursor, ctx, scope, body, body ? 'struct' : 'file', doc, [])
		return
	}
	if (cursor.at('enum')) {
		parseEnum(cursor, ctx, scope, body, doc)
		return
	}

	// `static constexpr uint64 X = ...;`
	const type = parseTypeSpecifier(cursor, ctx)
	if (!type) {
		cursor.position = start
		skipDeclaration(cursor)
		return
	}
	const nameToken = cursor.peek()
	if (nameToken.kind !== 'ident') {
		cursor.position = start
		skipDeclaration(cursor)
		return
	}
	cursor.next()
	const name = nameToken.value

	if (cursor.at('=')) {
		cursor.next()
		const expression = collectUntil(cursor, [';', '}']).text
		ctx.constants.push({
			name,
			qualifiedName: joinScope(scope, name),
			scope,
			expression,
			value: null,
			type: type.name,
			source: 'constexpr',
			description: doc,
			line: nameToken.line,
		})
		if (cursor.at(';')) cursor.next()
		return
	}

	if (cursor.at('(')) {
		skipFunctionLike(cursor, true)
		return
	}

	// Not a constant; ignore static/global variables.
	skipDeclaration(cursor)
}

function parseFieldOrFunction(
	cursor: TokenCursor,
	ctx: ParseContext,
	body: CppStruct | null,
	doc: string | undefined,
): void {
	const start = cursor.position
	const type = parseTypeSpecifier(cursor, ctx)
	if (!type) {
		cursor.position = start
		skipDeclaration(cursor)
		return
	}

	// Trailing const on `const T`.
	if (cursor.at('const') || cursor.at('volatile')) cursor.next()

	const nameToken = cursor.peek()
	if (nameToken.kind !== 'ident') {
		cursor.position = start
		skipDeclaration(cursor)
		return
	}
	cursor.next()

	if (nameToken.value === 'operator') {
		// Operator overloads (`bool operator==(...)`) start with a return type,
		// so the scope-level operator check does not see them. Rewind and skip
		// the whole function instead of recording an `operator` field.
		cursor.position = start
		skipFunctionLike(cursor)
		return
	}

	if (cursor.at('(')) {
		// Function/method declaration or definition.
		skipFunctionLike(cursor, true)
		return
	}

	if (type.isPointer) {
		// Pointers are not part of the QPI ABI; skip the declaration.
		skipDeclaration(cursor)
		return
	}

	const fields: CppField[] = []
	parseDeclarators(cursor, type, nameToken, fields, doc)
	consumeDeclarationEnd(cursor)

	if (body) body.fields.push(...fields)
	// File/namespace-scope variables are ignored.
}

function parseDeclarators(
	cursor: TokenCursor,
	baseType: CppTypeRef,
	first: CppToken,
	fields: CppField[],
	doc: string | undefined,
): void {
	let nameToken = first
	let type = baseType
	for (;;) {
		const arrayLengths: string[] = []
		while (cursor.at('[')) {
			cursor.next()
			const length = collectUntil(cursor, [']']).text.trim()
			arrayLengths.push(length)
			cursor.expect(']', '')
			if (cursor.at('[')) continue
		}

		let initializer: string | undefined
		if (cursor.at('=')) {
			cursor.next()
			initializer = collectUntil(cursor, [',', ';', '}']).text.trim()
		}

		fields.push({
			name: nameToken.value,
			type: arrayLengths.length > 0 ? { ...type, arrayLengths } : type,
			line: nameToken.line,
			description: doc,
			initializer,
		})

		if (cursor.at(',')) {
			cursor.next()
			if (cursor.peek().kind !== 'ident') return
			nameToken = cursor.next()
			// Reuse the same base type; pointers were rejected earlier.
			type = baseType
			continue
		}
		return
	}
}

function consumeDeclarationEnd(cursor: TokenCursor): void {
	if (cursor.at(';')) {
		cursor.next()
	} else {
		skipDeclaration(cursor)
	}
}

function skipDeclaration(cursor: TokenCursor): void {
	// Skip to `;` or `}`; braces may belong to an inline body.
	const depth = 0
	while (!cursor.atEnd()) {
		const token = cursor.peek()
		if (token.value === '{') {
			if (depth === 0) {
				cursor.skipBalanced('{', '}')
				if (cursor.at(';')) cursor.next()
				return
			}
		}
		if (token.value === '(' || token.value === '[') {
			cursor.skipBalanced(token.value, token.value === '(' ? ')' : ']')
			continue
		}
		if (token.value === '}') return
		cursor.next()
		if (token.value === ';') return
	}
}

/** Skip a function declaration/definition including its body. */
function skipFunctionLike(
	cursor: TokenCursor,
	parenthesesAlreadyConsumed = false,
): void {
	if (!parenthesesAlreadyConsumed) {
		while (!cursor.atEnd() && !cursor.at('(')) cursor.next()
		if (cursor.at('(')) cursor.skipBalanced('(', ')')
	}
	// Trailing specifiers / return type / constructor initializers.
	while (
		!cursor.atEnd() &&
		!cursor.at('{') &&
		!cursor.at(';') &&
		!cursor.at('}') &&
		cursor.peek().value !== '='
	) {
		if (cursor.at('(')) {
			cursor.skipBalanced('(', ')')
			continue
		}
		cursor.next()
	}
	if (cursor.at('{')) {
		cursor.skipBalanced('{', '}')
	} else if (cursor.at('=')) {
		cursor.skipToSemicolon()
		return
	}
	if (cursor.at(';')) cursor.next()
}

function parseUsing(
	cursor: TokenCursor,
	ctx: ParseContext,
	scope: string,
	doc: string | undefined,
): void {
	const startToken = cursor.next() // using
	if (cursor.at('namespace')) {
		cursor.skipToSemicolon()
		return
	}
	const nameToken = cursor.peek()
	if (nameToken.kind !== 'ident') {
		cursor.skipToSemicolon()
		return
	}
	cursor.next()
	// Skip attributes such as [[deprecated]].
	while (cursor.at('[') && cursor.peek(1).value === '[') {
		cursor.next()
		cursor.skipBalanced('[', ']')
	}
	if (!cursor.at('=')) {
		cursor.skipToSemicolon()
		return
	}
	cursor.next()
	const type = parseTypeSpecifier(cursor, ctx)
	const target = type ?? { name: collectUntil(cursor, [';']).text.trim() }
	cursor.skipToSemicolon()

	ctx.typedefs.push({
		name: nameToken.value,
		qualifiedName: joinScope(scope, nameToken.value),
		scope,
		target,
		description: doc,
		line: startToken.line,
		kind: 'using',
	})
	addKnownType(ctx, nameToken.value, joinScope(scope, nameToken.value))
}

function parseTypedef(
	cursor: TokenCursor,
	ctx: ParseContext,
	scope: string,
	doc: string | undefined,
): void {
	const startToken = cursor.next() // typedef
	const type = parseTypeSpecifier(cursor, ctx)
	if (!type) {
		cursor.skipToSemicolon()
		return
	}
	// Function pointer typedefs are not supported.
	if (cursor.at('(')) {
		cursor.skipToSemicolon()
		return
	}
	while (cursor.peek().kind === 'ident') {
		const nameToken = cursor.next()
		const lengths: string[] = []
		while (cursor.at('[')) {
			cursor.next()
			lengths.push(collectUntil(cursor, [']']).text.trim())
			cursor.expect(']', ctx.path)
		}
		ctx.typedefs.push({
			name: nameToken.value,
			qualifiedName: joinScope(scope, nameToken.value),
			scope,
			target: lengths.length > 0 ? { ...type, arrayLengths: lengths } : type,
			description: doc,
			line: startToken.line,
			kind: 'typedef',
		})
		addKnownType(ctx, nameToken.value, joinScope(scope, nameToken.value))
		if (!cursor.at(',')) break
		cursor.next()
	}
	cursor.skipToSemicolon()
}

function parseEnum(
	cursor: TokenCursor,
	ctx: ParseContext,
	scope: string,
	_body: CppStruct | null,
	doc: string | undefined,
): void {
	const enumToken = cursor.next() // enum
	let isScoped = false
	if (cursor.at('class') || cursor.at('struct')) {
		isScoped = true
		cursor.next()
	}

	const nameToken = cursor.peek()
	let name: string
	let qualifiedName: string
	if (nameToken.kind === 'ident') {
		cursor.next()
		name = nameToken.value
		qualifiedName = joinScope(scope, name)
	} else {
		name = `__anonymous_enum_${++ctx.anonymousCounter}`
		qualifiedName = joinScope(scope, name)
	}

	let underlyingType: string | null = null
	if (cursor.at(':')) {
		cursor.next()
		const type = parseTypeSpecifier(cursor, ctx)
		underlyingType = type?.name ?? null
	}

	const values: CppEnumValue[] = []
	if (cursor.at('{')) {
		cursor.next()
		let implicit = 0n
		while (!cursor.atEnd() && !cursor.at('}')) {
			cursor.takeDoc()
			const valueDoc = cursor.takeDoc()
			if (cursor.at('}')) break
			if (cursor.at(',')) {
				cursor.next()
				continue
			}
			const valueToken = cursor.peek()
			if (valueToken.kind !== 'ident') {
				cursor.next()
				continue
			}
			cursor.next()
			let expression: string | undefined
			if (cursor.at('=')) {
				cursor.next()
				expression = collectUntil(cursor, [',', '}']).text.trim()
			}
			const entry: CppEnumValue = {
				name: valueToken.value,
				value: expression ? null : Number(implicit),
				expression,
				description: valueDoc,
			}
			values.push(entry)
			implicit = expression ? implicit + 1n : implicit + 1n
			if (cursor.at(',')) cursor.next()
		}
		cursor.expect('}', ctx.path)
	}

	const enumDef: CppEnum = {
		name,
		qualifiedName,
		scope,
		underlyingType,
		isScoped,
		values,
		description: doc,
		line: enumToken.line,
	}
	ctx.enums.push(enumDef)
	addKnownType(ctx, name, qualifiedName)

	// Enum members become constants for expression evaluation. Their values
	// are resolved in a later pass (see resolveEnumValues).
	for (const value of values) {
		ctx.constants.push({
			name: value.name,
			qualifiedName: `${qualifiedName}::${value.name}`,
			scope: qualifiedName,
			expression: value.expression ?? '',
			value: value.value,
			type: underlyingType ?? 'sint32',
			source: 'enum',
			description: value.description,
			line: enumToken.line,
		})
	}

	if (cursor.at(';')) cursor.next()
}

function parseStruct(
	cursor: TokenCursor,
	ctx: ParseContext,
	scope: string,
	parent: CppStruct | null,
	kind: ScopeKind,
	doc: string | undefined,
	templateParameters: string[],
): void {
	const keyword = cursor.next().value as 'struct' | 'class' | 'union'
	const startLine = cursor.peek().line

	let name: string
	const nameToken = cursor.peek()
	if (nameToken.kind === 'ident') {
		cursor.next()
		name = nameToken.value
	} else {
		name = `__anonymous_${keyword}_${++ctx.anonymousCounter}`
	}

	// Forward declaration: `struct X;`
	if (cursor.at(';')) {
		cursor.next()
		return
	}

	const bases: string[] = []
	if (cursor.at(':')) {
		cursor.next()
		while (!cursor.atEnd() && !cursor.at('{')) {
			if (
				cursor.peek().kind === 'ident' &&
				!ACCESS_LABELS.has(cursor.peek().value)
			) {
				const baseName = parseQualifiedName(cursor)
				if (
					baseName &&
					baseName !== 'public' &&
					baseName !== 'private' &&
					baseName !== 'protected'
				) {
					bases.push(baseName)
				}
			} else {
				cursor.next()
			}
		}
	}

	if (!cursor.at('{')) {
		// Declaration with a variable declarator (e.g. `struct X {...} var;`).
		cursor.skipToSemicolon()
		return
	}

	const qualifiedName = joinScope(scope, name)
	const structDef: CppStruct = {
		name,
		qualifiedName,
		scope,
		kind: keyword,
		bases,
		fields: [],
		nestedStructs: [],
		nestedEnums: [],
		description: doc,
		line: startLine,
		isTemplate: templateParameters.length > 0,
		templateParameters,
	}

	ctx.structs.push(structDef)
	addKnownType(ctx, name, qualifiedName)
	if (parent) parent.nestedStructs.push(structDef)
	if (kind === 'file' && bases.includes('ContractBase')) {
		ctx.contractClasses.push(structDef)
	}

	const nested = joinScope(scope, name)
	cursor.expect('{', ctx.path)
	parseScope(cursor, ctx, nested, structDef, 'struct')
	cursor.expect('}', ctx.path)

	// Enums declared inside this struct need to be attached to it.
	for (const enumDef of ctx.enums) {
		if (enumDef.scope === nested) structDef.nestedEnums.push(enumDef)
	}

	// Optional declarator after the closing brace (`} name;`).
	if (cursor.at(';')) {
		cursor.next()
		return
	}
	if (cursor.peek().kind === 'ident') {
		skipDeclaration(cursor)
	}
}

function parseCallMacro(
	cursor: TokenCursor,
	ctx: ParseContext,
	scope: string,
	doc: string | undefined,
): void {
	const macroToken = cursor.next()
	const macro = CALL_MACROS[macroToken.value]
	if (macro === undefined) {
		throw new CppModelError(`Unknown call macro ${macroToken.value}`)
	}
	cursor.expect('(', ctx.path)
	const nameToken = cursor.peek()
	if (nameToken.kind !== 'ident') {
		cursor.skipClosing('(', ')')
		return
	}
	cursor.next()
	cursor.skipClosing('(', ')')

	const name = nameToken.value
	const base = joinScope(scope, name)
	ctx.calls.push({
		name,
		kind: macro.kind,
		visibility: macro.visibility,
		hasLocals: macro.hasLocals,
		inputStructRef: `${base}_input`,
		outputStructRef: `${base}_output`,
		localsStructRef: `${base}_locals`,
		scope,
		description: doc,
		line: macroToken.line,
	})

	if (cursor.at('{')) cursor.skipBalanced('{', '}')
	if (cursor.at(';')) cursor.next()
}

function parseRegistrationBlock(cursor: TokenCursor, ctx: ParseContext): void {
	cursor.next() // macro name
	cursor.expect('(', ctx.path)
	cursor.skipClosing('(', ')')
	if (!cursor.at('{')) {
		if (cursor.at(';')) cursor.next()
		return
	}
	cursor.expect('{', ctx.path)
	while (!cursor.atEnd() && !cursor.at('}')) {
		cursor.takeDoc()
		const token = cursor.peek()
		if (token.kind !== 'ident') {
			cursor.next()
			continue
		}
		if (REGISTRATION_MACROS.has(token.value)) {
			const line = token.line
			cursor.next()
			if (!cursor.at('(')) continue
			cursor.next()
			const argTokens = collectArguments(cursor)
			const args = argTokens.map((arg) => arg.text)
			const macro = token.value
			const name = (argTokens[0]?.tokens[0]?.value ?? '').trim()
			if (!name) continue
			ctx.registrations.push({
				kind:
					macro === 'REGISTER_USER_FUNCTION'
						? 'function'
						: macro === 'REGISTER_USER_PROCEDURE'
							? 'procedure'
							: 'notification',
				name,
				inputTypeExpression:
					macro === 'REGISTER_USER_PROCEDURE_NOTIFICATION'
						? undefined
						: args[1],
				inputType: null,
				line,
			})
			continue
		}
		if (token.value === 'REGISTER_SHAREHOLDER_PROPOSAL_VOTING') {
			const line = token.line
			cursor.next()
			if (cursor.at('(')) cursor.skipBalanced('(', ')')
			ctx.macroInvocations.push({ name: token.value, args: [], line })
			addShareholderVotingRegistrations(ctx, line)
			continue
		}
		if (/^REGISTER_[A-Za-z0-9_]+$/.test(token.value)) {
			const invocation = parseMacroInvocation(cursor, ctx)
			if (invocation) {
				const expanded = expandRegisterMacro(invocation.name)
				if (expanded) {
					ctx.registrations.push({ ...expanded, line: invocation.line })
				}
			}
			continue
		}
		// Unknown statement inside the registration block: skip one token.
		cursor.next()
	}
	cursor.expect('}', ctx.path)
	if (cursor.at(';')) cursor.next()
}

function parseMacroInvocation(
	cursor: TokenCursor,
	ctx: ParseContext,
): CppMacroInvocation | null {
	const token = cursor.peek()
	if (token.kind !== 'ident') return null
	cursor.next()
	const invocation: CppMacroInvocation = {
		name: token.value,
		args: [],
		line: token.line,
	}
	if (cursor.at('(')) {
		cursor.next()
		invocation.args = collectArguments(cursor).map((arg) => arg.text)
	}
	ctx.macroInvocations.push(invocation)
	return invocation
}

/** Expand the small REGISTER_* helper macros from qpi_macros.h. */
function expandRegisterMacro(
	name: string,
): Omit<CppRegistration, 'line'> | null {
	switch (name) {
		case 'REGISTER_GetShareholderProposalFees':
			return shareholderRegistration(
				'function',
				'GetShareholderProposalFees',
				65531,
			)
		case 'REGISTER_GetShareholderProposalIndices':
			return shareholderRegistration(
				'function',
				'GetShareholderProposalIndices',
				65532,
			)
		case 'REGISTER_GetShareholderProposal':
			return shareholderRegistration(
				'function',
				'GetShareholderProposal',
				65533,
			)
		case 'REGISTER_GetShareholderVotes':
			return shareholderRegistration('function', 'GetShareholderVotes', 65534)
		case 'REGISTER_GetShareholderVotingResults':
			return shareholderRegistration(
				'function',
				'GetShareholderVotingResults',
				65535,
			)
		case 'REGISTER_SetShareholderProposal':
			return shareholderRegistration(
				'procedure',
				'SetShareholderProposal',
				65534,
			)
		case 'REGISTER_SetShareholderVotes':
			return shareholderRegistration('procedure', 'SetShareholderVotes', 65535)
		default:
			return null
	}
}

function shareholderRegistration(
	kind: CppRegistration['kind'],
	name: string,
	inputType: number,
): Omit<CppRegistration, 'line'> {
	return {
		kind,
		name,
		inputTypeExpression: String(inputType),
		inputType,
	}
}

function addShareholderVotingRegistrations(
	ctx: ParseContext,
	line: number,
): void {
	const registrations: Array<[CppRegistration['kind'], string, number]> = [
		['function', 'GetShareholderProposalFees', 65531],
		['function', 'GetShareholderProposalIndices', 65532],
		['function', 'GetShareholderProposal', 65533],
		['function', 'GetShareholderVotes', 65534],
		['function', 'GetShareholderVotingResults', 65535],
		['procedure', 'SetShareholderProposal', 65534],
		['procedure', 'SetShareholderVotes', 65535],
	]
	for (const [kind, name, inputType] of registrations) {
		ctx.registrations.push({
			...shareholderRegistration(kind, name, inputType),
			line,
		})
	}
}

/**
 * Synthesize the calls, input/output typedefs generated by
 * `IMPLEMENT_DEFAULT_SHAREHOLDER_PROPOSAL_VOTING(...)`.
 *
 * The macro is defined in `qpi/qpi_macros.h`; contract headers only contain the
 * invocation, so without expansion the generator would miss seven user calls.
 * The generated structs are registered as typedefs to external QPI types,
 * which the layout registry resolves with extern stubs.
 */
function expandShareholderVoting(ctx: ParseContext): void {
	const invocations = ctx.macroInvocations.filter(
		(m) => m.name === 'IMPLEMENT_DEFAULT_SHAREHOLDER_PROPOSAL_VOTING',
	)
	if (invocations.length === 0) return

	const line = invocations[0]?.line
	if (line === undefined) return
	const scope = ctx.contractClasses[0]?.qualifiedName ?? ''
	const calls: Array<{
		name: string
		kind: 'procedure' | 'function'
		input: CppTypeRef
		output: CppTypeRef
	}> = [
		{
			name: 'SetShareholderProposal',
			kind: 'procedure',
			input: { name: 'QPI::ProposalDataV1' },
			output: { name: 'uint16' },
		},
		{
			name: 'GetShareholderProposal',
			kind: 'function',
			input: { name: 'struct', templateArgs: undefined },
			output: { name: 'struct' },
		},
		{
			name: 'GetShareholderProposalIndices',
			kind: 'function',
			input: { name: 'struct' },
			output: { name: 'struct' },
		},
		{
			name: 'GetShareholderProposalFees',
			kind: 'function',
			input: { name: 'QPI::NoData' },
			output: { name: 'struct' },
		},
		{
			name: 'SetShareholderVotes',
			kind: 'procedure',
			input: { name: 'QPI::ProposalMultiVoteDataV1' },
			output: { name: 'bit' },
		},
		{
			name: 'GetShareholderVotes',
			kind: 'function',
			input: { name: 'struct' },
			output: { name: 'QPI::ProposalMultiVoteDataV1' },
		},
		{
			name: 'GetShareholderVotingResults',
			kind: 'function',
			input: { name: 'struct' },
			output: { name: 'QPI::ProposalSummarizedVotingDataV1' },
		},
	]

	// Inline structs generated by the macro (only the small ones; the large
	// proposal payloads stay as typedefs to QPI types).
	const syntheticStructs: Record<string, CppField[]> = {
		GetShareholderProposal_input: [
			{ name: 'proposalIndex', type: { name: 'uint16' }, line },
		],
		GetShareholderProposal_output: [
			{ name: 'proposal', type: { name: 'QPI::ProposalDataV1' }, line },
			{ name: 'proposerPubicKey', type: { name: 'id' }, line },
		],
		GetShareholderProposalIndices_input: [
			{ name: 'activeProposals', type: { name: 'bit' }, line },
			{ name: 'prevProposalIndex', type: { name: 'sint32' }, line },
		],
		GetShareholderProposalIndices_output: [
			{ name: 'numOfIndices', type: { name: 'uint16' }, line },
			{
				name: 'indices',
				type: {
					name: 'Array',
					templateArgs: [
						{ kind: 'type', type: { name: 'uint16' } },
						{ kind: 'value', expression: '64' },
					],
				},
				line,
			},
		],
		GetShareholderProposalFees_output: [
			{ name: 'setProposalFee', type: { name: 'sint64' }, line },
			{ name: 'setVoteFee', type: { name: 'sint64' }, line },
		],
		GetShareholderVotes_input: [
			{ name: 'voter', type: { name: 'id' }, line },
			{ name: 'proposalIndex', type: { name: 'uint16' }, line },
		],
		GetShareholderVotingResults_input: [
			{ name: 'proposalIndex', type: { name: 'uint16' }, line },
		],
	}

	for (const [suffix, fields] of Object.entries(syntheticStructs)) {
		const qualifiedName = joinScope(scope, suffix)
		if (ctx.structs.some((s) => s.qualifiedName === qualifiedName)) continue
		const structDef: CppStruct = {
			name: suffix,
			qualifiedName,
			scope,
			kind: 'struct',
			bases: [],
			fields,
			nestedStructs: [],
			nestedEnums: [],
			line,
			isTemplate: false,
			templateParameters: [],
		}
		ctx.structs.push(structDef)
		addKnownType(ctx, suffix, qualifiedName)
	}

	const typedefs: Array<[string, CppTypeRef]> = [
		['SetShareholderProposal_input', { name: 'QPI::ProposalDataV1' }],
		['SetShareholderProposal_output', { name: 'uint16' }],
		['GetShareholderProposalFees_input', { name: 'QPI::NoData' }],
		['SetShareholderVotes_input', { name: 'QPI::ProposalMultiVoteDataV1' }],
		['SetShareholderVotes_output', { name: 'bit' }],
		['GetShareholderVotes_output', { name: 'QPI::ProposalMultiVoteDataV1' }],
		[
			'GetShareholderVotingResults_output',
			{ name: 'QPI::ProposalSummarizedVotingDataV1' },
		],
	]

	for (const [name, target] of typedefs) {
		const qualifiedName = joinScope(scope, name)
		if (ctx.typedefs.some((t) => t.qualifiedName === qualifiedName)) continue
		ctx.typedefs.push({
			name,
			qualifiedName,
			scope,
			target,
			line,
			kind: 'typedef',
		})
		addKnownType(ctx, name, qualifiedName)
	}

	// Replace placeholder outputs that are inline structs with typedefs where
	// the macro uses a raw struct.
	for (const call of calls) {
		const qualifiedName = joinScope(scope, `${call.name}_input`)
		const existing = ctx.structs.find((s) => s.qualifiedName === qualifiedName)
		if (existing) call.input = { name: qualifiedName }
		const outQualified = joinScope(scope, `${call.name}_output`)
		const existingOut = ctx.structs.find(
			(s) => s.qualifiedName === outQualified,
		)
		if (existingOut) call.output = { name: outQualified }

		const inputTypedef = ctx.typedefs.find(
			(t) => t.qualifiedName === qualifiedName,
		)
		if (inputTypedef) call.input = { name: inputTypedef.qualifiedName }
		const outputTypedef = ctx.typedefs.find(
			(t) => t.qualifiedName === outQualified,
		)
		if (outputTypedef) call.output = { name: outputTypedef.qualifiedName }
	}
	// The public calls themselves are synthesized from the macro; actual
	// input/output references are the same naming convention used elsewhere.
	for (const call of calls) {
		if (ctx.calls.some((c) => c.scope === scope && c.name === call.name))
			continue
		ctx.calls.push({
			name: call.name,
			kind: call.kind,
			visibility: 'public',
			hasLocals:
				call.kind === 'procedure' && call.name === 'SetShareholderProposal',
			inputStructRef: joinScope(scope, `${call.name}_input`),
			outputStructRef: joinScope(scope, `${call.name}_output`),
			localsStructRef: joinScope(scope, `${call.name}_locals`),
			scope,
			line,
		})
	}
}

/* -------------------------------------------------------------------------- */
/* Type parsing                                                               */
/* -------------------------------------------------------------------------- */

const BUILTIN_CANONICAL = new Map<string, string>([
	['bool', 'bool'],
	['char', 'sint8'],
	['signed char', 'sint8'],
	['unsigned char', 'uint8'],
	['short', 'sint16'],
	['short int', 'sint16'],
	['signed short', 'sint16'],
	['signed short int', 'sint16'],
	['unsigned short', 'uint16'],
	['unsigned short int', 'uint16'],
	['int', 'sint32'],
	['signed', 'sint32'],
	['signed int', 'sint32'],
	['unsigned', 'uint32'],
	['unsigned int', 'uint32'],
	['long', 'sint64'],
	['long int', 'sint64'],
	['signed long', 'sint64'],
	['signed long int', 'sint64'],
	['unsigned long', 'uint64'],
	['unsigned long int', 'uint64'],
	['long long', 'sint64'],
	['long long int', 'sint64'],
	['signed long long', 'sint64'],
	['signed long long int', 'sint64'],
	['unsigned long long', 'uint64'],
	['unsigned long long int', 'uint64'],
])

function canonicalBuiltin(words: string[]): string | null {
	return BUILTIN_CANONICAL.get(words.join(' ')) ?? null
}

/**
 * Parse a type specifier (not a declarator).
 * Returns `null` for types outside the supported subset.
 */
function parseTypeSpecifier(
	cursor: TokenCursor,
	ctx: ParseContext,
): CppTypeRef | null {
	// Leading qualifiers and elaborated-type keywords.
	while (
		SPECIFIERS.has(cursor.peek().value) ||
		cursor.peek().value === 'struct' ||
		cursor.peek().value === 'class' ||
		cursor.peek().value === 'enum'
	) {
		cursor.next()
	}

	const start = cursor.position

	// Builtin word sequence.
	if (BUILTIN_WORDS.has(cursor.peek().value)) {
		const words: string[] = []
		while (BUILTIN_WORDS.has(cursor.peek().value)) {
			words.push(cursor.next().value)
		}
		const canonical = canonicalBuiltin(words)
		if (!canonical) return null
		const type: CppTypeRef = { name: canonical }
		consumePointerSuffix(cursor, type)
		return type
	}

	const token = cursor.peek()
	if (token.kind !== 'ident') {
		cursor.position = start
		return null
	}

	// decltype / auto are not supported for ABI fields.
	if (token.value === 'decltype' || token.value === 'auto') {
		cursor.position = start
		return null
	}

	const name = parseQualifiedName(cursor)
	if (!name) {
		cursor.position = start
		return null
	}

	const type: CppTypeRef = { name }
	if (cursor.at('<')) {
		type.templateArgs = parseTemplateArguments(cursor, ctx)
	}
	consumePointerSuffix(cursor, type)
	return type
}

function consumePointerSuffix(cursor: TokenCursor, type: CppTypeRef): void {
	let pointer = false
	while (cursor.at('*') || cursor.at('&') || cursor.at('&&')) {
		pointer = true
		cursor.next()
		while (cursor.at('const') || cursor.at('volatile')) cursor.next()
	}
	if (pointer) type.isPointer = true
}

function parseQualifiedName(cursor: TokenCursor): string {
	let name = ''
	if (cursor.at('::')) cursor.next()
	const first = cursor.peek()
	if (first.kind !== 'ident') return ''
	name = cursor.next().value
	while (cursor.at('::')) {
		cursor.next()
		const part = cursor.peek()
		if (part.kind !== 'ident') break
		name += `::${cursor.next().value}`
	}
	return name
}

function parseTemplateArguments(
	cursor: TokenCursor,
	ctx: ParseContext,
): CppTemplateArg[] {
	cursor.expect('<', ctx.path)
	const args: CppTemplateArg[] = []

	for (;;) {
		const chunk: CppToken[] = []
		let depth = 0
		while (!cursor.atEnd()) {
			const token = cursor.peek()
			if (token.value === '<') {
				depth++
				chunk.push(cursor.next())
				continue
			}
			if (token.value === '>') {
				if (depth === 0) break
				depth--
				chunk.push(cursor.next())
				continue
			}
			if (token.value === '>>') {
				if (depth === 0) break
				if (depth === 1) {
					// Consume one level and leave a single '>' for the outer args.
					cursor.tokens[cursor.position] = { ...token, value: '>' }
					depth = 0
					continue
				}
				depth -= 2
				chunk.push(cursor.next())
				continue
			}
			if (depth === 0 && token.value === ',') break
			chunk.push(cursor.next())
		}

		if (chunk.length > 0) {
			const type = tryParseTypeChunk(chunk, ctx)
			if (type) args.push({ kind: 'type', type })
			else args.push({ kind: 'value', expression: tokensToText(chunk) })
		}

		if (cursor.at(',')) {
			cursor.next()
			continue
		}
		break
	}

	cursor.expect('>', ctx.path)
	return args
}

function tryParseTypeChunk(
	chunk: CppToken[],
	ctx: ParseContext,
): CppTypeRef | null {
	if (chunk.length === 0) return null
	const cursor = new TokenCursor([
		...chunk,
		{ kind: 'eof', value: '', line: 0, column: 0 },
	])
	const type = parseTypeSpecifier(cursor, ctx)
	if (!type || type.isPointer) return null
	if (!cursor.atEnd()) return null

	// Reject single unknown identifiers: they are almost always value
	// constants in template arguments (`Array<T, N>`).
	if (
		!type.templateArgs &&
		!type.name.includes('::') &&
		!isBuiltinScalarName(type.name) &&
		!ctx.knownTypes.has(type.name)
	) {
		return null
	}
	return type
}

function isBuiltinScalarName(name: string): boolean {
	return (
		BUILTIN_CANONICAL.has(name) ||
		[
			'uint8',
			'sint8',
			'uint16',
			'sint16',
			'uint32',
			'sint32',
			'uint64',
			'sint64',
			'uint128',
			'id',
			'bit',
			'bool',
		].includes(name)
	)
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function joinScope(scope: string, name: string): string {
	if (!name) return scope
	if (!scope) return name
	if (name.startsWith('::')) name = name.slice(2)
	if (name.startsWith(`${scope}::`)) return name
	return `${scope}::${name}`
}

function addKnownType(
	ctx: ParseContext,
	name: string,
	qualifiedName: string,
): void {
	ctx.knownTypes.add(name)
	ctx.knownTypes.add(qualifiedName)
}

interface CollectedArgument {
	text: string
	tokens: CppToken[]
}

/**
 * Collect comma-separated arguments up to (but not consuming) the closing `)`.
 * Tracks nested parens, braces, brackets, and angle brackets.
 */
function collectArguments(cursor: TokenCursor): CollectedArgument[] {
	const args: CollectedArgument[] = []
	let current: CppToken[] = []
	let parenthesis = 0
	let brace = 0
	let bracket = 0
	let angle = 0

	while (!cursor.atEnd()) {
		const token = cursor.peek()
		if (
			token.value === ')' &&
			parenthesis === 0 &&
			brace === 0 &&
			bracket === 0 &&
			angle === 0
		) {
			cursor.next()
			break
		}
		if (
			token.value === ',' &&
			parenthesis === 0 &&
			brace === 0 &&
			bracket === 0 &&
			angle === 0
		) {
			cursor.next()
			args.push({ text: tokensToText(current), tokens: current })
			current = []
			continue
		}
		if (token.value === '(') parenthesis++
		else if (token.value === ')') parenthesis--
		else if (token.value === '{') brace++
		else if (token.value === '}') brace--
		else if (token.value === '[') bracket++
		else if (token.value === ']') bracket--
		else if (token.value === '<') angle++
		else if (token.value === '>') angle = Math.max(0, angle - 1)
		else if (token.value === '>>') angle = Math.max(0, angle - 2)
		current.push(cursor.next())
	}

	if (current.length > 0)
		args.push({ text: tokensToText(current), tokens: current })
	return args
}

/** Collect tokens up to one of the stop values at nesting depth zero. */
function collectUntil(
	cursor: TokenCursor,
	stops: string[],
): { text: string; tokens: CppToken[] } {
	const tokens: CppToken[] = []
	let parenthesis = 0
	let brace = 0
	let bracket = 0
	while (!cursor.atEnd()) {
		const token = cursor.peek()
		if (
			parenthesis === 0 &&
			brace === 0 &&
			bracket === 0 &&
			stops.includes(token.value)
		) {
			break
		}
		if (token.value === '(') parenthesis++
		else if (token.value === ')') parenthesis--
		else if (token.value === '{') brace++
		else if (token.value === '}') brace--
		else if (token.value === '[') bracket++
		else if (token.value === ']') bracket--
		tokens.push(cursor.next())
	}
	return { text: tokensToText(tokens), tokens }
}

function tokensToText(tokens: CppToken[]): string {
	let out = ''
	let previous = ''
	const word = (value: string) => /[A-Za-z0-9_]/.test(value)
	for (const token of tokens) {
		const value = token.value
		if (out !== '') {
			const needsSpace =
				(word(previous) && word(value)) ||
				(previous === ',' && value !== ')') ||
				(previous === '>' && word(value)) ||
				value === '<<' ||
				value === '>>' ||
				previous === '<<' ||
				previous === '>>'
			if (needsSpace) out += ' '
		}
		if (value === '>>' && previous === '>') out += '>'
		out += value
		previous = value
	}
	return out
}

function parseTemplateParameters(cursor: TokenCursor, path: string): string[] {
	cursor.expect('template', path)
	cursor.expect('<', path)
	const parameters: string[] = []
	let current: CppToken[] = []
	let depth = 0
	while (!cursor.atEnd()) {
		const token = cursor.peek()
		if (token.value === '<') depth++
		else if (token.value === '>') {
			if (depth === 0) break
			depth--
		}
		if (token.value === ',' && depth === 0) {
			cursor.next()
			parameters.push(tokensToText(current).trim())
			current = []
			continue
		}
		current.push(cursor.next())
	}
	if (current.length > 0) parameters.push(tokensToText(current).trim())
	cursor.expect('>', path)
	return parameters
}

/* -------------------------------------------------------------------------- */
/* Constant / enum / registration resolution                                  */
/* -------------------------------------------------------------------------- */

function buildConstantMap(ctx: ParseContext): Map<string, number> {
	const map = new Map<string, number>()
	for (const constant of ctx.constants) {
		if (constant.value === null) continue
		map.set(constant.name, constant.value)
		map.set(constant.qualifiedName, constant.value)
	}
	return map
}

function resolveConstants(ctx: ParseContext): void {
	const map = buildConstantMap(ctx)
	let changed = true
	for (let pass = 0; pass < 20 && changed; pass++) {
		changed = false
		for (const constant of ctx.constants) {
			if (constant.value !== null || !constant.expression) continue
			const value = evaluateIntegerExpression(constant.expression, map)
			if (value !== null) {
				constant.value = value
				map.set(constant.name, value)
				map.set(constant.qualifiedName, value)
				changed = true
			}
		}
	}
}

function resolveEnumValues(ctx: ParseContext): void {
	// Rebuild the constant map with resolved constants, then resolve enums in
	// declaration order so implicit enumerators follow explicit ones.
	const map = buildConstantMap(ctx)
	for (const enumDef of ctx.enums) {
		let previous = -1
		for (const value of enumDef.values) {
			let resolved: number | null
			if (value.expression) {
				resolved = evaluateIntegerExpression(value.expression, map)
			} else {
				resolved = previous + 1
			}
			if (resolved === null) resolved = previous + 1
			value.value = resolved
			previous = resolved
			map.set(value.name, resolved)
			map.set(`${enumDef.qualifiedName}::${value.name}`, resolved)
		}
		// Keep the flat constants list in sync.
		for (const constant of ctx.constants) {
			if (constant.source !== 'enum') continue
			if (constant.scope !== enumDef.qualifiedName) continue
			const member = enumDef.values.find((v) => v.name === constant.name)
			if (member) constant.value = member.value
		}
	}
}

function resolveRegistrations(ctx: ParseContext): void {
	const map = buildConstantMap(ctx)
	for (const enumDef of ctx.enums) {
		for (const value of enumDef.values) {
			if (value.value === null) continue
			map.set(value.name, value.value)
			map.set(`${enumDef.qualifiedName}::${value.name}`, value.value)
		}
	}
	for (const registration of ctx.registrations) {
		if (registration.kind === 'notification') {
			registration.inputType = null
			continue
		}
		if (registration.inputType !== null) continue
		if (!registration.inputTypeExpression) continue
		registration.inputType = evaluateIntegerExpression(
			registration.inputTypeExpression,
			map,
		)
	}
}

/* -------------------------------------------------------------------------- */
/* contract_def.h                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Parse `src/contract_core/contract_def.h`.
 *
 * Contract blocks are `#define X_CONTRACT_INDEX N` followed by
 * `#define CONTRACT_STATE_TYPE Y` and `#include "contracts/File.h"`. Asset
 * metadata comes from the `contractDescriptions[]` initializer, matched by
 * index. Test contracts (`#ifdef INCLUDE_CONTRACT_TEST_EXAMPLES`) are excluded.
 */
export function parseContractDef(text: string): ParsedContractDef {
	const lines = text.split(/\r?\n/)
	const entries: ContractDefEntry[] = []
	let currentIndex: number | null = null
	let currentState: string | null = null
	let currentState2: string | null = null
	let currentLine = 0
	let inTestBlock = false

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? ''
		if (/^\s*#\s*ifdef\s+INCLUDE_CONTRACT_TEST_EXAMPLES\b/.test(line)) {
			inTestBlock = true
			break
		}

		const indexMatch =
			/^\s*#\s*define\s+([A-Za-z_]\w*)_CONTRACT_INDEX\s+(\d+)\b/.exec(line)
		if (indexMatch && indexMatch[1] !== 'CONTRACT') {
			currentIndex = Number(indexMatch[2])
			currentState = null
			currentState2 = null
			currentLine = i + 1
			continue
		}
		if (currentIndex === null) continue

		const stateMatch =
			/^\s*#\s*define\s+CONTRACT_STATE_TYPE\s+([A-Za-z_]\w*)/.exec(line)
		if (stateMatch) {
			currentState = stateMatch[1] ?? null
			continue
		}
		const state2Match =
			/^\s*#\s*define\s+CONTRACT_STATE2_TYPE\s+([A-Za-z_]\w*)/.exec(line)
		if (state2Match) {
			currentState2 = state2Match[1] ?? null
			continue
		}
		const includeMatch = /^\s*#\s*include\s+"([^"]+)"/.exec(line)
		if (includeMatch && currentState) {
			const includePath = includeMatch[1] ?? ''
			const fileName = includePath.slice(includePath.lastIndexOf('/') + 1)
			entries.push({
				index: currentIndex,
				stateType: currentState,
				state2Type: currentState2,
				fileName,
				includePath,
				assetName: null,
				constructionEpoch: null,
				destructionEpoch: null,
				stateSizeExpression: null,
				line: currentLine,
			})
			currentIndex = null
			currentState = null
			currentState2 = null
		}
	}

	if (inTestBlock) {
		// Nothing else to do: entries before the test block are the real ones.
	}

	// contractDescriptions: stop at the test-example branch as well.
	const descriptionStart = text.indexOf('contractDescriptions[]')
	if (descriptionStart >= 0) {
		const testIndex = text.indexOf(
			'#ifdef INCLUDE_CONTRACT_TEST_EXAMPLES',
			descriptionStart,
		)
		const endIndex = text.indexOf('};', descriptionStart)
		const sliceEnd =
			testIndex >= 0 && (endIndex < 0 || testIndex < endIndex)
				? testIndex
				: endIndex >= 0
					? endIndex
					: text.length
		const slice = text.slice(descriptionStart, sliceEnd)
		const entryRe =
			/\{\s*"([^"]*)"\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*sizeof\s*\(([^)]*)\)\s*\}/g
		let match: RegExpExecArray | null = entryRe.exec(slice)
		let descriptionIndex = 0
		while (match !== null) {
			const assetName = match[1] ?? ''
			const entry = entries.find((e) => e.index === descriptionIndex)
			if (entry) {
				entry.assetName = assetName || null
				entry.constructionEpoch = Number(match[2])
				entry.destructionEpoch = Number(match[3])
				entry.stateSizeExpression = (match[4] ?? '').trim()
			}
			descriptionIndex++
			match = entryRe.exec(slice)
		}
	}

	entries.sort((a, b) => a.index - b.index)
	const byIndex = new Map(entries.map((e) => [e.index, e]))
	const byStateType = new Map(entries.map((e) => [e.stateType, e]))
	return { entries, byIndex, byStateType }
}

/* -------------------------------------------------------------------------- */
/* Name qualification                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a relative type name against a scope, preferring inner scopes.
 *
 * `known` is either a set of fully qualified names or a predicate. When no
 * candidate matches, the original name is returned unchanged so the caller can
 * report a layout error with the source spelling.
 */
export function qualifyTypeName(
	name: string,
	scope: string,
	known: ReadonlySet<string> | ((candidate: string) => boolean),
): string {
	if (!name) return name
	if (name.startsWith('::')) return name.slice(2)
	const has =
		typeof known === 'function'
			? known
			: (candidate: string) => known.has(candidate)

	if (name.includes('::')) {
		if (has(name)) return name
		return name
	}

	const parts = scope ? scope.split('::') : []
	for (let i = parts.length; i >= 0; i--) {
		const prefix = parts.slice(0, i).join('::')
		const candidate = prefix ? `${prefix}::${name}` : name
		if (has(candidate)) return candidate
	}
	const qpiCandidate = `QPI::${name}`
	if (has(qpiCandidate)) return qpiCandidate
	if (has(name)) return name
	return name
}
