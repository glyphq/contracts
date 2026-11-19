/**
 * Lightweight contract registry helpers.
 *
 * These build on the generated metadata without requiring it at module load
 * time. `createContractIndex` accepts either a plain contract array or a
 * `ContractMetadata` document; `getContract` then resolves an index, canonical
 * name, or asset name case-insensitively.
 */

import { ContractNotFoundError } from './errors.js'
import type { ContractDefinition, ContractMetadata } from './types.js'

/** Indexed view over a set of contract definitions. */
export interface ContractIndex {
	/** Definitions in their original order. */
	readonly contracts: readonly ContractDefinition[]
	/** Definitions keyed by on-chain index. */
	readonly byIndex: ReadonlyMap<number, ContractDefinition>
	/** Definitions keyed by lowercase canonical name. */
	readonly byName: ReadonlyMap<string, ContractDefinition>
	/** Definitions keyed by lowercase asset name. */
	readonly byAssetName: ReadonlyMap<string, ContractDefinition>
}

function isMetadata(
	value: readonly ContractDefinition[] | ContractMetadata,
): value is ContractMetadata {
	return (
		!Array.isArray(value) &&
		Array.isArray((value as ContractMetadata).contracts)
	)
}

function definitions(
	source: readonly ContractDefinition[] | ContractMetadata,
): readonly ContractDefinition[] {
	return isMetadata(source) ? source.contracts : source
}

/**
 * Build an O(1) lookup index over contract definitions.
 *
 * Later duplicates overwrite earlier ones in the maps; use
 * `validateMetadata` from the lookup module when metadata integrity matters.
 */
export function createContractIndex(
	source: readonly ContractDefinition[] | ContractMetadata,
): ContractIndex {
	const contracts = definitions(source)
	const byIndex = new Map<number, ContractDefinition>()
	const byName = new Map<string, ContractDefinition>()
	const byAssetName = new Map<string, ContractDefinition>()

	for (const contract of contracts) {
		byIndex.set(contract.index, contract)
		byName.set(contract.name.toLowerCase(), contract)
		byAssetName.set(contract.assetName.toLowerCase(), contract)
	}

	return {
		contracts,
		byIndex,
		byName,
		byAssetName,
	}
}

function resolve(
	index: ContractIndex,
	ref: string | number,
): ContractDefinition | undefined {
	if (typeof ref === 'number') {
		return index.byIndex.get(ref)
	}

	const normalized = ref.trim()
	if (/^\d+$/.test(normalized)) {
		const byIndex = index.byIndex.get(Number(normalized))
		if (byIndex) return byIndex
	}

	const key = normalized.toLowerCase()
	return index.byName.get(key) ?? index.byAssetName.get(key)
}

/**
 * Resolve a contract by index, canonical name, or asset name.
 *
 * Returns `undefined` when no contract matches. Use {@link requireContract}
 * when a miss should throw.
 */
export function getContract(
	source: ContractIndex | readonly ContractDefinition[] | ContractMetadata,
	ref: string | number,
): ContractDefinition | undefined {
	const index = 'byIndex' in source ? source : createContractIndex(source)
	return resolve(index, ref)
}

/** Resolve a contract or throw `ContractNotFoundError`. */
export function requireContract(
	source: ContractIndex | readonly ContractDefinition[] | ContractMetadata,
	ref: string | number,
): ContractDefinition {
	const index = 'byIndex' in source ? source : createContractIndex(source)
	const contract = resolve(index, ref)
	if (!contract) {
		if (typeof ref === 'number') {
			throw new ContractNotFoundError({ index: ref })
		}
		throw new ContractNotFoundError({ name: ref })
	}
	return contract
}

/**
 * Object-oriented wrapper around {@link createContractIndex}. Useful when a
 * metadata set is loaded once and queried repeatedly.
 */
export class ContractRegistry {
	readonly index: ContractIndex

	constructor(source: readonly ContractDefinition[] | ContractMetadata) {
		this.index = createContractIndex(source)
	}

	get size(): number {
		return this.index.contracts.length
	}

	get contracts(): readonly ContractDefinition[] {
		return this.index.contracts
	}

	/** Find a contract, returning `undefined` for a miss. */
	get(ref: string | number): ContractDefinition | undefined {
		return getContract(this.index, ref)
	}

	/** Find a contract, throwing `ContractNotFoundError` for a miss. */
	require(ref: string | number): ContractDefinition {
		return requireContract(this.index, ref)
	}

	/** True when the reference resolves to a contract. */
	has(ref: string | number): boolean {
		return this.get(ref) !== undefined
	}
}

/** Convenience factory matching {@link ContractRegistry}. */
export function createContractRegistry(
	source: readonly ContractDefinition[] | ContractMetadata,
): ContractRegistry {
	return new ContractRegistry(source)
}
