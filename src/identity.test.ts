import { describe, expect, test } from 'bun:test'
import { IdentityCodecError } from './errors.js'
import {
	bytesToHex,
	contractIndexToIdentity,
	hexToBytes,
	identityToPublicKey,
	isValidIdentity,
	parsePublicKey,
	publicKeyToHex,
	publicKeyToIdentity,
} from './identity.js'

const ZERO_IDENTITY = `${'A'.repeat(56)}FXIB`
const QX_IDENTITY =
	'BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARMID'

describe('publicKeyToIdentity', () => {
	test('matches reference identities', () => {
		expect(publicKeyToIdentity(new Uint8Array(32)) as string).toBe(
			ZERO_IDENTITY,
		)
		expect(contractIndexToIdentity(1) as string).toBe(QX_IDENTITY)
	})

	test('rejects non-32-byte keys', () => {
		expect(() => publicKeyToIdentity(new Uint8Array(31))).toThrow(
			IdentityCodecError,
		)
	})
})

describe('identityToPublicKey', () => {
	test('decodes a 60-character identity to 32 bytes', () => {
		const publicKey = identityToPublicKey(ZERO_IDENTITY)
		expect(publicKey.byteLength).toBe(32)
		expect(Array.from(publicKey)).toEqual(Array.from(new Uint8Array(32)))
		expect(publicKeyToIdentity(publicKey)).toBe(ZERO_IDENTITY)
	})

	test('accepts lowercase identities by normalising case', () => {
		expect(
			Array.from(identityToPublicKey(ZERO_IDENTITY.toLowerCase())),
		).toEqual(Array.from(new Uint8Array(32)))
	})

	test('accepts 64-character hex with and without 0x', () => {
		const hex = 'ab'.repeat(32)
		expect(publicKeyToHex(identityToPublicKey(hex))).toBe(hex)
		expect(publicKeyToHex(identityToPublicKey(`0x${hex}`))).toBe(hex)
		expect(publicKeyToHex(identityToPublicKey(hex.toUpperCase()))).toBe(hex)
	})

	test('accepts and copies a 32-byte Uint8Array', () => {
		const input = new Uint8Array(32).fill(7)
		const output = identityToPublicKey(input)
		expect(Array.from(output)).toEqual(Array.from(input))
		output[0] = 9
		expect(input[0]).toBe(7)
	})

	test('rejects bad lengths, alphabets, and checksums', () => {
		expect(() => identityToPublicKey('short')).toThrow(IdentityCodecError)
		expect(() => identityToPublicKey('A'.repeat(60))).toThrow(
			IdentityCodecError,
		)
		expect(() => identityToPublicKey(`${ZERO_IDENTITY.slice(0, 59)}A`)).toThrow(
			IdentityCodecError,
		)
		expect(() => identityToPublicKey(new Uint8Array(31))).toThrow(
			IdentityCodecError,
		)
	})

	test('isValidIdentity validates the checksum', () => {
		expect(isValidIdentity(ZERO_IDENTITY)).toBe(true)
		expect(isValidIdentity(ZERO_IDENTITY.toLowerCase())).toBe(true)
		expect(isValidIdentity(`${ZERO_IDENTITY.slice(0, 56)}AAAA`)).toBe(false)
		expect(isValidIdentity('nope')).toBe(false)
	})
})

describe('hex helpers', () => {
	test('round-trip bytes and hex', () => {
		const bytes = new Uint8Array([0, 1, 15, 16, 171, 255])
		expect(bytesToHex(bytes)).toBe('00010f10abff')
		expect(bytesToHex(bytes, true)).toBe('00010F10ABFF')
		expect(Array.from(hexToBytes('00010f10abff'))).toEqual(Array.from(bytes))
		expect(Array.from(hexToBytes('0x00010F10ABFF'))).toEqual(Array.from(bytes))
	})

	test('rejects odd lengths and non-hex characters', () => {
		expect(() => hexToBytes('abc')).toThrow(IdentityCodecError)
		expect(() => hexToBytes('zz')).toThrow(IdentityCodecError)
	})
})

describe('identity hooks', () => {
	test('parsePublicKey uses a custom identity decoder', () => {
		const seen: string[] = []
		const publicKey = parsePublicKey(ZERO_IDENTITY, {
			identityToPublicKey: (identity) => {
				seen.push(identity)
				return new Uint8Array(32).fill(3)
			},
		})
		expect(seen).toEqual([ZERO_IDENTITY])
		expect(publicKey[0]).toBe(3)
	})

	test('parsePublicKey falls back to hex and raw bytes', () => {
		const hex = '01'.repeat(32)
		expect(publicKeyToHex(parsePublicKey(hex))).toBe(hex)
		const raw = new Uint8Array(32).fill(2)
		expect(parsePublicKey(raw)).toBe(raw)
	})

	test('parsePublicKey rejects unsupported strings', () => {
		expect(() => parsePublicKey('not-an-identity')).toThrow(IdentityCodecError)
	})
})
