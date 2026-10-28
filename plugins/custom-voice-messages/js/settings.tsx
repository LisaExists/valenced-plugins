import { Design } from '@valenced/discord/design'
import Page from '@valenced/components/Page'

const { Stack, Text } = Design

export default function SettingsComponent() {
  return (
    <Page>
      <Stack spacing={16}>
        <Text color="text-default" variant="text-md/medium">
          Use /voice-message in the channel where you want to send audio. Choose a file and confirm to convert and send it as a voice message.
        </Text>
        <Text color="text-muted" variant="text-sm/normal">
          Requires Android 10 or newer and Coco's Command Lib. Audio format support depends on your device.
        </Text>
      </Stack>
    </Page>
  )
}
