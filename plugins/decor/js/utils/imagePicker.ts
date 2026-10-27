/* Decor Classic attribution: Fiery and Bwlok. Valenced port: LisaExists. GPL-3.0. */

import { FileModule } from '@valenced/discord/native'
import * as ReactNative from 'react-native'
import type { NewDecoration } from '../types'

type PickedDocument = {
	uri?: unknown
	name?: unknown
	fileName?: unknown
	type?: unknown
	mimeType?: unknown
}

type DocumentPickerOptions = {
	mode: 'open'
	type: string[]
	allowMultiSelection: false
	requestLongTermAccess: false
	allowVirtualFiles: false
	localOnly: false
}

type DocumentPickerModule = {
	pick(options: DocumentPickerOptions): Promise<unknown> | unknown
}

type ReactNativePickerHost = {
	TurboModuleRegistry?: { get(name: string): unknown }
	NativeModules?: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

function hasPickMethod(value: unknown): value is DocumentPickerModule {
	return isRecord(value) && typeof value.pick === 'function'
}

function getDocumentPicker(): DocumentPickerModule | undefined {
	const host = ReactNative as unknown as ReactNativePickerHost

	try {
		const turboModule = host.TurboModuleRegistry?.get?.('RNDocumentPicker')
		if (hasPickMethod(turboModule)) return turboModule
	} catch {

	}

	try {
		const legacyModule = host.NativeModules?.RNDocumentPicker
		if (hasPickMethod(legacyModule)) return legacyModule
	} catch {

	}

	return undefined
}

function isCancellation(error: unknown): boolean {
	if (!isRecord(error)) return /cancel/i.test(String(error ?? ''))
	const code = typeof error.code === 'string' ? error.code : ''
	const message = typeof error.message === 'string' ? error.message : ''
	return /cancel/i.test(code) || /cancel/i.test(message)
}

function errorText(error: unknown): string {
	if (isRecord(error) && typeof error.message === 'string') return error.message
	return typeof error === 'string' ? error : 'Unknown picker error.'
}

function selectedDocument(value: unknown): PickedDocument | undefined {
	const first = Array.isArray(value) ? value[0] : value
	return isRecord(first) ? (first as PickedDocument) : undefined
}

export async function pickPngDecoration(): Promise<NewDecoration | null> {
	const picker = getDocumentPicker()
	if (!picker) {
		throw new Error(
			"This Discord build doesn't expose its RNDocumentPicker module. Update Discord/Valenced to a compatible build and try again.",
		)
	}

	let result: unknown
	try {
		result = await picker.pick({
			mode: 'open',
			type: ['image/png', 'image/apng'],
			allowMultiSelection: false,
			requestLongTermAccess: false,
			allowVirtualFiles: false,
			localOnly: false,
		})
	} catch (error) {
		if (isCancellation(error)) return null
		throw new Error(`Could not open Discord's file picker: ${errorText(error)}`)
	}

	const document = selectedDocument(result)
	if (!document) return null
	if (typeof document.uri !== 'string' || !document.uri.length) {
		throw new Error('Discord’s file picker did not return a readable file URI.')
	}

	const uri = document.uri
	const providedName =
		typeof document.name === 'string'
			? document.name
			: typeof document.fileName === 'string'
				? document.fileName
				: ''
	const providedMime =
		typeof document.type === 'string'
			? document.type.toLowerCase().split(';', 1)[0].trim()
			: typeof document.mimeType === 'string'
				? document.mimeType.toLowerCase().split(';', 1)[0].trim()
				: ''

	const extension = providedName.split('.').pop()?.toLowerCase() ?? ''
	const supportedExtension = extension === 'png' || extension === 'apng'
	const supportedMime = providedMime === 'image/png' || providedMime === 'image/apng'
	const genericMime = !providedMime || providedMime === 'application/octet-stream'

	if (
		(providedMime && !supportedMime && !genericMime) ||
		(!supportedExtension && !supportedMime)
	) {
		throw new Error(
			'Choose a PNG or APNG image. Other image formats are not accepted by Decor.',
		)
	}

	const fileName =
		providedName ||
		`decor-${Date.now()}.${providedMime === 'image/apng' ? 'apng' : 'png'}`

	return { uri, fileName, fileType: 'image/png', alt: '' }
}

export async function uploadUriForPlatform(
	uri: string,
	mimeType: string,
): Promise<string> {
	if (ReactNative.Platform.OS !== 'ios') return uri

	const base64 = await FileModule.readAsset(uri, 'base64')
	if (!base64 || !/^[A-Za-z0-9+/]+=*$/.test(base64))
		throw new Error('Could not read the selected image from iOS storage.')
	return `data:${mimeType};base64,${base64}`
}
