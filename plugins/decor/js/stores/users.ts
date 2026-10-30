/*
 * Copyright (c) 2023 Vendicated and contributors.
 * Decor Classic authors: Fiery and Bwlok.
 * Valenced port: LisaExists.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useCallback, useSyncExternalStore } from 'react'
import { getUsersDecorations } from '../api'
import type { LogLike } from '../types'

const MAX_BATCH = 50
const MAX_CONCURRENT = 3
// Entries older than this are still served, but are refreshed in the background.
const CACHE_TTL = 10 * 60_000
const BATCH_DELAY = 50
const PERSIST_DELAY = 3_000
const MAX_PERSISTED = 600
const ID_PATTERN = /^\d{17,22}$/
const ASSET_PATTERN = /^(?:a_)?[a-f\d]{8,128}$/i

export type CacheItem = { asset: string | null; fetchedAt: number }

const cache = new Map<string, CacheItem>()
const decorationVersions = new Map<string, number>()
const decorationListeners = new Map<string, Set<() => void>>()
const decorationChangeListeners = new Set<(id: string) => void>()
const pending = new Set<string>()
const inFlight = new Set<string>()
const retryTimers = new Set<ReturnType<typeof setTimeout>>()
let timer: ReturnType<typeof setTimeout> | undefined
let persistTimer: ReturnType<typeof setTimeout> | undefined
let active = 0
let generation = 0
let logger: LogLike | undefined
let persistHandler: ((snapshot: Record<string, string>) => void) | undefined

export function configureUserDecorationLogger(log: LogLike): void {
	logger = log
}

/** Decorated users are saved so they can paint immediately on the next launch. */
export function setPersistHandler(
	handler: ((snapshot: Record<string, string>) => void) | undefined,
): void {
	persistHandler = handler
}

export function loadPersistedDecorations(value: unknown): void {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return
	for (const [id, asset] of Object.entries(value)) {
		if (!ID_PATTERN.test(id)) continue
		if (typeof asset !== 'string' || !ASSET_PATTERN.test(asset)) continue
		// fetchedAt 0 marks it stale, so it is shown now and revalidated soon.
		if (!cache.has(id)) cache.set(id, { asset, fetchedAt: 0 })
	}
}

function schedulePersist(): void {
	if (!persistHandler || persistTimer) return
	persistTimer = setTimeout(flushUserDecorations, PERSIST_DELAY)
}

export function flushUserDecorations(): void {
	if (persistTimer) clearTimeout(persistTimer)
	persistTimer = undefined
	if (!persistHandler) return
	const entries: [string, string][] = []
	for (const [id, item] of cache) if (item.asset) entries.push([id, item.asset])
	persistHandler(Object.fromEntries(entries.slice(-MAX_PERSISTED)))
}

export function subscribeUserDecoration(
	id: string,
	listener: () => void,
): () => void {
	let listeners = decorationListeners.get(id)
	if (!listeners) decorationListeners.set(id, (listeners = new Set()))
	listeners.add(listener)
	return () => {
		listeners!.delete(listener)
		if (!listeners!.size) {
			decorationListeners.delete(id)
			decorationVersions.delete(id)
		}
	}
}

export function subscribeUserDecorationChanges(
	listener: (id: string) => void,
): () => void {
	decorationChangeListeners.add(listener)
	return () => decorationChangeListeners.delete(listener)
}

export function getCachedUserDecorationIds(): string[] {
	return [...cache].filter(([, item]) => item.asset !== null).map(([id]) => id)
}

export function getUserDecorationVersion(id: string): number {
	return decorationVersions.get(id) ?? 0
}

export function getUserDecorationAsset(id: string): string | null | undefined {
	return cache.get(id)?.asset
}

function notifyUserDecoration(id: string): void {
	decorationVersions.set(id, getUserDecorationVersion(id) + 1)
	for (const listener of [...(decorationListeners.get(id) ?? [])]) {
		try {
			listener()
		} catch {}
	}
	for (const listener of [...decorationChangeListeners]) {
		try {
			listener(id)
		} catch {}
	}
}

export function clearUserDecorations(): void {
	for (const id of decorationListeners.keys()) notifyUserDecoration(id)
	generation++
	active = 0
	cache.clear()
	pending.clear()
	inFlight.clear()
	if (timer) clearTimeout(timer)
	timer = undefined
	if (persistTimer) clearTimeout(persistTimer)
	persistTimer = undefined
	for (const retry of retryTimers) clearTimeout(retry)
	retryTimers.clear()
}

/** Cheap enough for Discord's hot render path: one Map lookup, no allocation. */
function remember(id: string, asset: string | null): void {
	const previous = cache.get(id)
	// Re-insert so Map order doubles as recency order for persistence.
	cache.delete(id)
	cache.set(id, { asset, fetchedAt: Date.now() })
	if (asset !== null || previous?.asset) schedulePersist()
	if (previous?.asset !== asset) notifyUserDecoration(id)
}

export function setUserDecorationAsset(id: string, asset: string | null): void {
	remember(id, asset)
}

/**
 * Read a user's Decor selection from plugin-local state. The hook subscribes
 * by user ID; it never reads from or writes to Discord's user/profile objects.
 */
export function useUserDecorationAsset(userId: string | null): string | null | undefined {
	const subscribe = useCallback(
		(listener: () => void) =>
			userId ? subscribeUserDecoration(userId, listener) : () => undefined,
		[userId],
	)
	const getSnapshot = useCallback(
		() => (userId ? getUserDecorationVersion(userId) : 0),
		[userId],
	)
	useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
	return userId ? cache.get(userId)?.asset : null
}

function schedule(delay: number): void {
	if (timer) {
		if (delay > 0) return
		clearTimeout(timer)
	}
	timer = setTimeout(() => {
		timer = undefined
		pump()
	}, delay)
}

export function queueUserDecorations(
	ids: Iterable<unknown>,
	immediate = false,
): void {
	let queued = false
	const now = Date.now()
	for (const id of ids) {
		if (typeof id !== 'string' || !ID_PATTERN.test(id)) continue
		const cached = cache.get(id)
		if (cached && now - cached.fetchedAt <= CACHE_TTL) continue
		if (inFlight.has(id)) continue
		pending.add(id)
		queued = true
	}
	if (queued) schedule(immediate ? 0 : BATCH_DELAY)
}

function pump(): void {
	while (active < MAX_CONCURRENT && pending.size) {
		const ids = [...pending].slice(0, MAX_BATCH)
		for (const id of ids) pending.delete(id)
		active++
		void run(ids, generation)
	}
}

async function run(ids: string[], requestGeneration: number): Promise<void> {
	for (const id of ids) inFlight.add(id)
	try {
		const response = await getUsersDecorations(ids)
		if (generation !== requestGeneration) return
		for (const id of ids) {
			const asset = Object.prototype.hasOwnProperty.call(response, id) ? response[id] : null
			remember(id, asset)
		}
	} catch (error) {
		if (generation === requestGeneration) {
			logger?.warn(
				`Could not fetch a batch of user decorations: ${error instanceof Error ? error.message : 'network error'}`,
			)
			const retry = setTimeout(() => {
				retryTimers.delete(retry)
				if (generation === requestGeneration) queueUserDecorations(ids)
			}, 8_000)
			retryTimers.add(retry)
		}
	} finally {
		if (generation === requestGeneration) {
			active--
			for (const id of ids) inFlight.delete(id)
			if (pending.size) schedule(BATCH_DELAY)
		}
	}
}
