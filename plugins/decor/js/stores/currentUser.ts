/* Decor Classic attribution: Fiery and Bwlok. Valenced port: LisaExists. GPL-3.0. */

import { useSyncExternalStore } from 'react'
import {
	createUserDecoration,
	deleteDecoration as deleteFromService,
	getUserDecoration,
	getUserDecorations,
	setUserDecoration,
} from '../api'
import type { Decoration, NewDecoration } from '../types'

export interface CurrentUserState {
	accountId: string | null
	decorations: Decoration[]
	selected: Decoration | null
	loading: boolean
	loaded: boolean
	error: string | null
}

let state: CurrentUserState = {
	accountId: null,
	decorations: [],
	selected: null,
	loading: false,
	loaded: false,
	error: null,
}
let operation = 0
const listeners = new Set<() => void>()

function update(patch: Partial<CurrentUserState>): void {
	state = { ...state, ...patch }
	for (const listener of [...listeners]) listener()
}

export function getCurrentUserState(): CurrentUserState {
	return state
}
export function subscribeCurrentUser(listener: () => void): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}
export function useCurrentUserState(): CurrentUserState {
	return useSyncExternalStore(
		subscribeCurrentUser,
		getCurrentUserState,
		getCurrentUserState,
	)
}

export function resetCurrentUser(accountId: string | null): void {
	operation++
	update({
		accountId,
		decorations: [],
		selected: null,
		loading: false,
		loaded: false,
		error: null,
	})
}

export async function refreshCurrentUser(): Promise<void> {
	const accountId = state.accountId
	if (!accountId) return
	const requestId = ++operation
	update({ loading: true, error: null })
	try {
		const [decorations, selected] = await Promise.all([
			getUserDecorations(),
			getUserDecoration(),
		])
		if (requestId !== operation || accountId !== state.accountId) return
		update({ decorations, selected, loading: false, loaded: true, error: null })
	} catch (error) {
		if (requestId !== operation || accountId !== state.accountId) return
		update({
			loading: false,
			loaded: false,
			error:
				error instanceof Error
					? error.message
					: 'Could not load your decorations.',
		})
		throw error
	}
}

export async function selectDecoration(
	decoration: Decoration | null,
	expectedAccountId?: string,
): Promise<void> {
	if (!state.accountId)
		throw new Error('Wait for your Discord account to finish connecting.')
	const accountId = state.accountId
	if (expectedAccountId && expectedAccountId !== accountId)
		throw new Error(
			'The active Discord account changed. Reopen Decor and try again.',
		)
	const requestId = ++operation
	update({ loading: true, error: null })
	try {
		await setUserDecoration(decoration)
		if (requestId !== operation || accountId !== state.accountId) return
		update({ selected: decoration, loading: false, error: null })
	} catch (error) {
		if (requestId === operation && accountId === state.accountId)
			update({
				loading: false,
				error:
					error instanceof Error
						? error.message
						: 'Could not update your decoration.',
			})
		throw error
	}
}

export async function createDecoration(
	decoration: NewDecoration,
	expectedAccountId?: string,
): Promise<Decoration> {
	if (!state.accountId)
		throw new Error('Wait for your Discord account to finish connecting.')
	if (expectedAccountId && expectedAccountId !== state.accountId)
		throw new Error(
			'The active Discord account changed. Reopen Decor and try again.',
		)
	if (state.decorations.some(item => item.reviewed === false))
		throw new Error('You already have a decoration pending review.')
	const accountId = state.accountId
	const requestId = ++operation
	update({ loading: true, error: null })
	try {
		const created = await createUserDecoration(decoration)
		if (requestId === operation && accountId === state.accountId)
			update({
				decorations: [...state.decorations, created],
				loading: false,
				error: null,
			})
		return created
	} catch (error) {
		if (requestId === operation && accountId === state.accountId)
			update({
				loading: false,
				error:
					error instanceof Error
						? error.message
						: 'Upload failed. Check the file and retry.',
			})
		throw error
	}
}

export async function deleteOwnedDecoration(
	decoration: Decoration,
	accountId: string,
): Promise<void> {
	if (decoration.authorId !== accountId)
		throw new Error('You can only delete decorations you created.')
	if (state.accountId !== accountId)
		throw new Error('The active Discord account changed. Try again.')
	const requestId = ++operation
	update({ loading: true, error: null })
	try {
		await deleteFromService(decoration.hash)
		if (requestId !== operation || state.accountId !== accountId) return
		let selectionError: string | null = null
		if (state.selected?.hash === decoration.hash) {
			try {
				await setUserDecoration(null)
			} catch {
				selectionError =
					'The decoration was deleted, but Decor could not clear the selected decoration. Refresh to sync it.'
			}
		}
		if (requestId !== operation || state.accountId !== accountId) return
		update({
			decorations: state.decorations.filter(
				item => item.hash !== decoration.hash,
			),
			selected:
				state.selected?.hash === decoration.hash ? null : state.selected,
			loading: false,
			error: selectionError,
		})
	} catch (error) {
		if (requestId === operation && state.accountId === accountId)
			update({
				loading: false,
				error:
					error instanceof Error
						? error.message
						: 'Could not delete the decoration.',
			})
		throw error
	}
}
