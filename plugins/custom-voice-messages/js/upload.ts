/**
 * Sends a prepared Ogg Opus file as a voice message the way Discord's own mic button does, so
 * Discord handles sign-in, upload negotiation, the nonce, rate limits and failed-send retries.
 *
 * From `modules/voice_messages/native/components/VoiceMessageButton.tsx` (351.3), after a
 * recording stops:
 *
 * ```
 * upload = new CloudUpload({ uri, originalUri, mimeType: 'audio/ogg', filename,
 *                            platform: UploadPlatform.REACT_NATIVE, durationSecs, waveform }, channel.id)
 * MessageActions.sendMessage(channel.id, { content: '', tts: false, invalidEmojis: [], validNonShortcutEmojis: [] },
 *   undefined, { flags: MessageFlags.IS_VOICE_MESSAGE, location: MessageSendLocation.VOICE_MESSAGE,
 *   attachmentsToUpload: [upload], onAttachmentUploadError,
 *   ...MessageActions.getSendMessageOptionsForReply(reply) })
 * deletePendingReply(channelId)
 * ```
 */

import { Dispatcher } from '@valenced/discord/common/flux'
import { Stores } from '@valenced/discord/flux'
import { lookupModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'

const CLOUD_UPLOAD = 'lib/uploader/CloudUpload.tsx'
const UPLOAD_PLATFORM = 'modules/media_uploads/UploadPlatform.tsx'

/** The 351.3 values, for when their modules can't be read. */
const IS_VOICE_MESSAGE = 1 << 13
const VOICE_MESSAGE_LOCATION = 'voice_message'
const REACT_NATIVE_PLATFORM = 0

export interface VoiceFile {
  /** file:// or content:// URI of the Ogg Opus file. */
  uri: string
  filename: string
  durationSecs: number
  waveform: string
}

interface SendActions {
  sendMessage(channelId: string, message: object, ...rest: unknown[]): unknown
  getSendMessageOptionsForReply?(reply: unknown): Record<string, unknown> | undefined
}

interface UploadAttachmentStore {
  getFirstUpload?(channelId: string, draftType: number): { constructor?: unknown } | undefined
  getUploads?(channelId: string, draftType: number): Array<{ constructor?: unknown }> | undefined
}

interface PendingReplyStore {
  getPendingReply?(channelId: string): unknown
}

interface CloudUploadInstance {
  error?: unknown
  status?: unknown
  once?: (event: string, listener: () => void) => void
  on?: (event: string, listener: () => void) => void
}

type CloudUploadClass = new (file: object, channelId: string) => CloudUploadInstance

function loaded(path: string): Record<string, unknown> | undefined {
  try {
    return lookupModuleWithImportedPath<Record<string, unknown>>(path)?.[0]
  } catch {
    return undefined
  }
}

function byProps<T extends Record<string, unknown>>(
  ...props: [keyof T & string, ...Array<keyof T & string>]
): T | undefined {
  try {
    const [first, ...rest] = props
    const mod = lookupModule(withProps<T>(first, ...rest))?.[0] as (T & { default?: T }) | undefined
    return mod && typeof mod[first] !== 'undefined' ? mod : mod?.default
  } catch {
    return undefined
  }
}

/** A channel id no real channel has, so the probe's upload never shows in a message box. */
const PROBE_CHANNEL = '1'
const PROBE_DRAFT = 0
let probed: CloudUploadClass | undefined

/**
 * CloudUpload's module loads lazily (the mic button only requires it when a recording is sent).
 * The attachment store makes `new CloudUpload(...)` for every file added to a draft, so a file is
 * added to a draft of a channel that doesn't exist, the class is read off it, and the draft is
 * cleared again. Nothing is uploaded: the draft is never sent.
 */
function probeCloudUpload(): CloudUploadClass | undefined {
  if (probed) return probed
  const store = Stores.UploadAttachmentStore as UploadAttachmentStore | undefined
  if (typeof Dispatcher?.dispatch !== 'function' || !store) return undefined
  try {
    Dispatcher.dispatch({
      type: 'UPLOAD_ATTACHMENT_ADD_FILES',
      channelId: PROBE_CHANNEL,
      draftType: PROBE_DRAFT,
      files: [{
        id: `custom-voice-messages-probe-${Date.now()}`,
        uri: 'file:///custom-voice-messages-probe.ogg',
        originalUri: 'file:///custom-voice-messages-probe.ogg',
        mimeType: 'audio/ogg',
        filename: 'custom-voice-messages-probe.ogg',
        platform: REACT_NATIVE_PLATFORM,
      }],
    })
    const upload =
      store.getFirstUpload?.(PROBE_CHANNEL, PROBE_DRAFT) ??
      store.getUploads?.(PROBE_CHANNEL, PROBE_DRAFT)?.[0]
    const found = upload?.constructor
    if (typeof found === 'function' && found !== Object) probed = found as CloudUploadClass
  } finally {
    try {
      Dispatcher.dispatch({
        type: 'UPLOAD_ATTACHMENT_CLEAR_ALL_FILES',
        channelId: PROBE_CHANNEL,
        draftType: PROBE_DRAFT,
      })
    } catch {
      // Nothing to clear.
    }
  }
  return probed
}

function cloudUploadClass(): CloudUploadClass | undefined {
  const mod =
    loaded(CLOUD_UPLOAD) ??
    byProps<{ CloudUpload: unknown; CloudUploadStatus: unknown }>('CloudUpload', 'CloudUploadStatus')
  const found =
    mod?.CloudUpload ??
    (mod as { default?: { CloudUpload?: unknown } } | undefined)?.default?.CloudUpload
  return typeof found === 'function' ? found as CloudUploadClass : probeCloudUpload()
}

function constant(group: string, key: string, fallback: unknown): unknown {
  const value = byProps<Record<string, Record<string, unknown> | undefined>>(group)?.[group]?.[key]
  return value !== undefined ? value : fallback
}

function describe(what: string, ...parts: unknown[]): Error {
  const text = parts
    .filter(part => part !== undefined && part !== null && part !== '')
    .map(part => {
      if (part instanceof Error) return part.message
      if (typeof part === 'object') {
        try {
          return JSON.stringify(part)
        } catch {
          return String(part)
        }
      }
      return String(part)
    })
    .join(' · ')
  return new Error(`${what}: ${text || 'no details'}`)
}

/**
 * Hands [file] to Discord's uploader as a voice message for [channelId]. Throws straight away if
 * Discord's uploader or send function can't be found (nothing was sent). Otherwise returns a
 * promise that resolves once Discord has posted the message and rejects on Discord's upload or
 * send error. It never sends again: a failed message stays in the channel with Discord's own
 * retry, so keep the file until the promise resolves.
 */
export function sendVoiceMessage(channelId: string, file: VoiceFile): Promise<void> {
  const CloudUpload = cloudUploadClass()
  if (typeof CloudUpload !== 'function') throw new Error("Couldn't find Discord's uploader.")
  const actions = byProps<SendActions & Record<string, unknown>>('sendMessage', 'receiveMessage')
  if (typeof actions?.sendMessage !== 'function') throw new Error("Couldn't find Discord's send function.")

  const platform = (loaded(UPLOAD_PLATFORM)?.UploadPlatform as { REACT_NATIVE?: unknown } | undefined)
    ?.REACT_NATIVE
  const upload = new CloudUpload(
    {
      uri: file.uri,
      originalUri: file.uri,
      mimeType: 'audio/ogg',
      filename: file.filename,
      platform: typeof platform === 'number' ? platform : REACT_NATIVE_PLATFORM,
      durationSecs: file.durationSecs,
      waveform: file.waveform,
    },
    channelId,
  )

  const reply = (Stores.PendingReplyStore as PendingReplyStore | undefined)?.getPendingReply?.(channelId)
  const replyOptions =
    reply && typeof actions.getSendMessageOptionsForReply === 'function'
      ? actions.getSendMessageOptionsForReply(reply) ?? {}
      : {}

  const delivery = new Promise<void>((resolve, reject) => {
    let settled = false
    const settle = (error?: unknown) => {
      if (settled) return
      settled = true
      if (error === undefined) resolve()
      else reject(error)
    }

    const listen = upload.once ?? upload.on
    if (typeof listen === 'function') {
      listen.call(upload, 'error', () => settle(describe('Upload failed', upload.error, upload.status)))
    }

    const sent = actions.sendMessage(
      channelId,
      { content: '', tts: false, invalidEmojis: [], validNonShortcutEmojis: [] },
      undefined,
      {
        flags: constant('MessageFlags', 'IS_VOICE_MESSAGE', IS_VOICE_MESSAGE),
        location: constant('MessageSendLocation', 'VOICE_MESSAGE', VOICE_MESSAGE_LOCATION),
        attachmentsToUpload: [upload],
        // Discord calls it with (file, code, reason).
        onAttachmentUploadError: (_file: unknown, code: unknown, reason: unknown) =>
          settle(describe('Upload failed', code, reason)),
        ...replyOptions,
      },
    )
    Promise.resolve(sent).then(
      () => settle(),
      error => settle(error ?? new Error('Discord did not send the message.')),
    )
  })

  if (reply) {
    try {
      byProps<{ deletePendingReply?: (channelId: string) => void }>('deletePendingReply')
        ?.deletePendingReply?.(channelId)
    } catch {
      // The reply bar just stays.
    }
  }

  return delivery
}
