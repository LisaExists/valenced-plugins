/*
 * Copyright (c) 2023 Vendicated and contributors.
 * Decor Classic authors: Fiery and Bwlok.
 * Valenced port: LisaExists.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { getUsersDecorations } from '../api'
import type { LogLike } from '../types'

const MAX_BATCH = 50
const CACHE_TTL = 10 * 60_000
const BATCH_DELAY = 180
type CacheItem = { asset: string | null; fetchedAt: number }

const cache = new Map<string, CacheItem>()
const pending = new Set<string>()
const inFlight = new Set<string>()
let timer: ReturnType<typeof setTimeout> | undefined
let generation = 0
let logger: LogLike | undefined
let lookupUser: ((id: string) => any) | undefined
let patchUserData: ((user: any, asset: string | null) => void) | undefined
const retryTimers = new Set<ReturnType<typeof setTimeout>>()

export function configureUserDecorations(
	log: LogLike,
	userLookup: (id: string) => any,
	onResult: (user: any, asset: string | null) => void,
): void {
	logger = log
	lookupUser = userLookup
	patchUserData = onResult
}

export function clearUserDecorations(): void {
	generation++
	cache.clear()
	pending.clear()
	inFlight.clear()
	if (timer) clearTimeout(timer)
	timer = undefined
	for (const retry of retryTimers) clearTimeout(retry)
	retryTimers.clear()
}

export function getUserDecorationAsset(id: string): string | null | undefined {
	const item = cache.get(id)
	if (!item) return undefined
	if (Date.now() - item.fetchedAt > CACHE_TTL) {
		cache.delete(id)
		return undefined
	}
	return item.asset
}

export function setUserDecorationAsset(id: string, asset: string | null): void {
	cache.set(id, { asset, fetchedAt: Date.now() })
}

export function queueUserDecorations(ids: string[]): void {
	let queued = false
	for (const id of ids) {
		if (!/^\d{17,22}$/.test(id)) continue
		const cached = cache.get(id)
		if (cached && Date.now() - cached.fetchedAt <= CACHE_TTL) continue
		if (inFlight.has(id)) continue
		pending.add(id)
		queued = true
	}
	if (!queued || timer) return
	timer = setTimeout(() => {
		timer = undefined
		void drain()
	}, BATCH_DELAY)
}

async function drain(): Promise<void> {
	const ids = [...pending].slice(0, MAX_BATCH)
	for (const id of ids) pending.delete(id)
	if (!ids.length) return
	const requestGeneration = generation
	ids.forEach(id => inFlight.add(id))
	try {
		const response = await getUsersDecorations(ids)
		if (generation !== requestGeneration) return
		for (const id of ids) {
			const asset = Object.hasOwn(response, id) ? response[id] : null
			cache.set(id, { asset, fetchedAt: Date.now() })
			const user = lookupUser?.(id)
			if (user) patchUserData?.(user, asset)
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
			ids.forEach(id => inFlight.delete(id))
			if (pending.size && !timer)
				timer = setTimeout(() => {
					timer = undefined
					void drain()
				}, BATCH_DELAY)
		}
	}
}
