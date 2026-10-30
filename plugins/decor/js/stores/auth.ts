/* Decor Classic attribution: Fiery and Bwlok. Valenced port: LisaExists. GPL-3.0. */

import { useSyncExternalStore } from 'react'
import type { JsonStorageLike, LogLike } from '../types'

type TokenMap = Record<string, string>
type AuthSnapshot = { accountId: string | null; token: string | null }

let tokens: TokenMap = {}
// Other persisted keys (e.g. the decoration cache) that must survive token saves.
let extras: Record<string, unknown> = {}
let snapshot: AuthSnapshot = { accountId: null, token: null }
let storage: JsonStorageLike | undefined
let logger: LogLike | undefined
const listeners = new Set<() => void>()

function publish(): void {
	for (const listener of [...listeners]) listener()
}

function save(): void {
	if (!storage) return
	void storage
		.set({ ...extras, tokens: { ...tokens } })
		.catch(() => logger?.warn('Could not persist Decor authorization state.'))
}

export function configureAuth(
	jsonStorage: JsonStorageLike,
	log: LogLike,
): void {
	storage = jsonStorage
	logger = log
	extras = Object.fromEntries(
		Object.entries(jsonStorage.cache ?? {}).filter(([key]) => key !== 'tokens'),
	)
	const stored = jsonStorage.cache?.tokens
	if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
		tokens = Object.fromEntries(
			Object.entries(stored).filter(
				([id, token]) => id.length > 0 && typeof token === 'string',
			),
		)
	}
	activateAccount(snapshot.accountId)
}

export function readExtra(key: string): unknown {
	return extras[key]
}

export function writeExtra(key: string, value: unknown): void {
	extras[key] = value
	save()
}

export function activateAccount(accountId: string | null | undefined): void {
	const safeId =
		typeof accountId === 'string' && accountId.length > 0 ? accountId : null
	const next = {
		accountId: safeId,
		token: safeId ? (tokens[safeId] ?? null) : null,
	}
	if (next.accountId === snapshot.accountId && next.token === snapshot.token)
		return
	snapshot = next
	publish()
}

export function setTokenForCurrentAccount(
	token: string | null,
	expectedAccountId?: string,
): void {
	const id = snapshot.accountId
	if (!id)
		throw new Error(
			'The Discord account is not ready. Reopen Decor and try again.',
		)
	if (expectedAccountId && expectedAccountId !== id)
		throw new Error(
			'The active Discord account changed. Reopen Decor and try again.',
		)
	if (token === null) delete tokens[id]
	else {
		const normalized = token.trim()
		if (!normalized || normalized.length > 4096)
			throw new Error('Decor returned an invalid authorization token.')
		tokens[id] = normalized
	}
	snapshot = { accountId: id, token: token === null ? null : tokens[id] }
	save()
	publish()
}

export function getAuthSnapshot(): AuthSnapshot {
	return snapshot
}

export function useAuthSnapshot(): AuthSnapshot {
	return useSyncExternalStore(subscribeAuth, getAuthSnapshot, getAuthSnapshot)
}

export function subscribeAuth(listener: () => void): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}
