/* Decor Classic attribution: Fiery and Bwlok. Valenced port: LisaExists. GPL-3.0. */

import { Design } from '@valenced/discord/design'
import { useUsernames } from '../stores/usernames'

export default function CreatedBy({
	ids,
	variant,
}: {
	ids: readonly string[]
	variant?: 'eyebrow'
}) {
	const names = useUsernames(ids)
	if (!names.length) return null
	return <Design.Text variant={variant}>Created by {names.join(', ')}</Design.Text>
}
