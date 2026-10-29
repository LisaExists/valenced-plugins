/* Decor Classic attribution: Fiery and Bwlok. Valenced port: LisaExists. GPL-3.0. */

import {
	AlertActionCreators,
	ToastActionCreators,
} from '@valenced/discord/actions'
import { Design } from '@valenced/discord/design'
import { Clipboard } from '@valenced/externals/react-native-clipboard'
import { useEffect, useState } from 'react'
import {
	ActivityIndicator,
	FlatList,
	Linking,
	Pressable,
	ScrollView,
	StyleSheet,
	View,
} from 'react-native'
import { errorMessage } from '../api'
import {
	DECOR_SKU_ID,
	PLUGIN_VERSION,
	SOURCE_URL,
} from '../constants'
import { setTokenForCurrentAccount, useAuthSnapshot } from '../stores/auth'
import {
	deleteOwnedDecoration,
	refreshCurrentUser,
	resetCurrentUser,
	selectDecoration,
	useCurrentUserState,
} from '../stores/currentUser'
import CreateDecoration from './CreateDecoration'
import DecorationImage from './DecorationImage'
import Presets from './Presets'
import type { ReactNode } from 'react'
import type { Decoration } from '../types'

const styles = StyleSheet.create({
	root: { flexGrow: 1, paddingBottom: 20 },
	page: { paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
	preview: { alignItems: 'center', gap: 6, padding: 14 },
	horizontal: { paddingHorizontal: 12, gap: 8, alignItems: 'flex-start' },
	tile: {
		width: 112,
		minHeight: 140,
		alignItems: 'center',
		padding: 8,
		gap: 5,
	},
	metadata: { paddingHorizontal: 16, gap: 4 },
	buttons: { flexDirection: 'row', gap: 8 },
	center: { alignItems: 'center', padding: 16, gap: 8 },
	footer: { alignItems: 'center', paddingVertical: 18, gap: 4 },
})

function toast(
	text: string,
	variant: 'default' | 'success' | 'critical' = 'default',
): void {
	try {
		ToastActionCreators.open('decor', { text, variant })
	} catch {

	}
}

function openAlert(title: string, content: string, actions: ReactNode): void {
	AlertActionCreators.openAlert(
		'decor-alert',
		<Design.AlertModal title={title} content={content} actions={actions} />,
	)
}

function DecorationTile({
	decoration,
	selected,
	disabled,
	onPress,
	onLongPress,
}: {
	decoration: Decoration | null
	selected: boolean
	disabled: boolean
	onPress: () => void
	onLongPress?: () => void
}) {
	const label = decoration?.alt || 'Unnamed decoration'
	const unavailable = decoration?.reviewed === false
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={`${decoration ? label : 'None'}${selected ? ', selected' : ''}${unavailable ? ', pending review' : ''}`}
			accessibilityState={{ selected, disabled }}
			disabled={disabled}
			onPress={onPress}
			onLongPress={onLongPress}
			style={({ pressed }) => [styles.tile, pressed ? { opacity: 0.72 } : null]}
		>
			<Design.Card
				variant={selected ? 'primary' : 'secondary'}
				border={selected ? 'strong' : 'faint'}
			>
				{decoration ? (
					<DecorationImage
						decoration={{
							asset: `${decoration.animated ? 'a_' : ''}${decoration.hash}`,
							skuId: DECOR_SKU_ID,
						}}
					/>
				) : (
					<View
						style={{
							width: 92,
							height: 92,
							alignItems: 'center',
							justifyContent: 'center',
						}}
					>
						<Design.Text>None</Design.Text>
					</View>
				)}
			</Design.Card>
			<Design.Text numberOfLines={2}>{decoration ? label : 'None'}</Design.Text>
			{selected ? <Design.Text variant="eyebrow">Selected</Design.Text> : null}
			{unavailable ? (
				<Design.Text variant="eyebrow">Pending review</Design.Text>
			) : null}
		</Pressable>
	)
}

export default function DecorSettings() {
	const auth = useAuthSnapshot()
	const current = useCurrentUserState()
	const [page, setPage] = useState<'main' | 'presets' | 'create'>('main')
	const [routeAccountId, setRouteAccountId] = useState<string | null>(null)
	const [authBusy, setAuthBusy] = useState(false)
	const [actionBusy, setActionBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const authorized = !!auth.token && !!auth.accountId

	useEffect(() => {
		if (!authorized) {
			resetCurrentUser(auth.accountId)
			setError(null)
			return
		}
		if (
			current.accountId === auth.accountId &&
			!current.loaded &&
			!current.loading
		) {
			void refreshCurrentUser().catch(reason => setError(errorMessage(reason)))
		}
	}, [
		authorized,
		auth.accountId,
		auth.token,
		current.accountId,
		current.loaded,
	])

	const authorize = async () => {
		setAuthBusy(true)
		setError(null)
		try {
			if (!auth.accountId)
				throw new Error('Wait for Discord to finish connecting.')
			const { authorizeWithDecor } = await import('../utils/authorization')
			await authorizeWithDecor(auth.accountId)
			toast('Authorized with Decor.', 'success')
		} catch (reason) {
			const message = errorMessage(reason)
			if (message !== 'Authorization was cancelled.') setError(message)
		} finally {
			setAuthBusy(false)
		}
	}

	const logout = () =>
		openAlert(
			'Log out of Decor?',
			'This removes the Decor token stored for this Discord account.',
			<View style={styles.buttons}>
				<Design.AlertActionButton
					text="Cancel"
					variant="tertiary"
					onPress={() => AlertActionCreators.dismissAlert('decor-alert')}
				/>
				<Design.AlertActionButton
					text="Log out"
					variant="destructive"
					onPress={() => {
						try {
							setTokenForCurrentAccount(null, auth.accountId ?? undefined)
							resetCurrentUser(auth.accountId)
							setPage('main')
							toast('Logged out of Decor.')
						} catch (reason) {
							setError(errorMessage(reason))
						}
						AlertActionCreators.dismissAlert('decor-alert')
					}}
				/>
			</View>,
		)

	const onSelect = async (decoration: Decoration | null) => {
		if (!authorized || actionBusy || decoration?.reviewed === false) return
		setActionBusy(true)
		setError(null)
		try {
			await selectDecoration(decoration, auth.accountId ?? undefined)
			toast(
				decoration ? 'Decoration selected.' : 'Decoration removed.',
				'success',
			)
		} catch (reason) {
			setError(errorMessage(reason))
		} finally {
			setActionBusy(false)
		}
	}

	const copyHash = async (decoration: Decoration) => {
		try {
			await Clipboard.setString(decoration.hash)
			toast('Decoration hash copied.', 'success')
		} catch {
			toast(`Hash: ${decoration.hash}`)
		}
		AlertActionCreators.dismissAlert('decor-alert')
	}

	const deleteConfirm = (decoration: Decoration) =>
		openAlert(
			'Delete decoration?',
			`Delete “${decoration.alt || 'Unnamed decoration'}”? This cannot be undone.`,
			<View style={styles.buttons}>
				<Design.AlertActionButton
					text="Cancel"
					variant="tertiary"
					onPress={() => AlertActionCreators.dismissAlert('decor-alert')}
				/>
				<Design.AlertActionButton
					text="Delete"
					variant="destructive"
					onPress={() => {
						AlertActionCreators.dismissAlert('decor-alert')
						if (!authorized || !auth.accountId) return
						setActionBusy(true)
						void deleteOwnedDecoration(decoration, auth.accountId)
							.then(() => {
								toast('Decoration deleted.', 'success')
							})
							.catch(reason => setError(errorMessage(reason)))
							.finally(() => setActionBusy(false))
					}}
				/>
			</View>,
		)

	const showActions = (decoration: Decoration) => {
		const canDelete = decoration.authorId === auth.accountId
		openAlert(
			'Decoration options',
			decoration.alt || 'Choose an action.',
			<View style={styles.buttons}>
				<Design.AlertActionButton
					text="Copy hash"
					variant="secondary"
					onPress={() => void copyHash(decoration)}
				/>
				{canDelete ? (
					<Design.AlertActionButton
						text="Delete"
						variant="destructive"
						onPress={() => {
							AlertActionCreators.dismissAlert('decor-alert')
							deleteConfirm(decoration)
						}}
					/>
				) : null}
				<Design.AlertActionButton
					text="Close"
					variant="tertiary"
					onPress={() => AlertActionCreators.dismissAlert('decor-alert')}
				/>
			</View>,
		)
	}

	if (page === 'presets' && routeAccountId)
		return (
			<Presets
				accountId={routeAccountId}
				onBack={() => setPage('main')}
				onApplied={() => {
					setPage('main')
					toast('Preset decoration selected.', 'success')
				}}
			/>
		)
	if (page === 'create' && routeAccountId)
		return (
			<CreateDecoration
				accountId={routeAccountId}
				onBack={() => setPage('main')}
				onCreated={() =>
					toast('Decoration uploaded and pending review.', 'success')
				}
			/>
		)

	return (
		<ScrollView contentContainerStyle={styles.root}>
			<View style={styles.page}>
				<Design.Text variant="heading-lg/bold">Decor</Design.Text>
				{!authorized ? (
					<>
						<Design.Text>
							Authorize with Decor to browse, select, upload, and manage
							decorations. Tokens are stored separately for each Discord
							account.
						</Design.Text>
						<Design.Button
							text={
								authBusy ? 'Waiting for authorization…' : 'Authorize with Decor'
							}
							variant="primary"
							loading={authBusy}
							disabled={authBusy || !auth.accountId}
							onPress={() => void authorize()}
						/>
					</>
				) : (
					<>
						<Design.Text variant="eyebrow">
							Connected as Discord account {auth.accountId}
						</Design.Text>
						<Design.Card
							variant="secondary"
							border="faint"
							style={styles.preview}
						>
							<DecorationImage
								decoration={
									current.selected
										? {
												asset: `${current.selected.animated ? 'a_' : ''}${current.selected.hash}`,
												skuId: DECOR_SKU_ID,
											}
										: null
								}
							/>
							<Design.Text variant="heading-md/semibold">
								{current.selected?.alt || 'No decoration selected'}
							</Design.Text>
							{current.selected?.authorId ? (
								<Design.Text>
									Created by {current.selected.authorId}
								</Design.Text>
							) : null}
							{current.selected?.reviewed === false ? (
								<Design.Text>Pending review</Design.Text>
							) : null}
						</Design.Card>
						<View style={styles.buttons}>
							<Design.Button
								text="Presets"
								variant="secondary"
								disabled={current.loading || actionBusy}
								onPress={() => {
									setRouteAccountId(auth.accountId)
									setPage('presets')
								}}
							/>
							<Design.Button
								text="Create"
								variant="secondary"
								disabled={
									current.loading ||
									actionBusy ||
									current.decorations.some(item => item.reviewed === false)
								}
								onPress={() => {
									setRouteAccountId(auth.accountId)
									setPage('create')
								}}
							/>
						</View>
						{current.decorations.some(item => item.reviewed === false) ? (
							<Design.Text variant="eyebrow">
								A decoration is waiting for review. You can upload another after
								it is reviewed.
							</Design.Text>
						) : null}
						<View style={styles.buttons}>
							<Design.Button
								text="Refresh"
								variant="tertiary"
								disabled={current.loading || actionBusy}
								onPress={() =>
									void refreshCurrentUser().catch(reason =>
										setError(errorMessage(reason)),
									)
								}
							/>
							<Design.Button
								text="Log out"
								variant="tertiary"
								onPress={logout}
							/>
						</View>
					</>
				)}
				{current.loading ? (
					<View style={styles.center}>
						<ActivityIndicator />
						<Design.Text>Loading decorations…</Design.Text>
					</View>
				) : null}
				{current.error ? <Design.Text>{current.error}</Design.Text> : null}
				{error ? <Design.Text>{error}</Design.Text> : null}
			</View>
			{authorized && !current.loading ? (
				<Design.TableRowGroup
					title="Your decorations"
					description="Tap a reviewed item to select it. Long press for actions."
				>
					<FlatList
						horizontal
						data={current.decorations}
						keyExtractor={item => item.hash}
						contentContainerStyle={styles.horizontal}
						showsHorizontalScrollIndicator={false}
						ListHeaderComponent={
							<DecorationTile
								decoration={null}
								selected={!current.selected}
								disabled={actionBusy}
								onPress={() => void onSelect(null)}
							/>
						}
						ListEmptyComponent={
							<View style={styles.center}>
								<Design.Text>You have no decorations yet.</Design.Text>
							</View>
						}
						renderItem={({ item }) => (
							<DecorationTile
								decoration={item}
								selected={current.selected?.hash === item.hash}
								disabled={actionBusy || item.reviewed === false}
								onPress={() => void onSelect(item)}
								onLongPress={() => showActions(item)}
							/>
						)}
					/>
				</Design.TableRowGroup>
			) : null}
			<View style={styles.footer}>
				<Design.Button
					text="Original Decor source"
					variant="tertiary"
					onPress={() =>
						void Linking.openURL(SOURCE_URL).catch(() =>
							toast('Could not open the source link.'),
						)
					}
				/>
				<Design.Text variant="eyebrow">
					Decor · Version {PLUGIN_VERSION}
				</Design.Text>
				<Design.Text variant="eyebrow">
					Service and CDN provided by Decor
				</Design.Text>
			</View>
		</ScrollView>
	)
}
