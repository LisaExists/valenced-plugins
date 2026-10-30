package dev.lisaexists.customvoicemessages

import io.github.jaredmdobson.concentus.OpusApplication
import io.github.jaredmdobson.concentus.OpusEncoder
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream
import java.nio.charset.StandardCharsets
import java.security.SecureRandom
import java.util.Arrays
import kotlin.math.min

/**
 * Software Opus fallback used only when Android does not expose a usable Opus encoder.
 * Concentus is a pure-Java Opus implementation; Ogg framing is written here so the
 * fallback does not depend on MediaMuxer or a native codec.
 */
internal object SoftwareOpusEncoder {
    private const val SAMPLE_RATE = 48_000
    private const val CHANNELS = 1
    private const val BITRATE = 32_000
    private const val FRAME_SAMPLES = SAMPLE_RATE / 50 // 20 ms, one Opus frame per packet
    private const val MAX_OPUS_PACKET_BYTES = 1_275

    fun encode(
        pcmFile: File,
        outputFile: File,
        onProgress: (stage: String, progress: Double?) -> Unit,
    ) {
        require(pcmFile.isFile && pcmFile.length() >= 2L) {
            "The converted PCM file is empty; there is no audio to encode."
        }
        require(pcmFile.length() % 2L == 0L) {
            "The converted PCM file ends on a partial 16-bit sample."
        }

        val totalSamples = pcmFile.length() / 2L
        val encoder = OpusEncoder(SAMPLE_RATE, CHANNELS, OpusApplication.OPUS_APPLICATION_AUDIO)
        encoder.setBitrate(BITRATE)
        val preSkip = encoder.getLookahead()
        require(preSkip in 0..0xffff) { "Concentus returned an invalid Opus encoder delay ($preSkip samples)." }

        var samplesEncoded = 0L
        var framesEncoded = 0L
        var lastProgressAt = 0L
        val pcmBytes = ByteArray(FRAME_SAMPLES * 2)
        val pcmFrame = ShortArray(FRAME_SAMPLES)
        val opusPacket = ByteArray(MAX_OPUS_PACKET_BYTES)

        OggOpusWriter(outputFile).use { ogg ->
            ogg.writeHeaders(preSkip)
            BufferedInputStream(FileInputStream(pcmFile), 64 * 1024).use { input ->
                while (samplesEncoded < totalSamples) {
                    Arrays.fill(pcmFrame, 0.toShort())
                    val validSamples = min(FRAME_SAMPLES.toLong(), totalSamples - samplesEncoded).toInt()
                    val bytesToRead = validSamples * 2
                    readFully(input, pcmBytes, bytesToRead)
                    for (i in 0 until validSamples) {
                        val low = pcmBytes[i * 2].toInt() and 0xff
                        val high = pcmBytes[i * 2 + 1].toInt()
                        pcmFrame[i] = ((high shl 8) or low).toShort()
                    }

                    val packetLength = encoder.encode(
                        pcmFrame,
                        0,
                        FRAME_SAMPLES,
                        opusPacket,
                        0,
                        opusPacket.size,
                    )
                    check(packetLength in 1..opusPacket.size) {
                        "Concentus produced an invalid Opus packet length ($packetLength)."
                    }
                    val lastPacket = samplesEncoded + validSamples >= totalSamples
                    samplesEncoded += validSamples.toLong()
                    framesEncoded += 1L
                    val packetGranule = if (lastPacket) {
                        preSkip.toLong() + totalSamples
                    } else {
                        preSkip.toLong() + framesEncoded * FRAME_SAMPLES
                    }
                    ogg.writeAudioPacket(opusPacket.copyOf(packetLength), packetGranule, lastPacket)

                    val now = android.os.SystemClock.elapsedRealtime()
                    if (now - lastProgressAt >= 180L || lastPacket) {
                        val fraction = (samplesEncoded.toDouble() / totalSamples.toDouble()).coerceIn(0.0, 1.0)
                        onProgress("Encoding Opus (software)", 0.68 + fraction * 0.29)
                        lastProgressAt = now
                    }
                }
            }
        }
        require(outputFile.isFile && outputFile.length() > 0L) {
            "The software Opus encoder did not produce an Ogg file."
        }
    }

    private fun readFully(input: InputStream, buffer: ByteArray, length: Int) {
        var offset = 0
        while (offset < length) {
            val count = input.read(buffer, offset, length - offset)
            if (count < 0) throw IOException("The converted PCM file ended before all audio samples were read.")
            if (count == 0) continue
            offset += count
        }
    }
}
