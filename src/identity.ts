/**
 * Identity helpers.
 *
 * Qubic identities are 60-character base-26 strings. The first 56 characters
 * encode the 32-byte public key (four little-endian 64-bit fragments, 14
 * base-26 digits each) and the last four characters are a K12 checksum.
 *
 * Encoding and checksum validation use `@qubic.org/crypto`. Decoding the
 * 56-character payload is also available without checksum validation for
 * callers that only need the public key bytes.
 */

import {
	contractIndexToIdentity,
	identityToPublicKey as qubicIdentityToPublicKey,
	publicKeyToIdentity as qubicPublicKeyToIdentity,
} from '@qubic.org/crypto'
import { IdentityCodecError } from './errors.js'
import type { DecodeOptions, EncodeOptions } from './types.js'

/** Length of a Qubic identity string. */
export const IDENTITY_LENGTH = 60
/** Length of a raw compressed public key. */
export const PUBLIC_KEY_LENGTH = 32
/** Length of a hex-encoded public key without the `0x` prefix. */
export const PUBLIC_KEY_HEX_LENGTH = 64

const IDENTITY_CHUNK_LENGTH = 14
const IDENTITY_CHUNK_COUNT = 4
const BASE = 26n
const MAX_UINT64 = (1n << 64n) - 1n
const UPPERCASE_IDENTITY = /^[A-Z]{60}$/
const IDENTITY_LETTERS = /^[A-Za-z]{60}$/
const HEX_RE = /^[0-9a-fA-F]*$/
const HEX_PUBLIC_KEY = /^(?:0x)?[0-9a-fA-F]{64}$/

/** Pluggable conversions for `id` fields. */
export interface IdentityHooks {
	identityToPublicKey?: (identity: string) => Uint8Array
	publicKeyToIdentity?: (publicKey: Uint8Array) => string
	idFormat?: 'identity' | 'hex'
}

/** Returns true when the value is a structurally valid 60-character identity. */
export function isIdentity(value: unknown): value is string {
	return typeof value === 'string' && UPPERCASE_IDENTITY.test(value)
}

/** Throws `IdentityCodecError` when the value is not a 60-character identity. */
export function assertIdentity(value: string): string {
	if (!isIdentity(value)) {
		throw new IdentityCodecError(
			`Expected a ${IDENTITY_LENGTH}-character uppercase Qubic identity`,
		)
	}
	return value
}

/** Returns true when the value is a 32-byte public key. */
export function isPublicKey(value: unknown): value is Uint8Array {
	return value instanceof Uint8Array && value.byteLength === PUBLIC_KEY_LENGTH
}

/** Throws `IdentityCodecError` when the value is not a 32-byte public key. */
export function assertPublicKey(value: Uint8Array): Uint8Array {
	if (!isPublicKey(value)) {
		throw new IdentityCodecError(
			`Expected a ${PUBLIC_KEY_LENGTH}-byte public key`,
		)
	}
	return value
}

/**
 * Convert bytes to a lowercase (by default) hex string.
 *
 * @param bytes - Bytes to encode.
 * @param uppercase - Emit uppercase hex when true.
 */
export function bytesToHex(bytes: Uint8Array, uppercase = false): string {
	let output = ''
	for (let i = 0; i < bytes.byteLength; i++) {
		output += (bytes[i] ?? 0).toString(16).padStart(2, '0')
	}
	return uppercase ? output.toUpperCase() : output
}

/**
 * Convert a hex string to bytes. Accepts an optional `0x` prefix and either
 * hex case. Throws when the input has an odd length or non-hex characters.
 */
export function hexToBytes(hex: string): Uint8Array {
	const body = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex
	if (body.length % 2 !== 0) {
		throw new IdentityCodecError(
			`Invalid hex string: expected an even number of digits, got ${body.length}`,
		)
	}
	if (!HEX_RE.test(body)) {
		throw new IdentityCodecError(
			'Invalid hex string: contains non-hex characters',
		)
	}
	const output = new Uint8Array(body.length / 2)
	for (let i = 0; i < output.length; i++) {
		output[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16)
	}
	return output
}

/**
 * Decodes the 56-character payload of a Qubic identity into a 32-byte public
 * key. The four checksum characters are intentionally ignored; use
 * {@link identityToPublicKey} when checksum validation is required.
 */
export function decodeBase26Identity(identity: string): Uint8Array {
	assertIdentity(identity)

	const publicKey = new Uint8Array(PUBLIC_KEY_LENGTH)
	for (let chunk = 0; chunk < IDENTITY_CHUNK_COUNT; chunk++) {
		let fragment = 0n
		const start = chunk * IDENTITY_CHUNK_LENGTH
		for (let index = IDENTITY_CHUNK_LENGTH - 1; index >= 0; index--) {
			const digit = identity.charCodeAt(start + index) - 65
			if (digit < 0 || digit >= 26) {
				throw new IdentityCodecError(
					`Invalid identity: expected letters A-Z at position ${start + index}`,
				)
			}
			fragment = fragment * BASE + BigInt(digit)
		}
		if (fragment > MAX_UINT64) {
			throw new IdentityCodecError(
				`Identity chunk ${chunk} overflows a 64-bit value`,
			)
		}
		for (let byte = 0; byte < 8; byte++) {
			publicKey[chunk * 8 + byte] = Number(
				(fragment >> BigInt(byte * 8)) & 0xffn,
			)
		}
	}

	return publicKey
}

/** Decodes a 64-character hex public key, with or without a `0x` prefix. */
export function hexToPublicKey(hex: string): Uint8Array {
	if (!HEX_PUBLIC_KEY.test(hex)) {
		throw new IdentityCodecError('Expected a 64-character hex public key')
	}
	return hexToBytes(hex)
}

/** Formats a 32-byte public key as 64 lowercase hex characters. */
export function publicKeyToHex(publicKey: Uint8Array): string {
	assertPublicKey(publicKey)
	return bytesToHex(publicKey)
}

/**
 * Encode a 32-byte public key as a 60-character Qubic identity.
 *
 * The checksum is computed with K12 via `@qubic.org/crypto`.
 */
export function publicKeyToIdentity(publicKey: Uint8Array): string {
	assertPublicKey(publicKey)
	try {
		return qubicPublicKeyToIdentity(publicKey) as string
	} catch (cause) {
		throw new IdentityCodecError('Failed to encode Qubic identity', { cause })
	}
}

/**
 * Decode an identity into its 32-byte public key.
 *
 * Accepts:
 * - a 32-byte `Uint8Array` (returned as a copy),
 * - a 64-character hex string with or without a `0x` prefix,
 * - a 60-character Qubic base-26 identity (checksum validated).
 */
export function identityToPublicKey(value: string | Uint8Array): Uint8Array {
	if (value instanceof Uint8Array) {
		return new Uint8Array(assertPublicKey(value))
	}
	if (typeof value !== 'string') {
		throw new IdentityCodecError(
			'Expected an identity string or a 32-byte Uint8Array',
		)
	}

	if (value.length === IDENTITY_LENGTH) {
		if (!IDENTITY_LETTERS.test(value)) {
			throw new IdentityCodecError('Invalid identity: expected 60 letters A-Z')
		}
		try {
			return qubicIdentityToPublicKey(value.toUpperCase() as never)
		} catch (cause) {
			throw new IdentityCodecError('Invalid Qubic identity', { cause })
		}
	}

	const body =
		value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value
	if (body.length === PUBLIC_KEY_HEX_LENGTH && HEX_RE.test(body)) {
		return hexToBytes(body)
	}

	throw new IdentityCodecError(
		`Expected a ${IDENTITY_LENGTH}-character Qubic identity or a ${PUBLIC_KEY_HEX_LENGTH}-character hex public key`,
	)
}

/** Alias for {@link identityToPublicKey}. */
export const decodeIdentity = identityToPublicKey

/**
 * Return true when `value` is a structurally valid 60-character Qubic
 * identity with a correct checksum.
 */
export function isValidIdentity(value: string): boolean {
	if (typeof value !== 'string' || !IDENTITY_LETTERS.test(value)) return false
	try {
		qubicIdentityToPublicKey(value.toUpperCase() as never)
		return true
	} catch {
		return false
	}
}

/**
 * Converts an `id` field value into a 32-byte public key.
 *
 * Accepted inputs are identity strings, 64-character hex strings, and
 * 32-byte arrays. When `identityToPublicKey` is supplied it is used for
 * identity strings; the result must be exactly 32 bytes.
 */
export function parsePublicKey(
	value: string | Uint8Array,
	options: EncodeOptions | IdentityHooks = {},
): Uint8Array {
	if (value instanceof Uint8Array) {
		return assertPublicKey(value)
	}

	const hook = options.identityToPublicKey
	if (isIdentity(value)) {
		if (hook) {
			let publicKey: Uint8Array
			try {
				publicKey = hook(value)
			} catch (cause) {
				throw new IdentityCodecError('identityToPublicKey hook failed', {
					cause,
				})
			}
			return assertPublicKey(publicKey)
		}
		return identityToPublicKey(value)
	}

	if (HEX_PUBLIC_KEY.test(value)) {
		return hexToPublicKey(value)
	}

	throw new IdentityCodecError(
		'Expected a 60-character Qubic identity, a 64-character hex public key, or 32 bytes',
	)
}

/**
 * Formats a public key for decoded `id` output. When `publicKeyToIdentity` is
 * supplied its result is returned; otherwise a 60-character identity is used.
 */
export function formatPublicKey(
	publicKey: Uint8Array,
	options: DecodeOptions | IdentityHooks = {},
): string {
	assertPublicKey(publicKey)
	if (options.idFormat === 'hex') {
		return publicKeyToHex(publicKey)
	}
	const hook = options.publicKeyToIdentity
	if (!hook) {
		return publicKeyToIdentity(publicKey)
	}

	let identity: string
	try {
		identity = hook(publicKey)
	} catch (cause) {
		throw new IdentityCodecError('publicKeyToIdentity hook failed', { cause })
	}
	if (typeof identity !== 'string') {
		throw new IdentityCodecError(
			'publicKeyToIdentity hook must return a string',
		)
	}
	return identity
}

export { contractIndexToIdentity }
