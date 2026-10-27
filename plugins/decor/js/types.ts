/* Decor Classic attribution: Fiery and Bwlok. Valenced port: LisaExists. GPL-3.0. */

export interface Decoration {
	hash: string
	animated: boolean
	alt: string | null
	authorId: string | null
	reviewed: boolean | null
	presetId: string | null
}

export interface Preset {
	id: string
	name: string
	description: string | null
	decorations: Decoration[]
	authorIds: string[]
}

export interface NewDecoration {
	uri: string
	fileName: string
	fileType: string
	alt: string
}

export interface AvatarDecoration {
	asset: string
	skuId: string
}

export type JsonStorageLike = {
	cache?: Record<string, unknown>
	get(): Promise<Record<string, unknown>>
	set(value: Record<string, unknown>): Promise<void>
}

export type LogLike = {
	warn(message: string): void
	error(message: string): void
	log(message: string): void
}
