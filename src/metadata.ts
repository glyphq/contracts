/**
 * Generated ABI access.
 *
 * The generated modules are committed so consumers never need to run the
 * generator. Use `contracts.QX` for typed per-contract handles, or
 * `getContractDefinition("QX")` when you only need metadata.
 */

import type { ContractHandle } from './abi.js'
import {
	CONTRACT_HANDLES,
	CONTRACT_HANDLES_BY_NAME,
} from './generated/contracts.js'
import {
	CONTRACT_METADATA,
	CONTRACTS,
	CONTRACTS_BY_INDEX,
	CONTRACTS_BY_NAME,
} from './generated/metadata.js'
import type { ContractDefinition } from './types.js'

export * from './generated/contracts.js'
export {
	CONTRACT_HANDLES,
	CONTRACT_HANDLES_BY_NAME,
	CONTRACT_METADATA,
	CONTRACTS,
	CONTRACTS_BY_INDEX,
	CONTRACTS_BY_NAME,
}

/** Typed contract handles keyed by canonical contract name. */
export const contracts = CONTRACT_HANDLES_BY_NAME

function normalize(ref: string | number): string | number {
	return typeof ref === 'string' ? ref.trim() : ref
}

/**
 * Resolve a contract definition by index, canonical name, or asset name.
 * Lookup is case-insensitive for names and asset names.
 */
export function getContractDefinition(
	ref: string | number,
): ContractDefinition {
	const key = normalize(ref)
	if (typeof key === 'number') {
		const contract = CONTRACTS_BY_INDEX[key]
		if (contract === undefined) throw new Error(`Unknown contract index ${key}`)
		return contract
	}
	const direct = CONTRACTS_BY_NAME[key.toUpperCase()]
	if (direct !== undefined) return direct
	const byAsset = CONTRACTS.find(
		(contract) => contract.assetName.toLowerCase() === key.toLowerCase(),
	)
	if (byAsset !== undefined) return byAsset
	throw new Error(`Unknown contract "${key}"`)
}

/** Resolve a typed handle by index, canonical name, or asset name. */
export function getContractHandle(
	ref: string | number,
): (typeof CONTRACT_HANDLES)[number] {
	const definition = getContractDefinition(ref)
	const handle = CONTRACT_HANDLES.find(
		(candidate) => candidate.contractIndex === definition.index,
	)
	if (handle === undefined) {
		throw new Error(`No generated handle for contract ${definition.name}`)
	}
	return handle
}

/** Narrow a generic handle to the generated handle types without a lookup. */
export type GeneratedContractHandle = (typeof CONTRACT_HANDLES)[number]
export type { ContractHandle }
