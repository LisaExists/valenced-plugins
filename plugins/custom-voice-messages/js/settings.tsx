import { Design } from '@valenced/discord/design'
import Page from '@valenced/components/Page'

const { Stack, Text } = Design

export default function SettingsComponent() {
  return (
    <Page>
      <Stack spacing={16}>
        <Text color="text-default" variant="text-md/medium">
          Hold the + button in chat and choose Voice Message. Select an audio file and confirm to convert and send it. Conversion and upload continue in the background, so you can keep chatting.
        </Text>
        <Text color="text-muted" variant="text-sm/normal">
          Requires Android 10 or newer. Audio format support depends on your device.
        </Text>
      </Stack>
    </Page>
  )
}
