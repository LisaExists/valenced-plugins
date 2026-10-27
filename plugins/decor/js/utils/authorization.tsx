/* Decor Classic attribution: Fiery and Bwlok. Valenced port: LisaExists. GPL-3.0. */

import { AlertActionCreators } from '@valenced/discord/actions'
import { Design } from '@valenced/discord/design'
import { lookupModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
import { lookupModule, lookupModules } from '@valenced/modules/finders'
import { withName, withProps } from '@valenced/modules/finders/filters'
import { AUTHORIZE_URL, CLIENT_ID } from '../constants'
import { getAuthSnapshot, setTokenForCurrentAccount } from '../stores/auth'

type RecordLike = Record<string, any>
type OAuthLocation = { location: string }
type ModalManager = {
	pushModal: (options: RecordLike) => unknown
	popModal: (key: string) => unknown
}

const OAUTH_MODAL_KEY = 'oauth2-authorize'
let cancelPending: (() => void) | undefined

function namespaceOf(value: unknown): RecordLike | undefined {
	if (value && (typeof value === 'object' || typeof value === 'function'))
		return value as RecordLike
	return undefined
}

function namespacesOf(value: unknown): RecordLike[] {
	const namespace = namespaceOf(value)
	const defaultNamespace = namespaceOf(namespace?.default)
	return [namespace, defaultNamespace].filter(
		(value): value is RecordLike => !!value,
	)
}

function isReactComponent(value: unknown): boolean {
	if (typeof value === 'function') return true
	if (!value || typeof value !== 'object') return false
	const tag = (value as RecordLike).$$typeof
	return (
		tag === Symbol.for('react.forward_ref') ||
		tag === Symbol.for('react.memo') ||
		tag === Symbol.for('react.lazy')
	)
}

function hasExportName(value: unknown, name: string, depth = 0): boolean {
	if (depth > 3) return false
	if (typeof value === 'function') {
		const fn = value as unknown as RecordLike
		return fn.name === name || fn.displayName === name
	}
	const candidate = namespaceOf(value)
	if (!candidate) return false
	if (candidate.displayName === name) return true
	return (
		hasExportName(candidate.type, name, depth + 1) ||
		hasExportName(candidate.render, name, depth + 1) ||
		hasExportName(candidate.default, name, depth + 1)
	)
}

function findComponentExport(name: string): unknown {
	const options = { returnNamespace: true } as const
	for (const filter of [withProps(name), withName(name)]) {
		try {
			for (const [moduleExports] of lookupModules(filter, options)) {
				for (const namespace of namespacesOf(moduleExports)) {
					const named = namespace[name]
					if (isReactComponent(named)) return named
					const nestedNamed = namespaceOf(namespace.default)?.[name]
					if (isReactComponent(nestedNamed)) return nestedNamed
					if (
						isReactComponent(namespace.default) &&
						hasExportName(namespace.default, name)
					)
						return namespace.default
					if (
						isReactComponent(moduleExports) &&
						hasExportName(moduleExports, name)
					)
						return moduleExports
				}
			}
		} catch {

		}
	}
	return undefined
}

function findModalManager(): ModalManager | undefined {
	const options = { returnNamespace: true } as const
	let pushFallback: ModalManager['pushModal'] | undefined
	let pushReceiver: RecordLike | undefined
	let popFallback: ModalManager['popModal'] | undefined
	let popReceiver: RecordLike | undefined

	for (const filter of [
		withProps('pushModal', 'popModal'),
		withProps('pushModal'),
	]) {
		try {
			for (const [moduleExports] of lookupModules(filter, options)) {
				for (const owner of namespacesOf(moduleExports)) {
					if (typeof owner.pushModal === 'function' && !pushFallback) {
						pushFallback = owner.pushModal as ModalManager['pushModal']
						pushReceiver = owner
					}
					if (typeof owner.popModal === 'function' && !popFallback) {
						popFallback = owner.popModal as ModalManager['popModal']
						popReceiver = owner
					}
					if (
						typeof owner.pushModal === 'function' &&
						typeof owner.popModal === 'function'
					) {
						return {
							pushModal: (owner.pushModal as ModalManager['pushModal']).bind(
								owner,
							),
							popModal: (owner.popModal as ModalManager['popModal']).bind(
								owner,
							),
						}
					}
				}
			}
		} catch {

		}
	}

	if (!pushFallback || !popFallback) return undefined
	return {
		pushModal: pushFallback.bind(pushReceiver),
		popModal: popFallback.bind(popReceiver),
	}
}

function findOAuthAuthorizeModal(): unknown {
	try {
		const imported = lookupModuleWithImportedPath(
			'modules/oauth2/native/OAuth2AuthorizeModal.tsx',
		)?.[0]
		const candidate = namespaceOf(imported)?.default ?? imported
		if (isReactComponent(candidate)) return candidate
	} catch {

	}
	return findComponentExport('OAuth2AuthorizeModal')
}

function findDiscordHttpClient(): RecordLike | undefined {
	try {
		const matched = lookupModule(withProps('HTTP', 'getAPIBaseURL'))?.[0]
		const namespace = namespaceOf(matched)
		const client = namespace?.HTTP ?? namespaceOf(namespace?.default)?.HTTP
		if (client && typeof client.post === 'function') return client
	} catch {

	}
	return undefined
}

function authorizeDirect(expectedAccountId: string): Promise<void> {
	const HTTP = findDiscordHttpClient()
	if (typeof HTTP?.post !== 'function')
		return Promise.reject(
			new Error(
				"Discord's OAuth modal is unavailable, and its authenticated HTTP helper could not be found in this build.",
			),
		)

	return new Promise<void>((resolve, reject) => {
		const key = `decor-oauth-${Date.now()}`
		let settled = false
		const finish = (error?: Error) => {
			if (settled) return
			settled = true
			if (error) reject(error)
			else resolve()
		}
		const dismiss = () => {
			try {
				AlertActionCreators.dismissAlert(key)
			} catch {

			}
		}
		const cancel = () => {
			dismiss()
			finish(new Error('Authorization was cancelled.'))
		}
		const approve = async () => {
			dismiss()
			try {
				if (getAuthSnapshot().accountId !== expectedAccountId)
					throw new Error(
						'The active Discord account changed. Reopen Decor and try again.',
					)

				const response = await HTTP.post({
					url: '/oauth2/authorize',
					query: {
						client_id: CLIENT_ID,
						response_type: 'code',
						redirect_uri: AUTHORIZE_URL,
						scope: 'identify',
					},
					body: { authorize: true, permissions: '0' },
				})
				const location = response?.body?.location
				if (typeof location !== 'string') {
					const message = response?.body?.message
					const status = response?.status
					throw new Error(
						typeof message === 'string'
							? message
							: `Discord refused Decor authorization${status ? ` (HTTP ${status})` : ''}.`,
					)
				}

				await exchangeDecorCallback(location, expectedAccountId)
				finish()
			} catch (error) {
				finish(
					error instanceof Error
						? error
						: new Error('Decor authorization failed.'),
				)
			}
		}

		AlertActionCreators.openAlert(
			key,
			<Design.AlertModal
				title="Authorize Decor?"
				content="Decor requests the identify scope, which shares your basic Discord identity. If you continue, Discord will authorize Decor and the plugin will exchange the callback directly without opening it in a browser."
				actions={
					<>
						<Design.AlertActionButton
							text="Cancel"
							variant="tertiary"
							onPress={cancel}
						/>
						<Design.AlertActionButton
							text="Authorize"
							variant="primary"
							onPress={() => void approve()}
						/>
					</>
				}
			/>,
		)
	})
}

function callbackQueryParam(location: string, key: string): string | null {
	const queryStart = location.indexOf('?')
	if (queryStart < 0) return null
	const hashStart = location.indexOf('#', queryStart + 1)
	const query = location.slice(
		queryStart + 1,
		hashStart < 0 ? undefined : hashStart,
	)

	for (const part of query.split('&')) {
		if (!part) continue
		const separator = part.indexOf('=')
		const rawKey = separator < 0 ? part : part.slice(0, separator)
		const rawValue = separator < 0 ? '' : part.slice(separator + 1)
		try {
			const decodedKey = decodeURIComponent(rawKey.replace(/\+/g, ' '))
			if (decodedKey !== key) continue
			return decodeURIComponent(rawValue.replace(/\+/g, ' '))
		} catch {

		}
	}
	return null
}

async function exchangeDecorCallback(
	location: string,
	expectedAccountId: string,
	signal?: AbortSignal,
): Promise<void> {
	if (getAuthSnapshot().accountId !== expectedAccountId)
		throw new Error(
			'The active Discord account changed. Reopen Decor and try again.',
		)
	if (typeof location !== 'string' || !location.trim())
		throw new Error('Discord returned an invalid Decor authorization callback.')

	const callbackLocation = location.trim()
	const oauthError = callbackQueryParam(callbackLocation, 'error')
	if (oauthError === 'access_denied')
		throw new Error('Discord authorization was denied.')
	if (oauthError) {
		const description = callbackQueryParam(callbackLocation, 'error_description')
		throw new Error(
			description
				? `Discord authorization failed: ${description}`
				: 'Discord reported an authorization error. Please retry.',
		)
	}
	const code = callbackQueryParam(callbackLocation, 'code')
	if (!code)
		throw new Error(
			'Discord returned a callback without an authorization code. Please retry.',
		)

	let callbackUrl: URL
	try {
		callbackUrl = new URL(callbackLocation)
	} catch {
		throw new Error('Discord returned an invalid Decor authorization callback.')
	}
	const expectedUrl = new URL(AUTHORIZE_URL)
	if (
		callbackUrl.origin !== expectedUrl.origin ||
		callbackUrl.pathname !== expectedUrl.pathname
	)
		throw new Error('Discord returned an unexpected Decor authorization URL.')
	callbackUrl.searchParams.append('client', 'revenge')
	const exchangeUrl = callbackUrl.toString()
	const controller = new AbortController()
	const abortFromParent = () => controller.abort()
	if (signal?.aborted) controller.abort()
	else signal?.addEventListener('abort', abortFromParent, { once: true })
	const timeout = setTimeout(() => controller.abort(), 20_000)
	try {
		let response: Response
		try {
			response = await fetch(exchangeUrl, {
				method: 'GET',
				headers: { Accept: 'text/plain, text/*;q=0.9' },
				cache: 'no-store',
				signal: controller.signal,
			})
		} catch {
			if (controller.signal.aborted)
				throw new Error(
					'Decor authorization timed out. Check your connection and retry.',
				)
			throw new Error(
				'Could not reach the Decor authorization endpoint. Check that Decor is reachable and try again.',
			)
		}
		if (!response.ok)
			throw new Error(`Decor authorization failed (HTTP ${response.status}).`)
		const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
		if (contentType.includes('text/html'))
			throw new Error(
				'Decor returned a web page instead of an authorization token. Check that Decor returned the expected authorization response.',
			)
		let responseText: string
		try {
			responseText = await response.text()
		} catch {
			if (controller.signal.aborted)
				throw new Error(
					'Decor authorization timed out. Check your connection and retry.',
				)
			throw new Error('Decor returned an unreadable authorization response.')
		}
		const token = responseText.trim()
		if (
			!token ||
			token.length > 4096 ||
			/^<!doctype\s+html|^<html\b/i.test(token)
		)
			throw new Error('Decor returned an invalid authorization response.')
		if (getAuthSnapshot().accountId !== expectedAccountId)
			throw new Error(
				'The active Discord account changed. Reopen Decor and try again.',
			)
		setTokenForCurrentAccount(token, expectedAccountId)
	} finally {
		clearTimeout(timeout)
		signal?.removeEventListener('abort', abortFromParent)
	}
}

export async function authorizeWithDecor(
	expectedAccountId: string,
): Promise<void> {
	const OAuth2AuthorizeModal = findOAuthAuthorizeModal()
	const modalManager = isReactComponent(OAuth2AuthorizeModal)
		? findModalManager()
		: undefined

	if (!isReactComponent(OAuth2AuthorizeModal) || !modalManager)
		return authorizeDirect(expectedAccountId)
	if (getAuthSnapshot().accountId !== expectedAccountId)
		throw new Error(
			'The active Discord account changed. Reopen Decor and try again.',
		)

	await new Promise<void>((resolve, reject) => {
		let settled = false
		let callbackStarted = false
		let callbackController: AbortController | undefined

		const pop = () => {
			try {
				modalManager.popModal(OAUTH_MODAL_KEY)
			} catch {

			}
		}
		const finish = (error?: Error, close = false) => {
			if (settled) return
			settled = true
			cancelPending = undefined
			if (error) callbackController?.abort()
			if (close) pop()
			if (error) reject(error)
			else resolve()
		}
		const cancelled = () =>
			finish(new Error('Authorization was cancelled.'), true)
		cancelPending = cancelled

		const callback = async ({ location }: OAuthLocation): Promise<void> => {
			if (settled || callbackStarted) return
			callbackStarted = true
			callbackController = new AbortController()
			try {
				await exchangeDecorCallback(
					location,
					expectedAccountId,
					callbackController.signal,
				)
				finish(undefined, true)
			} catch (error) {
				finish(
					error instanceof Error
						? error
						: new Error('Decor authorization failed.'),
					true,
				)
			}
		}

		try {

			modalManager.pushModal({
				key: OAUTH_MODAL_KEY,
				modal: {
					key: OAUTH_MODAL_KEY,
					modal: OAuth2AuthorizeModal,
					animation: 'slide-up',
					shouldPersistUnderModals: false,
					props: {
						clientId: CLIENT_ID,
						redirectUri: AUTHORIZE_URL,
						scopes: ['identify'],
						responseType: 'code',
						permissions: 0n,
						cancelCompletesFlow: false,
						callback,
						dismissOAuthModal: cancelled,
					},
					closable: true,
				},
			})
		} catch {
			finish(new Error("Could not open Discord's OAuth authorization modal."))
		}
	})
}

export function cancelAuthorization(): void {
	cancelPending?.()
}
