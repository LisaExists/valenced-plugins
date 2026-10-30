import { ActionSheetActionCreators, ToastActionCreators } from '@valenced/discord/actions'
import { Tokens } from '@valenced/discord/common/tokens'
import { Design } from '@valenced/discord/design'
import { Clipboard } from '@valenced/externals/react-native-clipboard'
import { Stores } from '@valenced/discord/flux'
import {
  getModuleWithImportedPath,
} from '@valenced/discord/utils/modules/finders'
import { getModules } from '@valenced/modules/finders'
import { withName, withProps } from '@valenced/modules/finders/filters'
import { callNativeMethod } from '@valenced/modules/native'
import { after, instead } from '@valenced/patcher'
import { getErrorStack } from '@valenced/utils/error'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'
import { proxify } from '@valenced/utils/proxy'
import { useEffect, useRef, useState } from 'react'
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  useWindowDimensions,
  View,
} from 'react-native'
import type {
  FC,
  MemoExoticComponent,
  ReactElement,
  ReactNode,
} from 'react'
import SettingsComponent from './settings'

const PLUGIN_ID = 'lisaexists.custom-voice-messages'
const VOICE_MESSAGE_FLAG = 1 << 13

interface PickedAudio {
  uri: string
  displayName: string
  sizeBytes?: number | null
}

interface PreparedAudio {
  uri: string
  filename: string
  mimeType: 'audio/ogg'
  size: number
  durationSecs: number
  waveform: string
}

interface ConversionProgress {
  stage?: unknown
  progress?: unknown
}

// CustomVoiceMessages registers these bridge methods from its Android plugin.
// Declare their exact Valenced NativeMethods shapes so `lint:types` can validate
// calls to this plugin's own native bridge instead of rejecting dynamic names.
declare module '@valenced/modules/native' {
  interface NativeMethods {
    'lisaexists.custom-voice-messages.getPrepareProgress': [[], ConversionProgress | null]
  }
}

const PROGRESS_TOAST_KEY = 'CUSTOM_VOICE_MESSAGES_PROGRESS'
const CONVERSION_PROGRESS_POLL_MS = 500
const PROGRESS_TOAST_MAX_DURATION_MS = 24 * 60 * 60 * 1_000
const FINAL_PROGRESS_TOAST_DURATION_MS = 3_200

type ToastVariant = 'default' | 'success' | 'critical'

interface ProgressToastState {
  text: string
  variant: ToastVariant
}

let progressToastOpen = false
let progressToastCloseTimer: ReturnType<typeof setTimeout> | undefined
let progressToastState: ProgressToastState = {
  text: 'Preparing voice message…',
  variant: 'default',
}
const progressToastListeners = new Set<() => void>()

interface TokenModule {
  getToken(): string
}

interface ApiBaseModule {
  getAPIBaseURL(): string
  del: (...args: unknown[]) => unknown
}

interface SelectedChannelStore {
  getChannelId(): string | null | undefined
}

interface Attachment {
  url?: string
  filename?: string
  content_type?: string
  waveform?: string
  duration_secs?: number
}

interface MessageLike {
  id?: string
  channel_id?: string
  channelId?: string
  flags?: number
  attachments?: Attachment[]
}

interface MessageActionSheetProps {
  message?: MessageLike
  channelId?: string
  channel?: { id?: string }
}

type LongPressMessageActionSheet = FC<MessageActionSheetProps>
type ModuleWithDefault = { default: LongPressMessageActionSheet }
type MutableElement = {
  type: unknown
  props: { children?: ReactNode; [key: string]: unknown }
}

const { ActionSheet, ActionSheetRow, Text: DesignText, Button: DesignButton } = Design
let tokenModule: TokenModule | undefined
let apiBase = 'https://discord.com/api/v9'
let reportPluginError: (error: unknown) => void = error => console.error('[CustomVoiceMessages]', error)

let requestVoiceMessageFlow: ((channelId: string) => boolean) | undefined

export default plugin({
  start(api) {
    const { cleanup, plugin } = api
    reportPluginError = error => plugin.reportError(error)
    cleanup(
      getModules(withProps<TokenModule>('getToken'), exports => {
        tokenModule = exports
      }),
      getModules(withProps<ApiBaseModule>('getAPIBaseURL', 'del'), exports => {
        apiBase = normalizeApiBase(exports.getAPIBaseURL())
      }),
      getModuleWithImportedPath<{ default: MemoExoticComponent<FC> }>(
        'modules/chat_input/native/action_buttons/ChatInputActions.tsx',
        ({ default: ChatInputActions }) => {
          cleanup(
            after(ChatInputActions, 'type', tree => {
              const withVoiceMessageOption = addVoiceMessageContextMenuOption(tree as ReactNode)
              return addVoiceMessageModalHost(withVoiceMessageOption)
            }),
          )
        },
      ),
      patchMessageActionSheet(error => reportPluginError(error)),
      () => {
        tokenModule = undefined
        requestVoiceMessageFlow = undefined
        reportPluginError = error => console.error('[CustomVoiceMessages]', error)
      },
    )
  },
  SettingsComponent,
})

function addVoiceMessageModalHost(tree: ReactNode): ReactElement {
  return (
    <>
      {tree}
      <VoiceMessageFlowHost key="lisaexists-custom-voice-message-flow-host" />
    </>
  )
}

function VoiceMessageFlowHost() {
  const [confirmation, setConfirmation] = useState<PickedAudio | null>(null)
  const styles = useVoiceMessageModalStyles()
  const { width: viewportWidth } = useWindowDimensions()
  const busy = useRef(false)
  const pendingConfirmation = useRef<((confirmed: boolean) => void) | null>(null)
  const runFlowRef = useRef<(channelId: string) => boolean>(() => false)

  const finishConfirmation = (confirmed: boolean) => {
    const resolve = pendingConfirmation.current
    pendingConfirmation.current = null
    setConfirmation(null)
    resolve?.(confirmed)
  }

  const confirmVoiceMessage = (audio: PickedAudio): Promise<boolean> =>
    new Promise(resolve => {
      pendingConfirmation.current = resolve
      setConfirmation(audio)
    })

  const runFlow = async (channelId: string) => {
    try {
      const picked = await callNativeMethod(`${PLUGIN_ID}.pickAudio`, []) as PickedAudio | null
      if (!picked) return

      const shouldSend = await confirmVoiceMessage(picked)
      if (!shouldSend) return

      showVoiceMessageToast(PROGRESS_TOAST_KEY, 'Preparing audio for your voice message…')
      const prepared = await prepareAudioWithProgress(picked.uri)

      let sendResult: { verifiedVoiceMessage: boolean }
      try {
        if (!prepared) throw new Error('The audio converter returned no prepared file.')
        validatePreparedAudio(prepared)
        showVoiceMessageToast(PROGRESS_TOAST_KEY, 'Audio prepared. Uploading voice message…')
        let lastUploadBucket = -10
        let lastUploadToastAt = 0
        sendResult = await uploadAndSendVoiceMessage(channelId, prepared, fraction => {
          const percent = Math.round(Math.max(0, Math.min(1, fraction)) * 100)
          const bucket = Math.floor(percent / 10) * 10
          const heartbeatDue = Date.now() - lastUploadToastAt >= 2_000
          if (bucket >= lastUploadBucket + 10 || heartbeatDue) {
            lastUploadBucket = bucket
            lastUploadToastAt = Date.now()
            showVoiceMessageToast(PROGRESS_TOAST_KEY, `Uploading voice message · ${bucket}%`)
          }
        })
      } finally {
        if (prepared && typeof prepared.uri === 'string') {
          await callNativeMethod(`${PLUGIN_ID}.cleanupPrepared`, [prepared.uri]).catch(error => {
            reportPluginError(new Error(`Could not clean up the temporary converted audio file: ${getErrorStack(error)}`))
          })
        }
      }

      if (sendResult.verifiedVoiceMessage) {
        showVoiceMessageToast(PROGRESS_TOAST_KEY, 'Voice message sent.', 'success', FINAL_PROGRESS_TOAST_DURATION_MS)
      } else {
        showVoiceMessageToast(PROGRESS_TOAST_KEY, 'Discord did not confirm the voice-message metadata. Check the channel before retrying.', 'critical', FINAL_PROGRESS_TOAST_DURATION_MS)
      }
    } catch (error) {
      reportPluginError(new Error(`Could not send voice message: ${getErrorStack(error)}`))
      showVoiceMessageToast(PROGRESS_TOAST_KEY, `Could not send voice message: ${getErrorMessage(error)}`, 'critical', 5_000)
    } finally {
      busy.current = false
    }
  }

  runFlowRef.current = channelId => {
    if (busy.current) return false
    busy.current = true
    void runFlow(channelId)
    return true
  }

  useEffect(() => {
    const handler = (channelId: string) => runFlowRef.current(channelId)
    requestVoiceMessageFlow = handler
    return () => {
      if (requestVoiceMessageFlow === handler) requestVoiceMessageFlow = undefined
      const resolve = pendingConfirmation.current
      pendingConfirmation.current = null
      resolve?.(false)
    }
  }, [])

  const useStackedActions = viewportWidth < 380

  return (
    <Modal
      animationType="fade"
      transparent
      statusBarTranslucent
      visible={confirmation !== null}
      onRequestClose={() => {
        if (confirmation !== null) finishConfirmation(false)
      }}
    >
      <Pressable
        style={styles.backdrop}
        onPress={() => {
          if (confirmation !== null) finishConfirmation(false)
        }}
        accessibilityRole="button"
        accessibilityLabel="Cancel voice message confirmation"
      >
        <Pressable style={styles.panel} onPress={() => {}}>
          <View style={styles.accentBar} />
          <ScrollView
            bounces={false}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.panelContent}
          >
            {confirmation !== null ? (
              <>
                <View style={styles.headerRow}>
                  <View style={styles.iconTile}>
                    <DesignText variant="heading-lg/semibold" color="text-strong" style={styles.musicGlyph}>♫</DesignText>
                  </View>
                  <View style={styles.headerCopy}>
                    <DesignText variant="heading-lg/semibold" color="text-strong">
                      Send as a voice message?
                    </DesignText>
                    <DesignText variant="text-sm/normal" color="text-muted">
                      Convert the selected audio and send it as a native Discord voice message.
                    </DesignText>
                  </View>
                </View>

                <View style={styles.fileCard}>
                  <View style={styles.fileIconTile}>
                    <DesignText variant="heading-lg/semibold" color="text-strong" style={styles.fileGlyph}>♫</DesignText>
                  </View>
                  <View style={styles.fileCopy}>
                    <DesignText variant="text-md/semibold" color="text-strong" numberOfLines={2}>
                      {confirmation.displayName}
                    </DesignText>
                    <DesignText variant="text-xs/normal" color="text-muted">
                      Audio file · converted to Opus
                    </DesignText>
                  </View>
                </View>

                <View style={styles.infoRow}>
                  <View style={styles.infoDot} />
                  <DesignText variant="text-sm/normal" color="text-muted" style={styles.infoText}>
                    Your original file will not be changed.
                  </DesignText>
                </View>

                <View style={[styles.actions, useStackedActions && styles.actionsStacked]}>
                  <DesignButton
                    text="Cancel"
                    variant="secondary"
                    size="lg"
                    style={useStackedActions ? styles.actionButtonStacked : styles.actionButton}
                    onPress={() => finishConfirmation(false)}
                  />
                  <DesignButton
                    text="Convert and send"
                    variant="primary"
                    size="lg"
                    style={useStackedActions ? styles.actionButtonStacked : styles.actionButton}
                    onPress={() => finishConfirmation(true)}
                  />
                </View>
              </>
            ) : null}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

function getActiveChannelId(): string | undefined {
  const stores = Stores as unknown as Record<string, unknown>
  const selectedChannelStore = stores.SelectedChannelStore as SelectedChannelStore | undefined
  const channelId = selectedChannelStore?.getChannelId?.()
  return typeof channelId === 'string' && channelId.length > 0 ? channelId : undefined
}

async function prepareAudioWithProgress(sourceUri: string): Promise<PreparedAudio> {
  let active = true
  let lastStage = ''
  let lastBucket = -1
  let lastToastAt = 0
  let lastToastText = 'Preparing audio for your voice message…'
  let bridgeWarningShown = false

  const preparedPromise = callNativeMethod(`${PLUGIN_ID}.prepare`, [sourceUri]) as Promise<PreparedAudio>
  const heartbeat = setInterval(() => {
    if (!active || Date.now() - lastToastAt < 2_000) return
    showVoiceMessageToast(PROGRESS_TOAST_KEY, lastToastText)
    lastToastAt = Date.now()
  }, 2_000)

  const watcher = (async () => {
    while (active) {
      try {
        const state = await callNativeMethod(`${PLUGIN_ID}.getPrepareProgress`, []) as ConversionProgress | null
        if (!active) break
        if (state && typeof state.stage === 'string' && state.stage.length > 0) {
          let bucket: number | null = null
          if (typeof state.progress === 'number' && Number.isFinite(state.progress)) {
            const bounded = Math.max(0, Math.min(1, state.progress))
            bucket = Math.floor(bounded * 10) * 10
          }

          const stageChanged = state.stage !== lastStage
          const progressChanged = bucket !== null && (lastBucket < 0 || bucket >= lastBucket + 10)
          const heartbeatDue = Date.now() - lastToastAt >= 2_000
          if (stageChanged || progressChanged || heartbeatDue) {
            const progressText = bucket === null ? '…' : ` · ${bucket}%`
            lastToastText = `${state.stage}${progressText}`
            showVoiceMessageToast(PROGRESS_TOAST_KEY, lastToastText)
            lastStage = state.stage
            if (bucket !== null) lastBucket = bucket
            lastToastAt = Date.now()
          }
        }
      } catch (error) {
        if (!bridgeWarningShown) {
          bridgeWarningShown = true
          console.warn('[CustomVoiceMessages] Could not read conversion progress; conversion will continue without percentage updates.', getErrorStack(error))
        }
        // Keep the conversion alive and let the independent heartbeat retain a visible status.
      }

      if (active) await new Promise<void>(resolve => setTimeout(resolve, CONVERSION_PROGRESS_POLL_MS))
    }
  })()

  try {
    return await preparedPromise
  } finally {
    active = false
    clearInterval(heartbeat)
    await watcher
  }
}

async function uploadAndSendVoiceMessage(
  channelId: string,
  audio: PreparedAudio,
  onUploadProgress: (fraction: number) => void,
): Promise<{ verifiedVoiceMessage: boolean }> {
  const token = tokenModule?.getToken()
  if (!token) throw new Error('Discord authentication is not available.')

  const body = new FormData()
  body.append('payload_json', JSON.stringify({
    flags: VOICE_MESSAGE_FLAG,
    nonce: Date.now().toString(),
    enforce_nonce: true,
    attachments: [{
      id: '0',
      filename: audio.filename,
      duration_secs: audio.durationSecs,
      waveform: audio.waveform,
    }],
  }))
  body.append('files[0]', {
    uri: audio.uri,
    name: audio.filename,
    type: audio.mimeType,
  } as unknown as Blob)

  const url = `${apiBase}/channels/${encodeURIComponent(channelId)}/messages`
  const message = await postMultipartMessage(url, token, body, onUploadProgress)
  const attachment = message.attachments?.[0]
  const verifiedVoiceMessage =
    typeof message.flags === 'number' &&
    (message.flags & VOICE_MESSAGE_FLAG) !== 0 &&
    typeof attachment?.duration_secs === 'number' &&
    Number.isFinite(attachment.duration_secs) &&
    attachment.duration_secs > 0 &&
    typeof attachment.waveform === 'string' &&
    attachment.waveform.length > 0

  return { verifiedVoiceMessage }
}

function postMultipartMessage(
  url: string,
  token: string,
  body: FormData,
  onUploadProgress: (fraction: number) => void,
): Promise<MessageLike> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('POST', url)
    request.setRequestHeader('Authorization', token)
    request.timeout = 120_000
    request.upload.onprogress = event => {
      if (event.lengthComputable && event.total > 0) {
        onUploadProgress(Math.max(0, Math.min(1, event.loaded / event.total)))
      }
    }
    request.onload = () => {
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(`Discord returned HTTP ${request.status}: ${safeResponseMessage(request.responseText)}`))
        return
      }
      try {
        const parsed = JSON.parse(request.responseText) as MessageLike
        resolve(parsed)
      } catch (error) {
        reject(new Error(`Discord returned an unreadable message response: ${getErrorMessage(error)}`))
      }
    }
    request.onerror = () => reject(new Error('The voice-message upload failed because of a network error. Check the channel before retrying.'))
    request.ontimeout = () => reject(new Error('The voice-message upload timed out. Check the channel before retrying to avoid a duplicate.'))
    request.onabort = () => reject(new Error('The voice-message upload was cancelled.'))
    request.send(body)
  })
}

function safeResponseMessage(responseText: string): string {
  if (!responseText) return 'No error details were returned.'
  try {
    const data = JSON.parse(responseText) as {
      message?: unknown
      code?: unknown
      errors?: unknown
    }
    const summary = typeof data.message === 'string' ? data.message : 'Discord rejected the request.'
    const code = typeof data.code === 'number' || typeof data.code === 'string' ? ` (code ${data.code})` : ''
    const details: string[] = []
    collectValidationErrors(data.errors, '', details)
    const suffix = details.length > 0 ? `: ${details.slice(0, 8).join('; ')}` : ''
    return `${summary}${code}${suffix}`.slice(0, 1000)
  } catch (error) {
    console.warn('[CustomVoiceMessages] Could not parse upload error response', getErrorStack(error))
  }
  return responseText.slice(0, 1000)
}

function collectValidationErrors(value: unknown, path: string, output: string[], depth = 0): void {
  if (!value || typeof value !== 'object' || depth > 8 || output.length >= 8) return
  const record = value as Record<string, unknown>
  const errors = record._errors
  if (Array.isArray(errors)) {
    for (const item of errors) {
      if (!item || typeof item !== 'object') continue
      const message = (item as { message?: unknown }).message
      if (typeof message === 'string') {
        output.push(`${path || 'request'}: ${message}`)
        if (output.length >= 8) return
      }
    }
  }
  for (const [key, child] of Object.entries(record)) {
    if (key === '_errors') continue
    const childPath = path ? `${path}.${key}` : key
    collectValidationErrors(child, childPath, output, depth + 1)
    if (output.length >= 8) return
  }
}

function validatePreparedAudio(audio: PreparedAudio): void {
  if (!audio || typeof audio.uri !== 'string' || !/^(file|content):/i.test(audio.uri)) {
    throw new Error('The audio converter did not return a readable local file URI.')
  }
  if (typeof audio.filename !== 'string' || !audio.filename.toLowerCase().endsWith('.ogg')) {
    throw new Error('The audio converter did not return an Ogg filename.')
  }
  if (audio.mimeType !== 'audio/ogg') throw new Error('The audio converter returned an unexpected content type.')
  if (!Number.isFinite(audio.size) || audio.size <= 0) throw new Error('The converted audio file is empty.')
  if (!Number.isFinite(audio.durationSecs) || audio.durationSecs <= 0) throw new Error('The audio duration is invalid.')
  if (typeof audio.waveform !== 'string' || audio.waveform.length === 0) throw new Error('The audio waveform is missing.')
}

type AttachmentPickerMenuItem = {
  label?: unknown
  IconComponent?: unknown
  action?: unknown
  [key: string]: unknown
}

let pickerMenuInjectionReported = false

/**
 * Discord's plus-button menu is a ContextMenu rendered by ChatInputActions,
 * not a Design.ActionSheet. Its props.items entries have label, IconComponent,
 * and action fields. Patch that data array before React renders the menu.
 */
function addVoiceMessageContextMenuOption(tree: ReactNode): ReactNode {
  const items = findAttachmentPickerMenuItems(tree)
  // ChatInputActions may render before Discord has populated its menu items.
  // Missing items on one render is expected: leave the tree untouched and try
  // again on subsequent renders rather than reporting a plugin error.
  if (!items) return tree

  if (items.some(isOurVoiceMessageMenuItem)) {
    if (!pickerMenuInjectionReported) {
      pickerMenuInjectionReported = true
      console.log('[CustomVoiceMessages] Voice Message option is present in the plus-menu action list.')
    }
    return tree
  }

  const MicrophoneIcon = lookupGeneratedIconComponent('MicrophoneIcon')
  if (!MicrophoneIcon) {
    console.warn('[CustomVoiceMessages] MicrophoneIcon is not available in this Discord build; skipping the plus-menu item for this render.')
    return tree
  }

  const voiceMessageItem: AttachmentPickerMenuItem = {
    label: 'Voice Message',
    IconComponent: MicrophoneIcon,
    action: () => startVoiceMessageFlow(getActiveChannelId()),
  }

  const fileIndex = items.findIndex(isFilePickerMenuItem)
  items.splice(fileIndex >= 0 ? fileIndex + 1 : items.length, 0, voiceMessageItem)
  if (!pickerMenuInjectionReported) {
    pickerMenuInjectionReported = true
    console.log('[CustomVoiceMessages] Added Voice Message to the plus-menu action list.')
  }
  return tree
}

function startVoiceMessageFlow(channelId: string | undefined): void {
  if (!channelId) {
    showVoiceMessageToast(
      'CUSTOM_VOICE_MESSAGES_NO_CHANNEL',
      'Open a channel before choosing Voice Message.',
      'critical',
    )
    return
  }

  const start = requestVoiceMessageFlow
  if (!start || !start(channelId)) {
    showVoiceMessageToast(
      'CUSTOM_VOICE_MESSAGES_BUSY',
      'A voice message is already being prepared. Try again when it finishes.',
      'critical',
    )
  }
}

function findAttachmentPickerMenuItems(
  value: unknown,
  depth = 0,
): AttachmentPickerMenuItem[] | undefined {
  if (depth > 40 || value == null || typeof value !== 'object') return undefined

  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findAttachmentPickerMenuItems(child, depth + 1)
      if (found) return found
    }
    return undefined
  }

  const element = value as MutableElement
  const props = element.props
  const items = props?.items
  if (Array.isArray(items) && isAttachmentPickerItems(items, element.type)) {
    return items as AttachmentPickerMenuItem[]
  }

  return findAttachmentPickerMenuItems(props?.children, depth + 1)
}

function isAttachmentPickerItems(items: unknown[], hostType: unknown): boolean {
  const actionItems = items.filter(isAttachmentPickerMenuItem) as AttachmentPickerMenuItem[]
  if (actionItems.length === 0) return false

  // If Discord identifies the host as ContextMenu, accept a reduced item list.
  // This matters in channels where camera/file/media actions are filtered out by
  // permissions while SEND_VOICE_MESSAGES remains available.
  const hostName = iconComponentName(hostType)
  if (/context.?menu/i.test(hostName)) return true

  const iconScore = actionItems.filter(item => {
    const name = iconComponentName(item.IconComponent)
    return /camera|image|photo|poll|app|attach|thread|calendar|media|file|voice|microphone|gallery|upload|sticker|gif/i.test(name)
  }).length

  // Icon names are stable across locales; labels are a fallback for client builds
  // that wrap generated icon components and hide their original names. One strong
  // signal is enough: attachment/media items can be absent when permissions filter them.
  const labelScore = actionItems.filter(item => {
    const label = normalizedLabel(item.label)
    return /camera|photos?|bilder|fotos|galerie|poll|umfrage|abstimmung|apps?|anwendungen|files?|dateien|fichiers|archivos|attach|anhang|media|voice|sticker|gif|upload/i.test(label)
  }).length

  return iconScore >= 1 || labelScore >= 1
}

function isAttachmentPickerMenuItem(value: unknown): value is AttachmentPickerMenuItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as AttachmentPickerMenuItem
  return (
    typeof item.label === 'string' &&
    typeof item.action === 'function' &&
    item.IconComponent != null &&
    (typeof item.IconComponent === 'function' || typeof item.IconComponent === 'object')
  )
}

function isOurVoiceMessageMenuItem(value: unknown): boolean {
  if (!isAttachmentPickerMenuItem(value)) return false
  return normalizedLabel(value.label) === 'voice message'
}

function isFilePickerMenuItem(value: unknown): boolean {
  if (!isAttachmentPickerMenuItem(value)) return false
  const icon = iconComponentName(value.IconComponent)
  const label = normalizedLabel(value.label)
  return /attachment|attach/i.test(icon) || /^(files?|dateien|fichiers|archivos|anhang|attach files?)$/.test(label)
}

function iconComponentName(value: unknown): string {
  if (typeof value === 'function') {
    const component = value as { displayName?: unknown; name?: unknown }
    return `${typeof component.displayName === 'string' ? component.displayName : ''} ${typeof component.name === 'string' ? component.name : ''}`.trim()
  }
  if (value && typeof value === 'object') {
    const component = value as {
      displayName?: unknown
      name?: unknown
      type?: { displayName?: unknown; name?: unknown } | null
      render?: { displayName?: unknown; name?: unknown } | null
    }
    return [component.displayName, component.name, component.type?.displayName, component.type?.name, component.render?.displayName, component.render?.name]
      .filter((part): part is string => typeof part === 'string')
      .join(' ')
  }
  return ''
}

function normalizedLabel(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLocaleLowerCase() : ''
}

function showVoiceMessageToast(
  key: string,
  text: string,
  variant: ToastVariant = 'default',
  duration = 3200,
): void {
  try {
    if (key !== PROGRESS_TOAST_KEY) {
      ToastActionCreators.open(key, { text, variant, duration })
      return
    }

    // The toast action creator opens a new notification on every call in some client
    // versions; repeatedly calling it stacks stale progress notifications. Keep one
    // mounted React content element and update its subscribed state instead.
    progressToastState = {
      text: formatProgressToastText(text),
      variant,
    }
    for (const listener of progressToastListeners) listener()

    if (!progressToastOpen) {
      progressToastOpen = true
      try {
        ToastActionCreators.open(PROGRESS_TOAST_KEY, {
          text: <ProgressToastContent />,
          variant: 'default',
          duration: PROGRESS_TOAST_MAX_DURATION_MS,
        })
      } catch (error) {
        progressToastOpen = false
        throw error
      }
    }

    if (progressToastCloseTimer !== undefined) {
      clearTimeout(progressToastCloseTimer)
      progressToastCloseTimer = undefined
    }

    if (variant !== 'default') {
      progressToastCloseTimer = setTimeout(() => {
        progressToastCloseTimer = undefined
        if (!progressToastOpen) return
        try {
          ToastActionCreators.close()
        } catch (error) {
          console.warn('[CustomVoiceMessages] Could not close completed progress toast', getErrorStack(error))
        }
        progressToastOpen = false
      }, duration)
    }
  } catch (error) {
    console.warn('[CustomVoiceMessages] Could not show status toast', getErrorStack(error))
  }
}

function ProgressToastContent() {
  const [state, setState] = useState<ProgressToastState>(progressToastState)

  useEffect(() => {
    const update = () => setState({ ...progressToastState })
    progressToastListeners.add(update)
    update()
    return () => {
      progressToastListeners.delete(update)
    }
  }, [])

  const color = state.variant === 'critical' ? 'text-feedback-critical' : 'text-strong'
  return (
    <DesignText variant="text-sm/normal" color={color}>
      {state.text}
    </DesignText>
  )
}

function formatProgressToastText(text: string): string {
  if (text === 'Preparing audio for your voice message…') return 'Preparing voice message…'
  if (text === 'Audio prepared. Uploading voice message…') return 'Uploading voice message…'

  const progress = text.match(/^(.*?)\s*·\s*(\d{1,3})%$/)
  if (progress) {
    const [, rawStage, percent] = progress
    const stage = rawStage.trim()
    const label = /^uploading voice message$/i.test(stage)
      ? 'Uploading'
      : shortConversionStage(stage)
    return `${label} · ${percent}%`
  }

  const stageOnly = text.match(/^(.*?)(?:\s*·\s*)?…$/)
  if (stageOnly) return `${shortConversionStage(stageOnly[1].trim())}…`

  return text
}

function shortConversionStage(stage: string): string {
  const normalized = stage.toLocaleLowerCase()
  if (normalized.includes('calculating') || normalized.includes('ready')) return 'Finishing audio'
  if (normalized.includes('decoding') || normalized.includes('encoding') || normalized.includes('converting')) return 'Converting audio'
  if (normalized.includes('inspect') || normalized.includes('starting') || normalized.includes('prepar')) return 'Preparing audio'
  return 'Preparing audio'
}

function patchMessageActionSheet(report: (error: unknown) => void): () => void {
  const unpatches: Array<() => void> = []

  const unsubscribe = getModules(
    withName<LongPressMessageActionSheet>('LongPressMessageActionSheet'),
    module => {
      const namespace = module as ModuleWithDefault
      const activeUnpatch = instead(namespace, 'default', (args, Original) => {
        const originalTree = Reflect.apply(Original, undefined, args) as ReactNode
        const tree = isMutableElement(originalTree) ? originalTree : undefined
        try {
          const props = args[0] as MessageActionSheetProps | undefined
          const message = props?.message
          if (!tree || !message) return originalTree

          const sheet = findActionSheet(tree)
          if (!sheet) return originalTree

          const actionRows: ReactNode[] = []
          const channelId = firstString(
            message.channel_id,
            message.channelId,
            props.channelId,
            props.channel?.id,
            getActiveChannelId(),
          )

          // Secondary route for accessibility and for channels where Discord hides
          // the usual file/media actions. This uses the native accessible action-sheet row.
          if (channelId) {
            actionRows.push(
              <ActionSheetRow
                key="send-audio-as-voice-message"
                label="Send Audio as Voice Message"
                onPress={() => {
                  ActionSheetActionCreators.hideActionSheet()
                  startVoiceMessageFlow(channelId)
                }}
              />,
            )
          }

          const isVoiceMessage =
            typeof message.flags === 'number' && (message.flags & VOICE_MESSAGE_FLAG) !== 0
          const attachment = message.attachments?.[0]
          const attachmentUrl = attachment?.url
          if (isVoiceMessage && attachment && typeof attachmentUrl === 'string') {
            if (Platform.OS === 'android') {
              actionRows.push(
                <ActionSheetRow
                  key="download-voice-message"
                  label="Download Voice Message"
                  onPress={() => {
                    ActionSheetActionCreators.hideActionSheet()
                    void callNativeMethod(`${PLUGIN_ID}.download`, [
                      attachmentUrl,
                      attachment.filename ?? 'voice-message.ogg',
                      attachment.content_type ?? 'audio/ogg',
                    ]).catch(error => report(new Error(`Voice-message download failed: ${getErrorStack(error)}`)))
                  }}
                />,
              )
            }
            actionRows.push(
              <ActionSheetRow
                key="copy-voice-message-url"
                label="Copy Voice Message URL"
                onPress={() => {
                  Clipboard.setString(attachmentUrl)
                  ActionSheetActionCreators.hideActionSheet()
                }}
              />,
            )
          }

          if (actionRows.length > 0) {
            const group = <ActionSheetRow.Group>{actionRows}</ActionSheetRow.Group>
            const children = [sheet.props.children].flat().filter(Boolean)
            children.push(group)
            sheet.props.children = children
          }
        } catch (error) {
          report(new Error(`Could not add voice-message actions: ${getErrorStack(error)}`))
        }
        return originalTree
      })
      unpatches.push(activeUnpatch)
    },
    { returnNamespace: true },
  )

  return () => {
    unsubscribe()
    for (const unpatch of unpatches) unpatch()
  }
}

function isMutableElement(value: unknown): value is MutableElement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const props = (value as { props?: unknown }).props
  return !!props && typeof props === 'object'
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0)
}

function findActionSheet(value: unknown): MutableElement | undefined {
  if (!value || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findActionSheet(child)
      if (found) return found
    }
    return undefined
  }
  const element = value as MutableElement
  if (element.type === ActionSheet) return element
  return findActionSheet(element.props?.children)
}

function normalizeApiBase(value: string): string {
  let base = value.trim()
  if (base.startsWith('//')) base = `https:${base}`
  if (base.startsWith('http') && base.includes('/api/')) return base.replace(/\/+$/, '')
  return 'https://discord.com/api/v9'
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string') return error
  return 'An unexpected error occurred.'
}


const useVoiceMessageModalStyles = proxify(() =>
  Design.createStyles({
    backdrop: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: 18,
      paddingVertical: 28,
      backgroundColor: 'rgba(0, 0, 0, 0.58)',
    },
    panel: {
      width: '100%',
      maxWidth: 460,
      maxHeight: '88%',
      borderRadius: 22,
      overflow: 'hidden',
      backgroundColor: Tokens.default.colors.BACKGROUND_BASE_LOW,
      borderWidth: 1,
      borderColor: Tokens.default.colors.BORDER_SUBTLE,
      elevation: 18,
      shadowColor: '#000000',
      shadowOffset: { width: 0, height: 10 },
      shadowOpacity: 0.24,
      shadowRadius: 24,
    },
    accentBar: {
      height: 3,
      backgroundColor: Tokens.default.colors.BACKGROUND_BRAND,
    },
    panelContent: {
      padding: 22,
      gap: 20,
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
    },
    iconTile: {
      width: 50,
      height: 50,
      flexShrink: 0,
      borderRadius: 16,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: Tokens.default.colors.BACKGROUND_SURFACE_HIGHEST,
      borderWidth: 1,
      borderColor: Tokens.default.colors.BORDER_SUBTLE,
    },
    musicGlyph: {
      fontSize: 26,
      lineHeight: 31,
    },
    fileGlyph: {
      fontSize: 22,
      lineHeight: 26,
    },
    headerCopy: {
      flex: 1,
      gap: 5,
    },
    fileCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      padding: 14,
      borderRadius: 15,
      backgroundColor: Tokens.default.colors.BACKGROUND_SURFACE_HIGHEST,
      borderWidth: 1,
      borderColor: Tokens.default.colors.BORDER_SUBTLE,
    },
    fileIconTile: {
      width: 42,
      height: 42,
      flexShrink: 0,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: Tokens.default.colors.BACKGROUND_BASE_LOW,
    },
    fileCopy: {
      flex: 1,
      gap: 4,
    },
    infoRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 9,
    },
    infoDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: Tokens.default.colors.BACKGROUND_BRAND,
    },
    infoText: {
      flex: 1,
    },
    actions: {
      flexDirection: 'row',
      gap: 10,
      alignItems: 'center',
      marginTop: 2,
    },
    actionsStacked: {
      flexDirection: 'column-reverse',
      alignItems: 'stretch',
    },
    actionButton: {
      flex: 1,
      minWidth: 0,
    },
    actionButtonStacked: {
      width: '100%',
    },
  }),
)

declare module '@valenced/modules/native' {
  interface NativeMethods {
    'lisaexists.custom-voice-messages.pickAudio': [[], PickedAudio | null]
    'lisaexists.custom-voice-messages.prepare': [[sourceUri: string], PreparedAudio]
    'lisaexists.custom-voice-messages.cleanupPrepared': [[uri: string], null]
    'lisaexists.custom-voice-messages.download':
      [[url: string, filename: string, mimeType: string], boolean]
  }
}
