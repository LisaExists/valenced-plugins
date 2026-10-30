/* Decor Classic attribution: Fiery and Bwlok. Valenced port: LisaExists. GPL-3.0. */

import { Image, StyleSheet, View } from 'react-native'
import { CDN_BASE, DECOR_SKU_ID, RAW_SKU_ID } from '../constants'
import type { AvatarDecoration } from '../types'

const styles = StyleSheet.create({
	frame: {
		width: 92,
		height: 92,
		alignItems: 'center',
		justifyContent: 'center',
		overflow: 'hidden',
	},
	image: { width: 92, height: 92 },
})

export function getDecorationUri(
	decoration: AvatarDecoration | null | undefined,
): string | undefined {
	if (!decoration || typeof decoration.asset !== 'string') return undefined
	if (decoration.skuId === DECOR_SKU_ID) {
		let asset = decoration.asset
		if (!/^(?:a_)?[a-f\d]{8,128}$/i.test(asset)) return undefined
		if (asset.startsWith('a_')) asset = asset.slice(2)
		return `${CDN_BASE}/${asset}.png`
	}
	if (
		decoration.skuId === RAW_SKU_ID &&
		/^(?:https?:|file:|content:|data:)/i.test(decoration.asset)
	)
		return decoration.asset
	return undefined
}

export default function DecorationImage({
	decoration,
}: {
	decoration: AvatarDecoration | null
}) {
	const uri = getDecorationUri(decoration)
	return (
		<View style={styles.frame}>
			{uri ? (
				<Image source={{ uri }} style={styles.image} resizeMode="contain" />
			) : null}
		</View>
	)
}
