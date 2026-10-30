/*
 * Copyright (c) 2023 Vendicated and contributors.
 * Decor Classic authors: Fiery and Bwlok.
 * Valenced port: LisaExists.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Dispatcher } from '@valenced/discord/common/flux'
import { getStore, onFluxEventDispatched } from '@valenced/discord/flux'
import { getModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { after, instead } from '@valenced/patcher'
import { CDN_BASE, DECOR_SKU_ID } from '../constants'
import {
	activateAccount,
	getAuthSnapshot,
	readExtra,
	writeExtra,
} from '../stores/auth'
import {
	getCurrentUserState,
	refreshCurrentUser,
	resetCurrentUser,
} from '../stores/currentUser'
import {
	clearUserDecorations,
	configureUserDecorationLogger,
	flushUserDecorations,
	getCachedUserDecorationIds,
	getUserDecorationAsset,
	loadPersistedDecorations,
	queueUserDecorations,
	setPersistHandler,
	setUserDecorationAsset,
	subscribeUserDecorationChanges,
} from '../stores/users'
import type { Decoration, LogLike } from '../types'

type AnyRecord = Record<string, unknown>
type FluxPayload = { type: string; [key: string]: unknown }
type Cleanup = (callback: () => void) => void

interface NativeUser {
	id: string
	avatarDecoration?: { asset?: string; skuId?: string } | null
	avatarDecorationData?: { asset?: string; skuId?: string } | null
	[key: string]: unknown
}

interface UserStoreLike {
	getUser(id: string): NativeUser | undefined
	getCurrentUser?(): NativeUser | undefined
}

interface DecorationMediaOptions {
	avatarDecoration?: { asset?: string; skuId?: string } | null
	canAnimate?: boolean
}

interface DecorationMediaResolver {
	getAvatarDecorationURL(options: DecorationMediaOptions): string | undefined
}

function isRecord(value: unknown): value is AnyRecord {
	return value !== null && typeof value === 'object'
}

function isValidUserId(value: unknown): value is string {
	return typeof value === 'string' && /^\d{17,22}$/.test(value)
}

function assetOf(decoration: Decoration): string {
	return (decoration.animated ? 'a_' : '') + decoration.hash
}

/**
 * Use Discord's native user -> avatarDecoration -> media-resolver pipeline.
 * CutoutableAvatarImage and all React Native avatar components remain untouched.
 */
function installNativeAvatarDecoration(
	cleanup: Cleanup,
	logger: LogLike,
): void {
	const nativeDecorations = new Map<string, {
		avatarDecoration: NativeUser['avatarDecoration']
		avatarDecorationData: NativeUser['avatarDecorationData']
	}>()
	const knownUsers = new Map<string, NativeUser>()
	let userStore: UserStoreLike | undefined
	let resolverReady = false
	let disposed = false
	let unpatchUserStore: (() => void)[] = []

	const isValidAsset = (asset: unknown): asset is string =>
		typeof asset === 'string' && /^(?:a_)?[a-f0-9]{8,128}$/i.test(asset)

	const restoreNativeDecoration = (user: NativeUser): void => {
		const snapshot = nativeDecorations.get(user.id)
		if (!snapshot) return
		user.avatarDecoration = snapshot.avatarDecoration
		user.avatarDecorationData = snapshot.avatarDecorationData
	}

	const applyPluginDecoration = (user: NativeUser): NativeUser => {
		if (!isValidUserId(user.id)) return user
		knownUsers.set(user.id, user)

		const asset = getUserDecorationAsset(user.id)
		// An undefined cache entry means "not looked up yet"; never replace a
		// native decoration until Decor has a confirmed selection for this ID.
		if (asset === undefined) return user

		if (asset === null || !isValidAsset(asset)) {
			restoreNativeDecoration(user)
			return user
		}

		// Do not expose Decor's private SKU to Discord until its native URL
		// resolver has been found and safely patched.
		if (!resolverReady) return user

		const current = user.avatarDecoration
		if (current?.skuId !== DECOR_SKU_ID) {
			nativeDecorations.set(user.id, {
				avatarDecoration: user.avatarDecoration,
				avatarDecorationData: user.avatarDecorationData,
			})
		}

		const selected = { asset, skuId: DECOR_SKU_ID }
		if (current?.skuId !== DECOR_SKU_ID || current.asset !== asset) {
			// Mutate only Discord's existing User instance. Spreading/cloning it
			// would drop prototype methods such as getAvatarURL(), which native
			// CutoutableAvatarImage calls during render.
			user.avatarDecoration = selected
			user.avatarDecorationData = selected
		}
		return user
	}

	const dispatchUserUpdate = (user: NativeUser): void => {
		try {
			void Dispatcher.dispatch({ type: 'USER_UPDATE', user }).catch(error => {
				logger.warn(
					'Could not refresh native avatar decoration for user ' + user.id + ': ' +
					(error instanceof Error ? error.message : 'dispatch failed'),
				)
			})
		} catch (error) {
			logger.warn(
				'Could not refresh native avatar decoration for user ' + user.id + ': ' +
				(error instanceof Error ? error.message : 'dispatch failed'),
			)
		}
	}

	const refreshNativeUser = (id: string): void => {
		if (disposed || !resolverReady || !userStore || !isValidUserId(id)) return
		try {
			const user = knownUsers.get(id) ?? userStore.getUser(id)
			if (!user) return
			applyPluginDecoration(user)
			dispatchUserUpdate(user)
		} catch (error) {
			logger.warn(
				'Could not apply native avatar decoration for user ' + id + ': ' +
				(error instanceof Error ? error.message : 'unknown error'),
			)
		}
	}

	cleanup(
		getStore<UserStoreLike>('UserStore', store => {
			if (disposed) return
			userStore = store

			const unpatchGetUser = after(store, 'getUser', user => {
				if (!user) return user
				try {
					return applyPluginDecoration(user)
				} catch (error) {
					logger.warn(
						'Could not decorate UserStore result: ' +
						(error instanceof Error ? error.message : 'unknown error'),
					)
					return user
				}
			})
			unpatchUserStore.push(unpatchGetUser)
			cleanup(unpatchGetUser)

			// You Bar builds may retrieve the signed-in user through this method
			// instead of getUser(currentUserId).
			if (typeof store.getCurrentUser === 'function') {
				const unpatchGetCurrentUser = after(
					store as UserStoreLike & { getCurrentUser(): NativeUser | undefined },
					'getCurrentUser',
					user => {
						if (!user) return user
						try {
							return applyPluginDecoration(user)
						} catch (error) {
							logger.warn(
								'Could not decorate current UserStore result: ' +
								(error instanceof Error ? error.message : 'unknown error'),
							)
							return user
						}
					},
				)
				unpatchUserStore.push(unpatchGetCurrentUser)
				cleanup(unpatchGetCurrentUser)
			}

			if (resolverReady) {
				for (const id of getCachedUserDecorationIds()) refreshNativeUser(id)
			}
			logger.log('Decor native UserStore hooks attached.')
		}),
	)

	cleanup(
		getModules(
			withProps<AnyRecord>('getAvatarDecorationURL', 'default'),
			exports => {
				if (disposed) return
				const namespace = exports as AnyRecord
				const resolver = (
					typeof namespace.getAvatarDecorationURL === 'function'
						? namespace
						: namespace.default
				) as unknown as DecorationMediaResolver | undefined
				if (!resolver || typeof resolver.getAvatarDecorationURL !== 'function') {
					logger.warn('Decor found an invalid native avatar media resolver.')
					return
				}

				const unpatchResolver = instead(
					resolver,
					'getAvatarDecorationURL',
					function (args, original) {
						const options = args[0] as DecorationMediaOptions | undefined
						const decoration = options?.avatarDecoration
						if (decoration?.skuId === DECOR_SKU_ID) {
							if (!isValidAsset(decoration.asset))
								return Reflect.apply(original, this, args)
							const parts = decoration.asset.split('_')
							if (!options?.canAnimate && parts[0] === 'a')
								parts.shift()
							return CDN_BASE + '/' + parts.join('_') + '.png'
						}
						return Reflect.apply(original, this, args)
					},
				)
				cleanup(unpatchResolver)
				resolverReady = true

				for (const id of getCachedUserDecorationIds()) refreshNativeUser(id)
				logger.log('Decor native avatar media resolver attached.')
			},
			{ returnNamespace: true, max: 1 },
		),
	)

	cleanup(subscribeUserDecorationChanges(refreshNativeUser))

	// When Discord sends a genuine USER_UPDATE while a plugin decoration is
	// active, keep the new native values so removing Decor restores the latest
	// server-provided decoration rather than an old snapshot.
	cleanup(
		onFluxEventDispatched<{ user?: NativeUser }>('USER_UPDATE', payload => {
			const user = payload.user
			if (
				user &&
				isValidUserId(user.id) &&
				user.avatarDecoration?.skuId !== DECOR_SKU_ID &&
				(nativeDecorations.has(user.id) || isValidAsset(getUserDecorationAsset(user.id)))
			) {
				nativeDecorations.set(user.id, {
					avatarDecoration: user.avatarDecoration,
					avatarDecorationData: user.avatarDecorationData,
				})
				knownUsers.set(user.id, user)
			}
			return payload
		}),
	)

	cleanup(() => {
		disposed = true
		for (const [id, user] of knownUsers) {
			try {
				restoreNativeDecoration(user)
				dispatchUserUpdate(user)
			} catch {
				logger.warn('Could not restore native avatar decoration for user ' + id + '.')
			}
		}
		knownUsers.clear()
		nativeDecorations.clear()
		unpatchUserStore.forEach(unpatch => unpatch())
		unpatchUserStore = []
		userStore = undefined
		resolverReady = false
	})
}

function messageAuthorIds(payload: AnyRecord): unknown[] {
	const messages = Array.isArray(payload.messages)
		? payload.messages
		: isRecord(payload.messages) && Array.isArray(payload.messages.messages)
			? payload.messages.messages
			: Array.isArray(payload.message)
				? payload.message
				: []
	return messages.map((message: unknown) => {
		if (!isRecord(message)) return undefined
		const nested = isRecord(message.message) ? message.message : undefined
		const author = isRecord(message.author)
			? message.author
			: nested && isRecord(nested.author)
				? nested.author
				: undefined
		return author?.id ?? nested?.authorId
	})
}

const PREFETCH: Record<
	string,
	{ ids: (payload: AnyRecord) => unknown[]; immediate?: boolean }
> = {
	USER_PROFILE_MODAL_OPEN: { ids: payload => [payload.userId], immediate: true },
	USER_PROFILE_FETCH_START: { ids: payload => [payload.userId], immediate: true },
	USER_PROFILE_FETCH_SUCCESS: {
		ids: payload => [
			isRecord(payload.userProfile) && isRecord(payload.userProfile.user)
				? payload.userProfile.user.id
				: isRecord(payload.user)
					? payload.user.id
					: undefined,
		],
		immediate: true,
	},
	LOAD_MESSAGES_SUCCESS: { ids: messageAuthorIds, immediate: true },
	MESSAGE_CREATE: {
		ids: payload => [
			isRecord(payload.message) && isRecord(payload.message.author)
				? payload.message.author.id
				: isRecord(payload.message)
					? payload.message.authorId
					: undefined,
		],
		immediate: true,
	},
	MESSAGE_UPDATE: {
		ids: payload => [
			isRecord(payload.message) && isRecord(payload.message.author)
				? payload.message.author.id
				: isRecord(payload.message)
					? payload.message.authorId
					: undefined,
		],
		immediate: true,
	},
}

export function installDiscordIntegration(
	cleanup: Cleanup,
	logger: LogLike,
): void {
	configureUserDecorationLogger(logger)

	// Hydrate plugin-local cache before attaching the native store hook so
	// cached decorations can be applied as soon as UserStore becomes available.
	loadPersistedDecorations(readExtra('decorations'))
	setPersistHandler(snapshot => writeExtra('decorations', snapshot))
	cleanup(() => {
		flushUserDecorations()
		setPersistHandler(undefined)
	})
	installNativeAvatarDecoration(cleanup, logger)

	cleanup(clearUserDecorations)
	cleanup(() => resetCurrentUser(null))

	const safe =
		(handler: (payload: AnyRecord) => void) =>
		(payload: FluxPayload): FluxPayload => {
			try {
				if (isRecord(payload)) handler(payload)
			} catch (error) {
				logger.warn(
					'Decor event handler failed: ' +
					(error instanceof Error ? error.message : 'unknown error'),
				)
			}
			return payload
		}

	const currentAccountId = (payload?: AnyRecord): string | null => {
		const user = isRecord(payload?.user) ? payload.user : undefined
		const id = user?.id ?? payload?.userId
		return typeof id === 'string' ? id : null
	}

	const syncAccount = (accountId: string | null): void => {
		if (getCurrentUserState().accountId !== accountId)
			resetCurrentUser(accountId)
		activateAccount(accountId)
		if (!accountId) return
		if (getAuthSnapshot().token)
			void refreshCurrentUser().catch(() => undefined)
	}

	cleanup(
		onFluxEventDispatched(
			'CONNECTION_OPEN',
			safe(payload => syncAccount(currentAccountId(payload))),
		),
	)
	for (const [type, spec] of Object.entries(PREFETCH))
		cleanup(
			onFluxEventDispatched(
				type,
				safe(payload => queueUserDecorations(spec.ids(payload), spec.immediate)),
			),
		)

	syncAccount(getCurrentUserState().accountId)
}

export function setCurrentDecorAsset(
	accountId: string,
	decoration: Decoration | null,
): void {
	setUserDecorationAsset(accountId, decoration ? assetOf(decoration) : null)
}
