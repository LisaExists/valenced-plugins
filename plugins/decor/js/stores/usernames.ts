/* Decor Classic attribution: Fiery and Bwlok. Valenced port: LisaExists. GPL-3.0. */

import { Stores } from '@valenced/discord/flux'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { useEffect, useSyncExternalStore } from 'react'

type AnyRecord = Record<string, any>

const MAX_CONCURRENT = 2

const names = new Map<string, string>()
const requested = new Set<string>()
const queue: string[] = []
const listeners = new Set<() => void>()
let version = 0
let active = 0

function subscribe(listener: () => void): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

function getVersion(): number {
	return version
}

function emit(): void {
	version++
	for (const listener of [...listeners]) listener()
}

function displayNameOf(user: unknown): string | undefined {
	if (!user || typeof user !== 'object') return undefined
	const record = user as AnyRecord
	for (const value of [record.globalName, record.displayName, record.username, record.tag]) {
		if (typeof value === 'string' && value.trim()) return value.trim()
	}
	return undefined
}

function readStore(id: string): string | undefined {
	try {
		return displayNameOf((Stores.UserStore as unknown as AnyRecord).getUser(id))
	} catch {
		return undefined
	}
}

// Discord's user action creators: getUser(id) fetches a user that isn't cached.
// Not cached on failure, so a later call can look again.
function getFetcher(): ((id: string) => Promise<unknown>) | undefined {
	const [found] = lookupModule(withProps('getUser', 'fetchCurrentUser'), {
		returnNamespace: true,
		initialize: false,
	})
	const module = found as AnyRecord | undefined
	for (const target of [module?.default, module]) {
		if (
			target &&
			typeof target.getUser === 'function' &&
			typeof target.fetchCurrentUser === 'function'
		)
			return id => target.getUser(id)
	}
	return undefined
}

async function resolve(id: string): Promise<void> {
	try {
		const fetchUser = getFetcher()
		if (!fetchUser) return
		const name = displayNameOf(await fetchUser(id)) ?? readStore(id)
		if (name) names.set(id, name)
	} catch {
		// Keep the canonical ID mapping intact; a later store update can resolve it.
	} finally {
		requested.delete(id)
		emit()
	}
}

function pump(): void {
	while (active < MAX_CONCURRENT && queue.length) {
		const id = queue.shift() as string
		active++
		void resolve(id).finally(() => {
			active--
			pump()
		})
	}
}

function ensureUsernames(ids: readonly string[]): void {
	let changed = false
	for (const id of ids) {
		if (names.has(id) || requested.has(id)) continue
		const cached = readStore(id)
		if (cached) {
			names.set(id, cached)
			changed = true
			continue
		}
		requested.add(id)
		queue.push(id)
	}
	if (changed) emit()
	pump()
}

/**
 * Resolves canonical Discord IDs to their current display names.
 */
export function useUsernames(ids: readonly string[]): string[] {
	useSyncExternalStore(subscribe, getVersion, getVersion)
	const key = ids.join(',')
	useEffect(() => {
		ensureUsernames(key ? key.split(',') : [])
	}, [key])
	return ids.map(id => names.get(id) ?? readStore(id) ?? 'Loading display name…')
}
