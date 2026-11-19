import { describe, expect, test } from 'bun:test'
import { CppParseError } from '../cpp-error.ts'
import { type CppToken, tokenize } from '../tokenizer.ts'

function values(tokens: CppToken[]): string[] {
	return tokens.map((token) => token.value)
}

describe('tokenize', () => {
	test('produces identifiers, numbers, and punctuation', () => {
		const tokens = tokenize(
			'struct QX : public ContractBase { uint64 x = 0x10ULL; };',
		)
		expect(values(tokens)).toEqual([
			'struct',
			'QX',
			':',
			'public',
			'ContractBase',
			'{',
			'uint64',
			'x',
			'=',
			'0x10ULL',
			';',
			'}',
			';',
			'',
		])
		expect(tokens[tokens.length - 1]?.kind).toBe('eof')
	})

	test('tracks 1-based line and column positions', () => {
		const tokens = tokenize('struct A\n{\n  uint64 value;\n};')
		const value = tokens.find((token) => token.value === 'value')
		expect(value?.line).toBe(3)
		expect(value?.column).toBe(10)
	})

	test('recognises multi-character operators', () => {
		const tokens = tokenize('A::B -> C << 2 >> 1 ...')
		expect(values(tokens).slice(0, -1)).toEqual([
			'A',
			'::',
			'B',
			'->',
			'C',
			'<<',
			'2',
			'>>',
			'1',
			'...',
		])
	})

	test('keeps comments when requested', () => {
		const source = '// line one\n/* block\n comment */ struct A {};'
		const tokens = tokenize(source, { includeComments: true })
		expect(
			tokens
				.filter((token) => token.kind === 'comment')
				.map((token) => token.value),
		).toEqual(['// line one', '/* block\n comment */'])
	})

	test('drops comments by default', () => {
		const tokens = tokenize('struct /* hidden */ A {};')
		expect(values(tokens)).not.toContain('/* hidden */')
	})

	test('reports preprocessor directives as opaque tokens', () => {
		const tokens = tokenize('#define SIZE 4\nstruct A {};', {
			includePreprocessor: true,
		})
		const directive = tokens.find((token) => token.kind === 'preprocessor')
		expect(directive?.value).toBe('#define SIZE 4')
	})

	test('handles digit separators, suffixes, binary, octal, and floats', () => {
		const tokens = tokenize("1'000ULL 0b1010u 0755 1.5e3f 0xFF")
		expect(values(tokens).slice(0, -1)).toEqual([
			"1'000ULL",
			'0b1010u',
			'0755',
			'1.5e3f',
			'0xFF',
		])
	})

	test('keeps string and character literals intact with escapes', () => {
		const tokens = tokenize('"a\\"b" \'\\n\'')
		expect(values(tokens).slice(0, -1)).toEqual(['"a\\"b"', "'\\n'"])
		expect(tokens[0]?.kind).toBe('string')
		expect(tokens[1]?.kind).toBe('char')
	})

	test('throws a positioned error for an unterminated block comment', () => {
		expect(() => tokenize('struct A {};\n/* not closed')).toThrow(CppParseError)
		try {
			tokenize('struct A {};\n/* not closed', { fileName: 'broken.h' })
		} catch (error) {
			expect(error).toBeInstanceOf(CppParseError)
			const parseError = error as CppParseError
			expect(parseError.fileName).toBe('broken.h')
			expect(parseError.line).toBe(2)
			expect(parseError.message).toContain('broken.h:2:1')
		}
	})

	test('throws for an unterminated string literal', () => {
		expect(() => tokenize('const char* x = "oops;')).toThrow(CppParseError)
	})
})
