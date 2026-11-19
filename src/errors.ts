import { ContractAbiError } from './types.js'

/** Base class for lookup failures. */
export class ContractLookupError extends ContractAbiError {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options)
		this.name = 'ContractLookupError'
	}
}

/** A contract is not present in the metadata set. */
export class ContractNotFoundError extends ContractLookupError {
	constructor(
		readonly lookup:
			| { index: number }
			| { name: string }
			| { assetName: string },
		options?: { cause?: unknown },
	) {
		const label =
			'index' in lookup
				? `index ${lookup.index}`
				: 'name' in lookup
					? `name "${lookup.name}"`
					: `asset name "${lookup.assetName}"`
		super(`Contract with ${label} not found`, options)
		this.name = 'ContractNotFoundError'
	}
}

/** A call with the requested ordinal or name does not exist. */
export class EntryNotFoundError extends ContractLookupError {
	constructor(
		readonly contractName: string,
		readonly kind: 'procedure' | 'function' | 'notification',
		readonly selector: { inputType: number } | { name: string },
		options?: { cause?: unknown },
	) {
		const label =
			'inputType' in selector
				? `inputType ${selector.inputType}`
				: `name "${selector.name}"`
		super(
			`${kind} with ${label} not found in contract ${contractName}`,
			options,
		)
		this.name = 'EntryNotFoundError'
	}
}

/** A struct name could not be resolved in a struct scope. */
export class StructNotFoundError extends ContractLookupError {
	constructor(
		readonly scopeName: string,
		readonly structName: string,
		options?: { cause?: unknown },
	) {
		super(`struct "${structName}" not found in ${scopeName}`, options)
		this.name = 'StructNotFoundError'
	}
}

/** Metadata or ABI descriptors failed structural validation. */
export class MetadataValidationError extends ContractAbiError {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options)
		this.name = 'MetadataValidationError'
	}
}

/** A value could not be encoded against its field descriptor. */
export class PayloadBuildError extends ContractAbiError {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options)
		this.name = 'PayloadBuildError'
	}
}

/** Binary data could not be decoded against its field descriptors. */
export class PayloadDecodeError extends ContractAbiError {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options)
		this.name = 'PayloadDecodeError'
	}
}

/** An identity string or public key could not be parsed or formatted. */
export class IdentityCodecError extends ContractAbiError {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options)
		this.name = 'IdentityCodecError'
	}
}
