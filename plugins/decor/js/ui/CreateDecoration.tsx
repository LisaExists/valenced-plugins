/* Decor Classic attribution: Fiery and Bwlok. Valenced port: LisaExists. GPL-3.0. */

import { Design } from '@valenced/discord/design'
import { useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { errorMessage } from '../api'
import { getAuthSnapshot } from '../stores/auth'
import { createDecoration } from '../stores/currentUser'
import { pickPngDecoration, uploadUriForPlatform } from '../utils/imagePicker'
import DecorationImage from './DecorationImage'
import type { NewDecoration } from '../types'

const styles = StyleSheet.create({
	container: { padding: 16, gap: 12 },
	preview: { alignItems: 'center', paddingVertical: 16 },
	buttons: { flexDirection: 'row', gap: 8 },
	note: { opacity: 0.8 },
})

export default function CreateDecoration({
	onBack,
	onCreated,
	accountId,
}: {
	onBack: () => void
	onCreated: () => void
	accountId: string
}) {
	const [asset, setAsset] = useState<NewDecoration | null>(null)
	const [name, setName] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [complete, setComplete] = useState(false)

	const selectImage = async () => {
		setError(null)
		try {
			const picked = await pickPngDecoration()
			if (picked) {
				picked.alt = name.trim()
				setAsset(picked)
			}
		} catch (reason) {
			setError(errorMessage(reason))
		}
	}

	const submit = async () => {
		if (!asset || !name.trim() || busy) return
		setBusy(true)
		setError(null)
		try {
			const auth = getAuthSnapshot()
			if (auth.accountId !== accountId || !auth.token)
				throw new Error(
					'Authorization changed. Return to Decor settings and reopen this screen.',
				)
			const uri = await uploadUriForPlatform(asset.uri, asset.fileType)
			await createDecoration({ ...asset, uri, alt: name.trim() }, accountId)
			setComplete(true)
			onCreated()
		} catch (reason) {
			setError(errorMessage(reason))
		} finally {
			setBusy(false)
		}
	}

	return (
		<ScrollView
			contentContainerStyle={styles.container}
			keyboardShouldPersistTaps="handled"
		>
			<Design.Button
				text="Back to decorations"
				variant="secondary"
				disabled={busy}
				onPress={onBack}
			/>
			<Design.Text variant="heading-lg/bold">Create a decoration</Design.Text>
			<View style={styles.preview}>
				<DecorationImage
					decoration={asset ? { asset: asset.uri, skuId: '11497119' } : null}
				/>
				<Design.Text>
					{asset ? asset.fileName : 'Choose a PNG or APNG image'}
				</Design.Text>
			</View>
			<Design.Button
				text={asset ? 'Choose a different image' : 'Select image'}
				variant="secondary"
				disabled={busy}
				onPress={() => void selectImage()}
			/>
			<Design.TextInput
				label="Name / alternate text"
				value={name}
				onChange={setName}
				maxLength={80}
				placeholder="Companion Cube"
				isDisabled={busy}
			/>
			<Design.Text style={styles.note}>
				PNG and APNG files are accepted. The upload is held for review before it
				becomes selectable.
			</Design.Text>
			{error ? <Design.Text>{error}</Design.Text> : null}
			{complete ? (
				<Design.Text>
					Upload complete. Your decoration is pending review.
				</Design.Text>
			) : null}
			<View style={styles.buttons}>
				<Design.Button
					text="Cancel"
					variant="tertiary"
					disabled={busy}
					onPress={onBack}
				/>
				<Design.Button
					text="Upload"
					variant="primary"
					disabled={!asset || !name.trim() || busy || complete}
					loading={busy}
					onPress={() => void submit()}
				/>
			</View>
		</ScrollView>
	)
}
