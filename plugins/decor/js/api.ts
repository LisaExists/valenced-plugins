/* Decor Classic attribution: Fiery and Bwlok. Valenced port: LisaExists. GPL-3.0. */

import { API_BASE } from './constants'
import { getAuthSnapshot } from './stores/auth'
import type { Decoration, NewDecoration, Preset } from './types'

const REQUEST_TIMEOUT_MS = 15_000

export class DecorApiError extends Error {
	status?: number

	constructor(message: string, status?: number) {
		super(message)
		this.name = 'DecorApiError'
		this.status = status
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isDecoration(value: unknown): value is Decoration {
	if (!isRecord(value)) return false
	return (
		typeof value.hash === 'string' &&
		/^[a-f\d]{8,128}$/i.test(value.hash) &&
		typeof value.animated === 'boolean' &&
		(value.alt === null || typeof value.alt === 'string') &&
		(value.authorId === null || typeof value.authorId === 'string') &&
		(value.reviewed === null || typeof value.reviewed === 'boolean') &&
		(value.presetId === null || typeof value.presetId === 'string')
	)
}

function parseDecoration(value: unknown): Decoration {
	if (!isDecoration(value))
		throw new DecorApiError('Decor returned invalid decoration data.')
	return value
}

function parseDecorations(value: unknown): Decoration[] {
	if (!Array.isArray(value))
		throw new DecorApiError('Decor returned an invalid decoration list.')
	return value.map(parseDecoration)
}

async function request(
	url: string,
	options: RequestInit = {},
	authenticated = true,
): Promise<Response> {
	const headers = new Headers(options.headers)
	if (authenticated) {
		const token = getAuthSnapshot().token
		if (!token)
			throw new DecorApiError('Authorize with Decor before using this action.')
		headers.set('Authorization', `Bearer ${token}`)
	}
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
	try {
		const response = await fetch(url, {
			...options,
			headers,
			signal: controller.signal,
		})
		if (!response.ok)
			throw new DecorApiError(
				`Decor request failed (HTTP ${response.status}).`,
				response.status,
			)
		return response
	} catch (error) {
		if (error instanceof DecorApiError) throw error
		if (controller.signal.aborted)
			throw new DecorApiError(
				'Decor did not respond in time. Check your connection and retry.',
			)
		throw new DecorApiError(
			'Could not reach Decor. Check your connection and retry.',
		)
	} finally {
		clearTimeout(timeout)
	}
}

async function json<T>(url: string, authenticated = true): Promise<T> {
	const response = await request(url, {}, authenticated)
	try {
		return (await response.json()) as T
	} catch {
		throw new DecorApiError('Decor returned an invalid response.')
	}
}

export async function getUsersDecorations(
	ids?: string[],
): Promise<Record<string, string | null>> {
	if (ids && ids.length === 0) return {}
	const url = new URL(`${API_BASE}/users`)
	if (ids) url.searchParams.set('ids', JSON.stringify([...new Set(ids)]))
	const value = await json<unknown>(url.toString(), false)
	if (!isRecord(value))
		throw new DecorApiError('Decor returned an invalid user decoration list.')
	const result = Object.create(null) as Record<string, string | null>
	for (const [id, hash] of Object.entries(value)) {
		if (!/^\d{17,22}$/.test(id)) continue
		if (typeof hash === 'string' && /^(?:a_)?[a-f\d]{8,128}$/i.test(hash))
			result[id] = hash
		else if (hash === null) result[id] = null
	}
	return result
}

export async function getUserDecorations(): Promise<Decoration[]> {
	return parseDecorations(
		await json<unknown>(`${API_BASE}/users/@me/decorations`),
	)
}

export async function getUserDecoration(): Promise<Decoration | null> {
	const value = await json<unknown>(`${API_BASE}/users/@me/decoration`)
	return value === null ? null : parseDecoration(value)
}

export async function setUserDecoration(
	decoration: Decoration | null,
): Promise<void> {
	const body = new FormData()
	body.append('hash', decoration?.hash ?? 'null')
	const response = await request(`${API_BASE}/users/@me/decoration`, {
		method: 'PUT',
		body,
	})
	await response.text()
}

export async function createUserDecoration(
	decoration: NewDecoration,
): Promise<Decoration> {
	const body = new FormData()
	const filePart = {
		uri: decoration.uri,
		type: decoration.fileType,
		name: decoration.fileName,
	}
	body.append('image', filePart as unknown as Blob)
	body.append('alt', decoration.alt)
	const response = await request(`${API_BASE}/users/@me/decoration`, {
		method: 'PUT',
		body,
	})
	let value: unknown
	try {
		value = await response.json()
	} catch {
		throw new DecorApiError('Decor did not return the uploaded decoration.')
	}
	return parseDecoration(value)
}

export async function deleteDecoration(hash: string): Promise<void> {
	await request(`${API_BASE}/decorations/${encodeURIComponent(hash)}`, {
		method: 'DELETE',
	})
}

export async function getDecoration(hash: string): Promise<Decoration> {
	return parseDecoration(
		await json<unknown>(
			`${API_BASE}/decorations/${encodeURIComponent(hash)}`,
			false,
		),
	)
}

function parsePreset(value: unknown): Preset {
	if (
		!isRecord(value) ||
		typeof value.id !== 'string' ||
		typeof value.name !== 'string' ||
		!(value.description === null || typeof value.description === 'string') ||
		!Array.isArray(value.decorations) ||
		!Array.isArray(value.authorIds) ||
		!value.authorIds.every(id => typeof id === 'string')
	) {
		throw new DecorApiError('Decor returned invalid preset data.')
	}
	return {
		id: value.id,
		name: value.name,
		description: value.description,
		decorations: value.decorations.map(parseDecoration),
		authorIds: value.authorIds,
	}
}

export async function getPresets(): Promise<Preset[]> {
	const value = await json<unknown>(`${API_BASE}/decorations/presets`, false)
	if (!Array.isArray(value))
		throw new DecorApiError('Decor returned an invalid preset list.')
	return value.map(parsePreset)
}

export function errorMessage(error: unknown): string {
	return error instanceof Error
		? error.message
		: 'Something went wrong. Please try again.'
}
