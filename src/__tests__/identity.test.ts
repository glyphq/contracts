import { describe, expect, test } from 'bun:test'
import {
	bytesToHex,
	contractIndexToIdentity,
	hexToBytes,
	IDENTITY_LENGTH,
	identityToPublicKey,
	isValidIdentity,
	PUBLIC_KEY_HEX_LENGTH,
	PUBLIC_KEY_LENGTH,
	publicKeyToHex,
	publicKeyToIdentity,
} from '../identity.js'

const KNOWN_IDENTITY =
	'BZBQFLLBNCXEMGLOBHUVFTLUPLVCPQUASSILFABOFFBCADQSSUPNWLZBQEXK'

describe('identity validation', () => {
	test('accepts a known identity and rejects a bad checksum', () => {
		expect(isValidIdentity(KNOWN_IDENTITY)).toBe(true)
		expect(isValidIdentity(`${KNOWN_IDENTITY.slice(0, 59)}A`)).toBe(false)
	})

	test('accepts lowercase identities by normalising to uppercase', () => {
		expect(isValidIdentity(KNOWN_IDENTITY.toLowerCase())).toBe(true)
		expect(
			publicKeyToIdentity(identityToPublicKey(KNOWN_IDENTITY.toLowerCase())),
		).toBe(KNOWN_IDENTITY)
	})

	test('rejects wrong lengths and non-letters', () => {
		expect(isValidIdentity(KNOWN_IDENTITY.slice(1))).toBe(false)
		expect(isValidIdentity(`A${KNOWN_IDENTITY.slice(1, 59)}0`)).toBe(false)
		expect(isValidIdentity('')).toBe(false)
	})
})

describe('identityToPublicKey', () => {
	test('round-trips the known identity', () => {
		const publicKey = identityToPublicKey(KNOWN_IDENTITY)
		expect(publicKey.byteLength).toBe(PUBLIC_KEY_LENGTH)
		expect(publicKeyToIdentity(publicKey)).toBe(KNOWN_IDENTITY)
	})

	test('accepts hex strings with and without 0x', () => {
		const publicKey = identityToPublicKey(KNOWN_IDENTITY)
		const hex = publicKeyToHex(publicKey)
		expect(Array.from(identityToPublicKey(hex))).toEqual(Array.from(publicKey))
		expect(Array.from(identityToPublicKey(`0x${hex}`))).toEqual(
			Array.from(publicKey),
		)
	})

	test('accepts and copies 32-byte arrays', () => {
		const input = new Uint8Array(32).fill(7)
		const publicKey = identityToPublicKey(input)
		expect(Array.from(publicKey)).toEqual(Array.from(input))
		expect(publicKey).not.toBe(input)
	})

	test('rejects bad widths and unsupported strings', () => {
		expect(() => identityToPublicKey(new Uint8Array(31))).toThrow()
		expect(() => identityToPublicKey('not-an-identity')).toThrow()
		expect(() => identityToPublicKey(`${'A'.repeat(59)}0`)).toThrow()
	})
})

describe('hex helpers', () => {
	test('bytesToHex round-trips through hexToBytes', () => {
		const bytes = new Uint8Array(32)
		for (let index = 0; index < bytes.length; index++) {
			bytes[index] = index
		}
		const hex = bytesToHex(bytes)
		expect(hex).toHaveLength(PUBLIC_KEY_HEX_LENGTH)
		expect(bytesToHex(bytes, true)).toBe(hex.toUpperCase())
		expect(Array.from(hexToBytes(hex))).toEqual(Array.from(bytes))
		expect(Array.from(hexToBytes(`0x${hex}`))).toEqual(Array.from(bytes))
	})

	test('rejects malformed hex', () => {
		expect(() => hexToBytes('abc')).toThrow()
		expect(() => hexToBytes('zz')).toThrow()
	})

	test('publicKeyToHex validates the width', () => {
		expect(publicKeyToHex(new Uint8Array(32))).toBe('00'.repeat(32))
		expect(() => publicKeyToHex(new Uint8Array(31))).toThrow()
	})
})

describe('contractIndexToIdentity', () => {
	test('produces a 60-character identity for contract indices', () => {
		expect(contractIndexToIdentity(9)).toHaveLength(IDENTITY_LENGTH)
		expect(contractIndexToIdentity(9)).toBe(contractIndexToIdentity(9))
		expect(contractIndexToIdentity(9)).not.toBe(contractIndexToIdentity(10))
	})
})
