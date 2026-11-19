import { ContractAbiError } from './types.ts'

/**
 * Error raised while tokenizing or parsing a C++ contract header.
 *
 * Contract headers are only a small, mostly-declarative subset of C++. The
 * parser reports the exact source position instead of silently producing a
 * partial contract description.
 */
export class CppParseError extends ContractAbiError {
	readonly fileName: string | undefined
	readonly line: number
	readonly column: number
	readonly offset: number

	constructor(
		message: string,
		position: {
			fileName?: string
			line?: number
			column?: number
			offset?: number
		} = {},
		options?: { cause?: unknown },
	) {
		const fileName = position.fileName
		const line = position.line ?? 1
		const column = position.column ?? 1
		const location = fileName
			? `${fileName}:${line}:${column}`
			: `${line}:${column}`
		super(`${location}: ${message}`, options)
		this.name = 'CppParseError'
		this.fileName = fileName
		this.line = line
		this.column = column
		this.offset = position.offset ?? 0
	}
}
