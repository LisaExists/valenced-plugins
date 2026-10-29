/*
 * Decor Classic authors: Fiery and Bwlok.
 * Valenced port: LisaExists.
 * SPDX-License-Identifier: GPL-3.0
 */

import {
	installDiscordIntegration,
	setCurrentDecorAsset,
} from './runtime/discord'
import { configureAuth, getAuthSnapshot } from './stores/auth'
import { getCurrentUserState, subscribeCurrentUser } from './stores/currentUser'
import DecorSettings from './ui/DecorSettings'
import { cancelAuthorization } from './utils/authorization'
import type { JsonStorageLike, LogLike } from './types'

type PersistedAuth = { tokens: Record<string, string> }

export default plugin<{ jsonStorage: PersistedAuth }>({
	jsonStorage: { load: true, default: { tokens: {} } },

	async start({ cleanup, jsonStorage, logger }) {
		const storage = jsonStorage as unknown as JsonStorageLike
		const log = logger as unknown as LogLike
		try {
			await storage.get()
		} catch {
			log.warn(
				'Could not load stored Decor account tokens; authorization can be repeated.',
			)
		}
		configureAuth(storage, log)

		installDiscordIntegration(cleanup, log)
		cleanup(cancelAuthorization)
		const syncSelectedDecoration = () => {
			const current = getCurrentUserState()
			const auth = getAuthSnapshot()
			if (
				current.loaded &&
				current.accountId &&
				current.accountId === auth.accountId
			) {
				setCurrentDecorAsset(current.accountId, current.selected)
			}
		}
		cleanup(subscribeCurrentUser(syncSelectedDecoration))
		syncSelectedDecoration()
		log.log('Decor started.')
	},

	SettingsComponent() {
		return <DecorSettings />
	},
})
