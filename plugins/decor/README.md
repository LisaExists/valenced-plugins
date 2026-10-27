# Decor

Decor is a Valenced plugin for browsing, creating, and applying custom Discord profile decorations through the official Decor service.

## Features

- Authorize with your Decor account through Discord OAuth.
- Store authorization tokens separately for each Discord account.
- Browse owned decorations and presets, select a decoration, or clear the current selection.
- Upload PNG/APNG decorations with a preview and the service's review workflow.
- Copy decoration hashes and delete decorations owned by the signed-in account.
- Render Decor CDN decorations and supported raw image URLs on avatars.
- Load decoration metadata for message, typing, profile, and connection views.

## Service endpoints

This plugin uses the official Decor service only:

- API and OAuth exchange: `https://decor.fieryflames.dev/api`
- Decoration CDN: `https://decorcdn.fieryflames.dev`

It does not provide or configure an alternate service. Authenticated requests send the current account's Decor bearer token only to Decor API routes. Tokens are stored in Valenced's per-plugin JSON storage, keyed by Discord user ID. Logging out removes the token for the active account.

## Authorization and image selection

The plugin uses Discord's OAuth authorize modal when available. It intercepts the redirect and requests the returned callback from the official Decor `/api/authorize` endpoint in-process, appending the `client=revenge` parameter expected by Decor's existing protocol. The callback's origin and path are checked before the request is made. A guarded authenticated-request fallback is available for builds where the modal stack cannot be resolved.

Image selection uses Discord's `RNDocumentPicker` native module when exposed by the client. PNG and APNG uploads are supported. The native integration is guarded and reports a compatibility error if the client does not expose the picker.

## Compatibility

- Valenced plugin API: `>=1 <2`
- Discord: `>=352.0`

The plugin uses a small number of Discord internal modules for OAuth, media selection, and avatar-decoration rendering. These can change between Discord releases, so test those paths on the target client when updating the minimum Discord version. Runtime lookups are guarded; missing integration points should not prevent the rest of Discord from starting.

## Build

From the root of `Valenced/valenced-community-plugins`:

```sh
bun install
bun run build decor
./gradlew packageDecor
```

The packaged plugin is written to `build/dist/lisaexists.decor@1.0.0.zip`.

## Credits and license

Original Decor authors: Fiery and Bwlok. Valenced port: LisaExists. This port retains the original GPL-3.0 license; see [LICENSE](./LICENSE).
