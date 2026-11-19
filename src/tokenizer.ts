import { CppParseError } from './cpp-error.ts'

/** Kinds of tokens produced by {@link tokenize}. */
export type CppTokenKind =
	| 'identifier'
	| 'number'
	| 'string'
	| 'char'
	| 'punctuation'
	| 'comment'
	| 'preprocessor'
	| 'eof'

export interface CppToken {
	kind: CppTokenKind
	/** Raw token text. Strings and characters keep their quotes. */
	value: string
	/** 1-based source line. */
	line: number
	/** 1-based source column. */
	column: number
	/** 0-based offset in the source text. */
	offset: number
}

export interface TokenizeOptions {
	/** Source name used in error messages. */
	fileName?: string
	/**
	 * Keep `//` and block comments as tokens. The parser uses them to attach
	 * doc comments to declarations.
	 */
	includeComments?: boolean
	/** Keep preprocessor directives as single tokens instead of discarding them. */
	includePreprocessor?: boolean
}

const PUNCTUATION = [
	'<<=',
	'>>=',
	'...',
	'->*',
	'::',
	'->',
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
	'##',
	'[',
	']',
	'(',
	')',
	'{',
	'}',
	'<',
	'>',
	',',
	';',
	':',
	'?',
	'.',
	'+',
	'-',
	'*',
	'/',
	'%',
	'&',
	'|',
	'^',
	'~',
	'!',
	'=',
	'#',
] as const

const IDENTIFIER_START = /[A-Za-z_$]/
const IDENTIFIER_PART = /[A-Za-z0-9_$]/

function isDigit(char: string | undefined): boolean {
	return char !== undefined && char >= '0' && char <= '9'
}

function isHexDigit(char: string | undefined): boolean {
	return char !== undefined && /[0-9A-Fa-f]/.test(char)
}

/**
 * Tokenize the C++ subset used by Qubic contract headers.
 *
 * Macros are not expanded. The tokenizer reports preprocessor directives as
 * opaque line tokens so the parser can collect simple `#define` constants
 * while ignoring includes, pragmas, and build-time conditionals.
 */
export function tokenize(
	source: string,
	options: TokenizeOptions = {},
): CppToken[] {
	const tokens: CppToken[] = []
	const fileName = options.fileName
	let offset = 0
	let line = 1
	let column = 1

	const error = (
		message: string,
		tokenOffset = offset,
		tokenLine = line,
		tokenColumn = column,
	): never => {
		throw new CppParseError(message, {
			fileName,
			line: tokenLine,
			column: tokenColumn,
			offset: tokenOffset,
		})
	}

	const advance = (count = 1): void => {
		for (let index = 0; index < count; index += 1) {
			if (source[offset] === '\n') {
				line += 1
				column = 1
			} else {
				column += 1
			}
			offset += 1
		}
	}

	const push = (
		kind: CppTokenKind,
		value: string,
		startOffset: number,
		startLine: number,
		startColumn: number,
	): void => {
		tokens.push({
			kind,
			value,
			line: startLine,
			column: startColumn,
			offset: startOffset,
		})
	}

	while (offset < source.length) {
		const char = source[offset] as string

		if (
			char === ' ' ||
			char === '\t' ||
			char === '\r' ||
			char === '\n' ||
			char === '\f' ||
			char === '\v'
		) {
			advance()
			continue
		}

		if (char === '/' && source[offset + 1] === '/') {
			const startOffset = offset
			const startLine = line
			const startColumn = column
			advance(2)
			while (offset < source.length && source[offset] !== '\n') {
				advance()
			}
			if (options.includeComments) {
				push(
					'comment',
					source.slice(startOffset, offset),
					startOffset,
					startLine,
					startColumn,
				)
			}
			continue
		}

		if (char === '/' && source[offset + 1] === '*') {
			const startOffset = offset
			const startLine = line
			const startColumn = column
			const end = source.indexOf('*/', offset + 2)
			if (end === -1) {
				error('Unterminated block comment', startOffset, startLine, startColumn)
			}
			advance(end + 2 - offset)
			if (options.includeComments) {
				push(
					'comment',
					source.slice(startOffset, offset),
					startOffset,
					startLine,
					startColumn,
				)
			}
			continue
		}

		if (char === '#') {
			const startOffset = offset
			const startLine = line
			const startColumn = column
			while (offset < source.length && source[offset] !== '\n') {
				if (source[offset] === '\\' && source[offset + 1] === '\n') {
					advance(2)
					continue
				}
				if (
					source[offset] === '\\' &&
					source[offset + 1] === '\r' &&
					source[offset + 2] === '\n'
				) {
					advance(3)
					continue
				}
				advance()
			}
			if (options.includePreprocessor) {
				push(
					'preprocessor',
					source.slice(startOffset, offset).replace(/\s+$/, ''),
					startOffset,
					startLine,
					startColumn,
				)
			}
			continue
		}

		if (IDENTIFIER_START.test(char)) {
			const startOffset = offset
			const startLine = line
			const startColumn = column
			advance()
			while (
				offset < source.length &&
				IDENTIFIER_PART.test(source[offset] as string)
			) {
				advance()
			}
			push(
				'identifier',
				source.slice(startOffset, offset),
				startOffset,
				startLine,
				startColumn,
			)
			continue
		}

		if (isDigit(char) || (char === '.' && isDigit(source[offset + 1]))) {
			const startOffset = offset
			const startLine = line
			const startColumn = column

			if (
				char === '0' &&
				(source[offset + 1] === 'x' || source[offset + 1] === 'X')
			) {
				advance(2)
				while (isHexDigit(source[offset]) || source[offset] === "'") {
					advance()
				}
			} else if (
				char === '0' &&
				(source[offset + 1] === 'b' || source[offset + 1] === 'B')
			) {
				advance(2)
				while (
					source[offset] === '0' ||
					source[offset] === '1' ||
					source[offset] === "'"
				) {
					advance()
				}
			} else {
				while (isDigit(source[offset]) || source[offset] === "'") {
					advance()
				}
				if (source[offset] === '.') {
					advance()
					while (isDigit(source[offset]) || source[offset] === "'") {
						advance()
					}
				}
				if (source[offset] === 'e' || source[offset] === 'E') {
					const exponentStart = offset
					advance()
					if (source[offset] === '+' || source[offset] === '-') {
						advance()
					}
					if (!isDigit(source[offset])) {
						offset = exponentStart
						column -= exponentStart - offset
					} else {
						while (isDigit(source[offset])) {
							advance()
						}
					}
				}
			}

			// Integer/float suffixes: u, U, l, L, ll, LL, f, F, z, Z.
			while (
				offset < source.length &&
				/[uUlLfFzZ]/.test(source[offset] as string)
			) {
				advance()
			}

			push(
				'number',
				source.slice(startOffset, offset),
				startOffset,
				startLine,
				startColumn,
			)
			continue
		}

		if (char === '"' || char === "'") {
			const quote = char
			const startOffset = offset
			const startLine = line
			const startColumn = column
			advance()
			let terminated = false
			while (offset < source.length) {
				const current = source[offset]
				if (current === '\\') {
					advance(2)
					continue
				}
				if (current === quote) {
					advance()
					terminated = true
					break
				}
				if (current === '\n') {
					break
				}
				advance()
			}
			if (!terminated) {
				error(
					quote === '"'
						? 'Unterminated string literal'
						: 'Unterminated character literal',
					startOffset,
					startLine,
					startColumn,
				)
			}
			push(
				quote === '"' ? 'string' : 'char',
				source.slice(startOffset, offset),
				startOffset,
				startLine,
				startColumn,
			)
			continue
		}

		let matched: string | undefined
		for (const punctuation of PUNCTUATION) {
			if (source.startsWith(punctuation, offset)) {
				matched = punctuation
				break
			}
		}
		if (matched === undefined) {
			error(`Unexpected character ${JSON.stringify(char)}`)
			return tokens
		}

		const punctuation = matched
		const startOffset = offset
		const startLine = line
		const startColumn = column
		advance(punctuation.length)
		push('punctuation', punctuation, startOffset, startLine, startColumn)
	}

	tokens.push({ kind: 'eof', value: '', line, column, offset })
	return tokens
}

/** Return the raw text of a token list, mainly useful for error messages. */
export function tokenText(tokens: readonly CppToken[]): string {
	return tokens.map((token) => token.value).join(' ')
}
