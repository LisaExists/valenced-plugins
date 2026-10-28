import { ActionSheetActionCreators } from '@valenced/discord/actions'
import { Tokens } from '@valenced/discord/common/tokens'
import { Design } from '@valenced/discord/design'
import { Clipboard } from '@valenced/externals/react-native-clipboard'
import { Stores } from '@valenced/discord/flux'
import {
  getModuleWithImportedPath,
} from '@valenced/discord/utils/modules/finders'
import { getModules } from '@valenced/modules/finders'
import { withName, withProps } from '@valenced/modules/finders/filters'
import { callNativeMethod, callNativeMethodSync } from '@valenced/modules/native'
import { after, instead } from '@valenced/patcher'
import { getErrorStack } from '@valenced/utils/error'
import { proxify } from '@valenced/utils/proxy'
import { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Modal,
  Platform,
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

interface NativeProgress {
  stage: string
  progress: number | null
}

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
  flags?: number
  attachments?: Attachment[]
}

interface MessageActionSheetProps {
  message?: MessageLike
}

type LongPressMessageActionSheet = FC<MessageActionSheetProps>
type ModuleWithDefault = { default: LongPressMessageActionSheet }
type MutableElement = {
  type: unknown
  props: { children?: ReactNode; [key: string]: unknown }
}
type ProgressView = { stage: string; progress: number | null }
type Notice = { title: string; message: string }
type CommandContext = { channel?: { id?: string } | null }
type CommandResult = { content: string }
type ApplicationCommand = {
  name: string
  displayName: string
  description: string
  displayDescription: string
  applicationId: string
  inputType: number
  type: number
  shouldHide: () => boolean
  execute: (args: unknown[], context: CommandContext) =>
    | void
    | CommandResult
    | Promise<void | CommandResult>
}
type CommandLib = {
  commands: { registerCommand: (command: ApplicationCommand) => () => void }
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
            after(ChatInputActions, 'type', tree =>
              addVoiceMessageModalHost(tree as ReactNode),
            ),
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

    const commandLib = (api as unknown as {
      unscoped?: { commandlib?: CommandLib }
    }).unscoped?.commandlib
    if (!commandLib?.commands?.registerCommand) {
      plugin.reportError(new Error("Coco's Command Lib (dev.cocobo1.command-lib) is unavailable; make sure it is installed and enabled. The manifest now declares it as a dependency, but /voice-message could not be registered."))
      return
    }
    cleanup(commandLib.commands.registerCommand(voiceMessageCommand()))
  },
  SettingsComponent,
})

function addVoiceMessageModalHost(tree: ReactNode): ReactElement {
  return (
    <>
      {tree}
      <VoiceMessageCommandHost key="lisaexists-custom-voice-message-command-host" />
    </>
  )
}

function voiceMessageCommand(): ApplicationCommand {
  return {
    name: 'voice-message',
    displayName: 'voice-message',
    description: 'Send an audio file as a Discord voice message',
    displayDescription: 'Send an audio file as a Discord voice message',
    applicationId: '-1',
    inputType: 1,
    type: 1,
    shouldHide: () => false,
    execute: (_args, context) => {
      const channelId = context.channel?.id || getActiveChannelId()
      if (!channelId) {
        return { content: 'Open a Discord channel before using /voice-message.' }
      }

      const start = requestVoiceMessageFlow
      if (!start || !start(channelId)) {
        return { content: 'The voice-message flow is busy or the chat is not ready. Try again in the open channel.' }
      }
    },
  }
}

function VoiceMessageCommandHost() {
  const [confirmation, setConfirmation] = useState<PickedAudio | null>(null)
  const [job, setJob] = useState<ProgressView | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [activeFilename, setActiveFilename] = useState<string | null>(null)
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
      setActiveFilename(picked.displayName)

      const shouldSend = await confirmVoiceMessage(picked)
      if (!shouldSend) return

      const jobId = createJobId()
      setJob({ stage: 'Preparing audio', progress: 0 })
      const poller = setInterval(() => {
        try {
          const nativeProgress = callNativeMethodSync(`${PLUGIN_ID}.progress`, [jobId]) as NativeProgress
          if (nativeProgress && typeof nativeProgress.stage === 'string') {
            setJob({
              stage: nativeProgress.stage,
              progress: isProgress(nativeProgress.progress) ? nativeProgress.progress : null,
            })
          }
        } catch (error) {
          clearInterval(poller)
          reportPluginError(new Error(`Could not read audio conversion progress: ${getErrorStack(error)}`))
        }
      }, 180)

      let prepared: PreparedAudio | undefined
      try {
        prepared = await callNativeMethod(`${PLUGIN_ID}.prepare`, [
          picked.uri,
          jobId,
        ]) as PreparedAudio
      } finally {
        clearInterval(poller)
        try {
          callNativeMethodSync(`${PLUGIN_ID}.clearProgress`, [jobId])
        } catch (error) {
          reportPluginError(new Error(`Could not clear conversion progress: ${getErrorStack(error)}`))
        }
      }

      let sendResult: { verifiedVoiceMessage: boolean }
      try {
        if (!prepared) throw new Error('The audio converter returned no prepared file.')
        validatePreparedAudio(prepared)
        setJob({ stage: 'Uploading voice message', progress: 0.72 })
        sendResult = await uploadAndSendVoiceMessage(
          channelId,
          prepared,
          progress => setJob({ stage: 'Uploading voice message', progress: 0.72 + progress * 0.25 }),
        )
      } finally {
        if (prepared && typeof prepared.uri === 'string') {
          await callNativeMethod(`${PLUGIN_ID}.cleanupPrepared`, [prepared.uri]).catch(error => {
            reportPluginError(new Error(`Could not clean up the temporary converted audio file: ${getErrorStack(error)}`))
          })
        }
      }

      if (sendResult.verifiedVoiceMessage) {
        setJob({ stage: 'Voice message sent', progress: 1 })
        await wait(450)
        setJob(null)
        setNotice({
          title: 'Voice message sent',
          message: 'Discord confirmed this message as a voice message.',
        })
      } else {
        setJob(null)
        setNotice({
          title: 'Discord did not confirm a voice message',
          message: 'The request was accepted, but its response did not contain the voice-message flag and metadata. Check the channel before trying again to avoid sending a duplicate.',
        })
      }
    } catch (error) {
      setJob(null)
      reportPluginError(new Error(`Could not send voice message: ${getErrorStack(error)}`))
      setNotice({ title: 'Could not send voice message', message: getErrorMessage(error) })
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

  const isFailureNotice = notice ? /could not|did not confirm|failed|error/i.test(notice.title) : false
  const useStackedActions = viewportWidth < 380

  return (
    <Modal
      animationType="fade"
      transparent
      statusBarTranslucent
      visible={confirmation !== null || job !== null || notice !== null}
      onRequestClose={() => {
        if (confirmation !== null) finishConfirmation(false)
        else if (notice !== null) setNotice(null)
      }}
    >
      <View style={styles.backdrop}>
        <View style={styles.panel}>
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
            ) : job !== null ? (
              <>
                <View style={styles.headerRow}>
                  <View style={styles.iconTile}>
                    <ActivityIndicator size="small" color={Tokens.default.colors.BACKGROUND_BRAND} />
                  </View>
                  <View style={styles.headerCopy}>
                    <DesignText variant="heading-lg/semibold" color="text-strong">
                      Sending voice message
                    </DesignText>
                    {activeFilename ? (
                      <DesignText variant="text-sm/normal" color="text-muted" numberOfLines={1}>
                        {activeFilename}
                      </DesignText>
                    ) : null}
                  </View>
                </View>

                <View style={styles.stageCard}>
                  <DesignText variant="text-md/medium" color="text-strong">
                    {job.stage}
                  </DesignText>
                  <DesignText variant="text-sm/normal" color="text-muted">
                    {job.progress !== null && job.progress >= 0.72 ? 'Uploading your audio to Discord…' : 'Preparing and encoding your audio…'}
                  </DesignText>
                </View>

                {job.progress === null || job.progress === undefined ? (
                  <View style={styles.indeterminateProgress}>
                    <ActivityIndicator size="small" color={Tokens.default.colors.BACKGROUND_BRAND} />
                    <DesignText variant="text-sm/medium" color="text-muted">Working…</DesignText>
                  </View>
                ) : (
                  <>
                    <View style={styles.progressMeta}>
                      <DesignText variant="text-sm/medium" color="text-muted">
                        {job.progress >= 0.72 ? 'Upload progress' : 'Conversion progress'}
                      </DesignText>
                      <DesignText variant="text-sm/semibold" color="text-strong">
                        {Math.round(job.progress * 100)}%
                      </DesignText>
                    </View>
                    <View
                      style={styles.progressTrack}
                      accessibilityRole="progressbar"
                      accessibilityValue={{ min: 0, max: 100, now: Math.round(job.progress * 100) }}
                    >
                      <View style={[styles.progressFill, { width: `${Math.round(job.progress * 100)}%` }]} />
                    </View>
                  </>
                )}

                <DesignText variant="text-xs/normal" color="text-muted">
                  Keep Discord open until the message is sent. Larger files may take a little longer to encode.
                </DesignText>
              </>
            ) : notice !== null ? (
              <>
                <View style={styles.headerRow}>
                  <View style={[styles.iconTile, isFailureNotice ? styles.failureIconTile : styles.successIconTile]}>
                    <DesignText variant="heading-lg/semibold" color="text-strong" style={styles.noticeGlyph}>
                      {isFailureNotice ? '!' : '✓'}
                    </DesignText>
                  </View>
                  <View style={styles.headerCopy}>
                    <DesignText variant="heading-lg/semibold" color="text-strong">
                      {notice.title}
                    </DesignText>
                    <DesignText variant="text-sm/normal" color="text-muted">
                      {notice.message}
                    </DesignText>
                  </View>
                </View>
                <DesignButton
                  text="Close"
                  variant="primary"
                  size="lg"
                  style={styles.closeButton}
                  onPress={() => setNotice(null)}
                />
              </>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
}

function getActiveChannelId(): string | undefined {
  const stores = Stores as unknown as Record<string, unknown>
  const selectedChannelStore = stores.SelectedChannelStore as SelectedChannelStore | undefined
  const channelId = selectedChannelStore?.getChannelId?.()
  return typeof channelId === 'string' && channelId.length > 0 ? channelId : undefined
}

async function uploadAndSendVoiceMessage(
  channelId: string,
  audio: PreparedAudio,
  onProgress: (fraction: number) => void,
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
  const message = await postMultipartMessage(url, token, body, onProgress)
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
  onProgress: (fraction: number) => void,
): Promise<MessageLike> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('POST', url)
    request.setRequestHeader('Authorization', token)
    request.timeout = 120_000
    request.upload.onprogress = event => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(1, Math.max(0, event.loaded / event.total)))
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

function patchMessageActionSheet(report: (error: unknown) => void): () => void {
  const unpatches: Array<() => void> = []

  const unsubscribe = getModules(
    withName<LongPressMessageActionSheet>('LongPressMessageActionSheet'),
    module => {
      const namespace = module as ModuleWithDefault
      const activeUnpatch = instead(namespace, 'default', (args, Original) => {
        const tree = Reflect.apply(Original, undefined, args) as MutableElement | null
        try {
          const props = args[0] as MessageActionSheetProps | undefined
          const message = props?.message
          if (!tree || !message || typeof message.flags !== 'number') return tree
          if ((message.flags & VOICE_MESSAGE_FLAG) === 0) return tree

          const attachment = message.attachments?.[0]
          if (!attachment || typeof attachment.url !== 'string') return tree

          const sheet = findActionSheet(tree)
          if (!sheet) return tree

          const actionRows: ReactNode[] = []
          if (Platform.OS === 'android') {
            actionRows.push(
              <ActionSheetRow
                key="download-voice-message"
                label="Download Voice Message"
                onPress={() => {
                  ActionSheetActionCreators.hideActionSheet()
                  void callNativeMethod(`${PLUGIN_ID}.download`, [
                    attachment.url,
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
                Clipboard.setString(attachment.url!)
                ActionSheetActionCreators.hideActionSheet()
              }}
            />,
          )

          const group = <ActionSheetRow.Group>{actionRows}</ActionSheetRow.Group>
          const children = [sheet.props.children].flat().filter(Boolean)
          children.push(group)
          sheet.props.children = children
        } catch (error) {
          report(new Error(`Could not add voice-message actions: ${getErrorStack(error)}`))
        }
        return tree
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

function createJobId(): string {
  return `cvm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function isProgress(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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
    noticeGlyph: {
      fontSize: 24,
      lineHeight: 28,
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
    stageCard: {
      gap: 5,
      padding: 15,
      borderRadius: 14,
      backgroundColor: Tokens.default.colors.BACKGROUND_SURFACE_HIGHEST,
      borderWidth: 1,
      borderColor: Tokens.default.colors.BORDER_SUBTLE,
    },
    indeterminateProgress: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      minHeight: 24,
    },
    progressMeta: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      marginBottom: -10,
    },
    progressTrack: {
      width: '100%',
      height: 8,
      borderRadius: 4,
      overflow: 'hidden',
      backgroundColor: Tokens.default.colors.BACKGROUND_SURFACE_HIGHEST,
    },
    progressFill: {
      height: 8,
      borderRadius: 4,
      backgroundColor: Tokens.default.colors.BACKGROUND_BRAND,
    },
    failureIconTile: {
      borderColor: Tokens.default.colors.BORDER_SUBTLE,
    },
    successIconTile: {
      borderColor: Tokens.default.colors.BORDER_SUBTLE,
    },
    closeButton: {
      alignSelf: 'stretch',
      marginTop: 2,
    },
  }),
)

declare module '@valenced/modules/native' {
  interface NativeMethods {
    'lisaexists.custom-voice-messages.pickAudio': [[], PickedAudio | null]
    'lisaexists.custom-voice-messages.prepare': [
      [sourceUri: string, jobId: string],
      PreparedAudio,
    ]
    'lisaexists.custom-voice-messages.progress': [[jobId: string], NativeProgress]
    'lisaexists.custom-voice-messages.clearProgress': [[jobId: string], null]
    'lisaexists.custom-voice-messages.cleanupPrepared': [[uri: string], null]
    'lisaexists.custom-voice-messages.download':
      [[url: string, filename: string, mimeType: string], boolean]
  }
}
