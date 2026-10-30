import { Design } from '@valenced/discord/design'
import Page from '@valenced/components/Page'

const { Stack, Text } = Design

export default function SettingsComponent() {
  return (
    <Page>
      <Stack spacing={16}>
        <Text color="text-default" variant="text-md/medium">
          Open the + menu and choose Voice Message, or long-press a message and choose Send Audio as Voice Message. Select an audio file and confirm. Conversion and upload continue in the background, so you can keep chatting.
        </Text>
        <Text color="text-muted" variant="text-sm/normal">
          Requires Android 10 or newer. Audio format support depends on your device.
        </Text>
      </Stack>
    </Page>
  )
}
