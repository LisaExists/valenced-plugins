/* Decor Classic attribution: Fiery and Bwlok. Valenced port: LisaExists. GPL-3.0. */

import { Design } from '@valenced/discord/design'
import { useEffect, useState } from 'react'
import { FlatList, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { errorMessage, getPresets } from '../api'
import { getAuthSnapshot } from '../stores/auth'
import { selectDecoration } from '../stores/currentUser'
import DecorationImage from './DecorationImage'
import CreatedBy from './UserNames'
import type { Decoration, Preset } from '../types'

const styles = StyleSheet.create({
	container: { padding: 16, gap: 12 },
	preset: { padding: 12, gap: 6 },
	row: { gap: 8, paddingVertical: 8 },
	card: { width: 106, alignItems: 'center', padding: 6, gap: 4 },
	error: { padding: 16 },
})

export default function Presets({
	onBack,
	onApplied,
	accountId,
}: {
	onBack: () => void
	onApplied: () => void
	accountId: string
}) {
	const [presets, setPresets] = useState<Preset[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [applying, setApplying] = useState<string | null>(null)

	useEffect(() => {
		let active = true
		void getPresets()
			.then(value => {
				if (active) {
					setPresets(value)
					setError(null)
				}
			})
			.catch(reason => {
				if (active) setError(errorMessage(reason))
			})
			.finally(() => {
				if (active) setLoading(false)
			})
		return () => {
			active = false
		}
	}, [])

	const apply = async (decoration: Decoration) => {
		if (decoration.reviewed === false || applying) return
		const auth = getAuthSnapshot()
		if (auth.accountId !== accountId || !auth.token) {
			setError(
				'Authorization changed. Return to Decor settings and reopen presets.',
			)
			return
		}
		setApplying(decoration.hash)
		setError(null)
		try {
			await selectDecoration(decoration, accountId)
			onApplied()
		} catch (reason) {
			setError(errorMessage(reason))
		} finally {
			setApplying(null)
		}
	}

	return (
		<ScrollView contentContainerStyle={styles.container}>
			<Design.Button
				text="Back to decorations"
				variant="secondary"
				onPress={onBack}
			/>
			<Design.Text variant="heading-lg/bold">Decor presets</Design.Text>
			{loading ? <Design.Text>Loading presets…</Design.Text> : null}
			{error ? (
				<View style={styles.error}>
					<Design.Text>{error}</Design.Text>
					<Design.Button
						text="Retry"
						variant="secondary"
						onPress={() => {
							setLoading(true)
							setError(null)
							void getPresets()
								.then(setPresets)
								.catch(reason => setError(errorMessage(reason)))
								.finally(() => setLoading(false))
						}}
					/>
				</View>
			) : null}
			{!loading && !error && presets.length === 0 ? (
				<Design.Text>No presets are available right now.</Design.Text>
			) : null}
			{presets.map(preset => (
				<Design.Card
					key={preset.id}
					variant="secondary"
					border="faint"
					style={styles.preset}
				>
					<Design.Text variant="heading-md/semibold">{preset.name}</Design.Text>
					{preset.description ? (
						<Design.Text>{preset.description}</Design.Text>
					) : null}
					<CreatedBy ids={preset.authorIds} variant="eyebrow" />
					<FlatList
						horizontal
						data={preset.decorations}
						keyExtractor={item => item.hash}
						contentContainerStyle={styles.row}
						showsHorizontalScrollIndicator={false}
						ListEmptyComponent={
							<Design.Text>This preset has no decorations.</Design.Text>
						}
						renderItem={({ item }) => {
							const eligible = item.reviewed !== false
							return (
								<Pressable
									accessibilityRole="button"
									accessibilityLabel={`${item.alt || 'Unnamed decoration'}${eligible ? '' : ', unavailable'}`}
									disabled={!eligible || applying !== null}
									onPress={() => void apply(item)}
									style={({ pressed }) => [
										styles.card,
										pressed && eligible ? { opacity: 0.72 } : null,
									]}
								>
									<DecorationImage
										decoration={{
											asset: `${item.animated ? 'a_' : ''}${item.hash}`,
											skuId: '100101099111114',
										}}
									/>
									<Design.Text numberOfLines={2}>
										{item.alt || 'Unnamed'}
									</Design.Text>
									{!eligible ? (
										<Design.Text variant="eyebrow">Unavailable</Design.Text>
									) : null}
									{applying === item.hash ? (
										<Design.Text variant="eyebrow">Applying…</Design.Text>
									) : null}
								</Pressable>
							)
						}}
					/>
				</Design.Card>
			))}
		</ScrollView>
	)
}
