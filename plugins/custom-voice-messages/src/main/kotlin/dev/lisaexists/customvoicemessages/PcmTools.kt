package dev.lisaexists.customvoicemessages

import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Base64
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

internal enum class PcmEncoding {
    UNSIGNED_8,
    SIGNED_16,
    FLOAT_32,
}

internal data class VoiceAudioMetadata(
    val sampleCount: Long,
    val durationSecs: Double,
    val waveform: String,
)

/**
 * Converts decoded interleaved PCM into mono 48 kHz signed 16-bit PCM while collecting
 * a waveform from the samples that are actually written to the output.
 */
internal class Pcm16MonoResampler(
    private val sourceSampleRate: Int,
    private val channelCount: Int,
    private val encoding: PcmEncoding,
    private val output: OutputStream,
    private val maxOutputSamples: Long,
) {
    private val bytesPerSample = when (encoding) {
        PcmEncoding.UNSIGNED_8 -> 1
        PcmEncoding.SIGNED_16 -> 2
        PcmEncoding.FLOAT_32 -> 4
    }
    private val frameBytes = bytesPerSample * channelCount
    private val sourceStep = sourceSampleRate.toDouble() / OUTPUT_SAMPLE_RATE
    private val waveform = WaveformCollector()
    private val pcmBuffer = ByteArray(32 * 1024)
    private var pcmBufferSize = 0

    private var sourceFramesSeen = 0L
    private var hasPreviousSample = false
    private var previousSample = 0.0
    private var nextOutputPosition = 0.0
    private var outputSamples = 0L
    private var finished = false

    init {
        require(sourceSampleRate > 0) { "The decoder reported an invalid sample rate." }
        require(channelCount in 1..8) { "The decoder reported an unsupported channel count: $channelCount." }
        require(sourceStep.isFinite() && sourceStep > 0.0) { "The audio resampling ratio is invalid." }
    }

    fun consume(buffer: ByteBuffer, offset: Int, size: Int) {
        check(!finished) { "PCM processing has already finished." }
        require(offset >= 0 && size >= 0 && offset + size <= buffer.capacity()) {
            "The decoder returned an invalid PCM buffer range."
        }
        if (size == 0) return
        require(size % frameBytes == 0) {
            "The decoder returned a partial PCM frame; this format cannot be converted safely."
        }

        val samples = buffer.duplicate().order(ByteOrder.LITTLE_ENDIAN)
        samples.position(offset)
        samples.limit(offset + size)

        while (samples.remaining() >= frameBytes) {
            var channelSum = 0.0
            repeat(channelCount) {
                channelSum += readSample(samples)
            }
            val mono = (channelSum / channelCount).coerceIn(-1.0, 1.0)

            if (!hasPreviousSample) {
                hasPreviousSample = true
                previousSample = mono
                sourceFramesSeen = 1L
                nextOutputPosition = sourceStep
                emit(mono)
                continue
            }

            val currentPosition = sourceFramesSeen.toDouble()
            while (nextOutputPosition <= currentPosition) {
                val fraction = (nextOutputPosition - (currentPosition - 1.0)).coerceIn(0.0, 1.0)
                val interpolated = previousSample + (mono - previousSample) * fraction
                emit(interpolated)
                nextOutputPosition += sourceStep
            }

            previousSample = mono
            sourceFramesSeen++
        }
    }

    fun finish(): VoiceAudioMetadata {
        check(!finished) { "PCM processing has already finished." }
        if (hasPreviousSample) {
            // Preserve the input duration when the final output-sample instant lies in the
            // final source frame's interval rather than exactly on a decoded sample.
            while (nextOutputPosition < sourceFramesSeen.toDouble()) {
                emit(previousSample)
                nextOutputPosition += sourceStep
            }
        }
        finished = true
        check(outputSamples > 0L) { "The selected file contains no decodable audio samples." }
        flushPcmBuffer()
        output.flush()
        return VoiceAudioMetadata(
            sampleCount = outputSamples,
            durationSecs = outputSamples.toDouble() / OUTPUT_SAMPLE_RATE,
            waveform = waveform.finish(),
        )
    }

    private fun readSample(buffer: ByteBuffer): Double = when (encoding) {
        PcmEncoding.UNSIGNED_8 -> ((buffer.get().toInt() and 0xff) - 128).toDouble() / 128.0
        PcmEncoding.SIGNED_16 -> buffer.short.toDouble() / 32768.0
        PcmEncoding.FLOAT_32 -> buffer.float.toDouble().coerceIn(-1.0, 1.0)
    }

    private fun emit(sample: Double) {
        if (outputSamples >= maxOutputSamples) {
            throw IllegalArgumentException("Voice messages cannot exceed 20 minutes of audio.")
        }
        val bounded = sample.coerceIn(-1.0, 1.0)
        val pcm = (bounded * 32767.0).roundToInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
        pcmBuffer[pcmBufferSize++] = (pcm and 0xff).toByte()
        pcmBuffer[pcmBufferSize++] = ((pcm shr 8) and 0xff).toByte()
        if (pcmBufferSize == pcmBuffer.size) flushPcmBuffer()
        waveform.add(abs(bounded).toFloat())
        outputSamples++
    }

    private fun flushPcmBuffer() {
        if (pcmBufferSize == 0) return
        output.write(pcmBuffer, 0, pcmBufferSize)
        pcmBufferSize = 0
    }

    companion object {
        const val OUTPUT_SAMPLE_RATE = 48_000
        const val MAX_DURATION_SECONDS = 20 * 60
        const val MAX_OUTPUT_SAMPLES = OUTPUT_SAMPLE_RATE.toLong() * MAX_DURATION_SECONDS
    }
}

/**
 * Samples peak amplitude in 100 ms windows, then downsamples to no more than 256 points.
 * The resulting metadata is derived from decoded PCM, not a placeholder waveform.
 */
internal class WaveformCollector(
    private val samplesPerWindow: Int = 4_800,
    private val maxPoints: Int = 256,
) {
    private val peaks = ArrayList<Float>()
    private var samplesInWindow = 0
    private var windowPeak = 0f
    private var finished = false

    fun add(sample: Float) {
        check(!finished) { "Waveform collection has already finished." }
        windowPeak = max(windowPeak, sample.coerceIn(0f, 1f))
        samplesInWindow++
        if (samplesInWindow == samplesPerWindow) {
            peaks.add(windowPeak)
            samplesInWindow = 0
            windowPeak = 0f
        }
    }

    fun finish(): String {
        check(!finished) { "Waveform collection has already finished." }
        finished = true
        if (samplesInWindow > 0) peaks.add(windowPeak)
        require(peaks.isNotEmpty()) { "Cannot make a waveform from empty audio." }

        val downsampled = if (peaks.size <= maxPoints) peaks.toList() else {
            List(maxPoints) { point ->
                val start = (point.toLong() * peaks.size / maxPoints).toInt()
                val end = max(start + 1, ((point + 1L) * peaks.size / maxPoints).toInt())
                    .coerceAtMost(peaks.size)
                peaks.subList(start, end).maxOrNull() ?: 0f
            }
        }
        val maximum = downsampled.maxOrNull() ?: 0f
        val bytes = ByteArray(downsampled.size) { index ->
            val scaled = if (maximum <= 0f) 0 else (downsampled[index] / maximum * 255f).roundToInt()
            min(255, max(0, scaled)).toByte()
        }
        return Base64.getEncoder().encodeToString(bytes)
    }
}
