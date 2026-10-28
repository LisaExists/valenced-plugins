package dev.lisaexists.customvoicemessages

import android.content.Context
import android.content.ContentResolver
import android.database.Cursor
import android.provider.OpenableColumns
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaCodecList
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import android.os.Build
import java.io.File
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID

internal object AudioTranscoder {
    private const val MIME_OPUS = "audio/opus"
    private const val MIME_OGG = "audio/ogg"
    private const val MAX_DURATION_US = 20L * 60L * 1_000_000L
    private const val PCM_PREFIX = "cvm-pcm-"
    private const val OUTPUT_PREFIX = "cvm-voice-"
    private const val TEMP_RETENTION_MS = 24L * 60L * 60L * 1_000L

    fun prepare(
        context: Context,
        source: String,
        onProgress: (stage: String, progress: Double?) -> Unit = { _, _ -> },
    ): Map<String, Any> {
        require(source.isNotBlank()) { "The selected audio file has no URI." }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            throw IllegalStateException(
                "This Android version cannot create an Opus/Ogg output with the platform MediaMuxer. Android 10 (API 29) or newer is required.",
            )
        }

        cleanStaleFiles(context.cacheDir)
        onProgress("Inspecting audio format", 0.03)
        val token = UUID.randomUUID().toString()
        val pcmFile = File(context.cacheDir, "$PCM_PREFIX$token.pcm")
        val oggFile = File(context.cacheDir, "$OUTPUT_PREFIX$token.ogg")
        var completed = false

        try {
            val compatibleSource = inspectCompatibleOggOpus(context, source)
            onProgress("Decoding audio", 0.05)
            val metadata = decodeToPcm(context, source, pcmFile, onProgress)
            onProgress("Calculating duration and waveform", 0.68)
            require(pcmFile.isFile && pcmFile.length() > 0L) {
                "The selected file did not produce any decoded audio samples."
            }

            val preparedUri: String
            val preparedSize: Long
            if (compatibleSource != null) {
                // Preserve already-compatible Ogg/Opus bytes; decoding above is only to derive
                // real duration and waveform metadata for the upload payload.
                preparedUri = compatibleSource.uri
                preparedSize = compatibleSource.size
            } else {
                encodeOpusOgg(pcmFile, oggFile, onProgress)
                require(oggFile.isFile && oggFile.length() > 0L) {
                    "The Android Opus encoder produced an empty Ogg file."
                }
                preparedUri = Uri.fromFile(oggFile).toString()
                preparedSize = oggFile.length()
            }

            onProgress("Audio ready to send", 1.0)
            completed = true
            return mapOf(
                "uri" to preparedUri,
                "filename" to "voice-message-$token.ogg",
                "mimeType" to MIME_OGG,
                "size" to preparedSize.toDouble(),
                "durationSecs" to metadata.durationSecs,
                "waveform" to metadata.waveform,
            )
        } catch (e: Exception) {
            throw IllegalStateException(
                "Could not prepare a genuine voice message from this audio. Check that Android has a decoder for the input and an Opus encoder: ${e.message ?: e.javaClass.simpleName}",
                e,
            )
        } finally {
            pcmFile.delete()
            if (!completed) oggFile.delete()
        }
    }

    private fun inspectCompatibleOggOpus(context: Context, source: String): CompatibleSource? {
        val inputUri = normalizeLocalUri(source) ?: return null
        val size = sourceSize(context, inputUri)
        if (size <= 0L || !hasOggPageHeader(context, inputUri)) return null

        val extractor = MediaExtractor()
        try {
            setExtractorSource(extractor, context, inputUri)
            for (track in 0 until extractor.trackCount) {
                val format = extractor.getTrackFormat(track)
                val mime = format.getString(MediaFormat.KEY_MIME) ?: continue
                if (!mime.equals(MIME_OPUS, ignoreCase = true)) continue
                if (!format.containsKey(MediaFormat.KEY_SAMPLE_RATE) ||
                    format.getInteger(MediaFormat.KEY_SAMPLE_RATE) != Pcm16MonoResampler.OUTPUT_SAMPLE_RATE
                ) return null
                if (!format.containsKey(MediaFormat.KEY_CHANNEL_COUNT) || format.getInteger(MediaFormat.KEY_CHANNEL_COUNT) != 1) {
                    return null
                }
                if (!format.containsKey(MediaFormat.KEY_BIT_RATE) || format.getInteger(MediaFormat.KEY_BIT_RATE) != 32_000) {
                    return null
                }
                return CompatibleSource(inputUri, size)
            }
            return null
        } finally {
            extractor.release()
        }
    }

    private fun normalizeLocalUri(source: String): String? {
        val parsed = Uri.parse(source)
        return when (parsed.scheme?.lowercase()) {
            "content", "file" -> source
            null -> Uri.fromFile(File(source)).toString()
            else -> null
        }
    }

    private fun sourceSize(context: Context, sourceUri: String): Long {
        val uri = Uri.parse(sourceUri)
        return when (uri.scheme?.lowercase()) {
            "file" -> uri.path?.let(::File)?.length() ?: 0L
            "content" -> {
                val descriptorSize = context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length }
                    ?: -1L
                if (descriptorSize > 0L) descriptorSize else queryContentSize(context.contentResolver, uri)
            }
            else -> 0L
        }
    }

    private fun queryContentSize(resolver: ContentResolver, uri: Uri): Long {
        var cursor: Cursor? = null
        try {
            cursor = resolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)
            if (cursor != null && cursor.moveToFirst()) {
                val column = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (column >= 0 && !cursor.isNull(column)) return cursor.getLong(column)
            }
            return 0L
        } finally {
            cursor?.close()
        }
    }

    private fun hasOggPageHeader(context: Context, sourceUri: String): Boolean {
        val uri = Uri.parse(sourceUri)
        val input = when (uri.scheme?.lowercase()) {
            "file" -> uri.path?.let(::File)?.inputStream()
            "content" -> context.contentResolver.openInputStream(uri)
            else -> null
        } ?: return false
        return BufferedInputStream(input).use { stream ->
            val header = ByteArray(4)
            var read = 0
            while (read < header.size) {
                val amount = stream.read(header, read, header.size - read)
                if (amount < 0) return@use false
                read += amount
            }
            header.contentEquals(byteArrayOf('O'.code.toByte(), 'g'.code.toByte(), 'g'.code.toByte(), 'S'.code.toByte()))
        }
    }

    private fun decodeToPcm(
        context: Context,
        source: String,
        outputFile: File,
        onProgress: (stage: String, progress: Double?) -> Unit,
    ): VoiceAudioMetadata {
        val extractor = MediaExtractor()
        var decoder: MediaCodec? = null
        try {
            setExtractorSource(extractor, context, source)
            var audioTrack = -1
            var audioFormat: MediaFormat? = null
            for (track in 0 until extractor.trackCount) {
                val format = extractor.getTrackFormat(track)
                val mime = format.getString(MediaFormat.KEY_MIME) ?: continue
                if (mime.startsWith("audio/", ignoreCase = true)) {
                    audioTrack = track
                    audioFormat = format
                    break
                }
            }
            require(audioTrack >= 0 && audioFormat != null) {
                "Android could not find a decodable audio track in the selected file."
            }

            val format = audioFormat!!
            val declaredDurationUs = if (format.containsKey(MediaFormat.KEY_DURATION)) {
                format.getLong(MediaFormat.KEY_DURATION).also { declaredDuration ->
                    require(declaredDuration <= MAX_DURATION_US) {
                        "Voice messages cannot exceed 20 minutes of audio."
                    }
                }
            } else {
                0L
            }

            val decoderMime = format.getString(MediaFormat.KEY_MIME)
                ?: throw IllegalArgumentException("The audio track has no MIME type.")
            decoder = MediaCodec.createDecoderByType(decoderMime)
            extractor.selectTrack(audioTrack)
            decoder.configure(format, null, null, 0)
            decoder.start()

            BufferedOutputStream(FileOutputStream(outputFile), 64 * 1024).use { output ->
                var processor: Pcm16MonoResampler? = null
                var processorConfiguration: PcmOutputConfiguration? = null
                var inputEos = false
                var outputEos = false
                var latestSampleTimeUs = 0L
                var lastProgressAt = 0L
                val info = MediaCodec.BufferInfo()

                while (!outputEos) {
                    if (!inputEos) {
                        val inputIndex = decoder.dequeueInputBuffer(CODEC_TIMEOUT_US)
                        if (inputIndex >= 0) {
                            val inputBuffer = decoder.getInputBuffer(inputIndex)
                                ?: throw IllegalStateException("The decoder returned no input buffer.")
                            inputBuffer.clear()
                            val sampleSize = extractor.readSampleData(inputBuffer, 0)
                            if (sampleSize < 0) {
                                decoder.queueInputBuffer(
                                    inputIndex,
                                    0,
                                    0,
                                    0L,
                                    MediaCodec.BUFFER_FLAG_END_OF_STREAM,
                                )
                                inputEos = true
                            } else {
                                val sampleTime = extractor.sampleTime.coerceAtLeast(0L)
                                latestSampleTimeUs = sampleTime
                                decoder.queueInputBuffer(
                                    inputIndex,
                                    0,
                                    sampleSize,
                                    sampleTime,
                                    extractor.sampleFlags,
                                )
                                extractor.advance()
                            }
                        }
                    }

                    when (val outputIndex = decoder.dequeueOutputBuffer(info, CODEC_TIMEOUT_US)) {
                        MediaCodec.INFO_TRY_AGAIN_LATER -> Unit
                        MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                            val outputFormat = decoder.outputFormat
                            val config = outputConfiguration(outputFormat)
                            if (processorConfiguration != null && processorConfiguration != config) {
                                throw IllegalStateException("The decoder changed PCM format mid-stream.")
                            }
                            if (processor == null) {
                                processorConfiguration = config
                                processor = Pcm16MonoResampler(
                                    sourceSampleRate = config.sampleRate,
                                    channelCount = config.channels,
                                    encoding = config.encoding,
                                    output = output,
                                    maxOutputSamples = Pcm16MonoResampler.MAX_OUTPUT_SAMPLES,
                                )
                            }
                        }
                        MediaCodec.INFO_OUTPUT_BUFFERS_CHANGED -> Unit
                        else -> if (outputIndex >= 0) {
                            if (info.size > 0) {
                                if (processor == null) {
                                    val config = outputConfiguration(decoder.outputFormat)
                                    processorConfiguration = config
                                    processor = Pcm16MonoResampler(
                                        sourceSampleRate = config.sampleRate,
                                        channelCount = config.channels,
                                        encoding = config.encoding,
                                        output = output,
                                        maxOutputSamples = Pcm16MonoResampler.MAX_OUTPUT_SAMPLES,
                                    )
                                }
                                val outputBuffer = decoder.getOutputBuffer(outputIndex)
                                    ?: throw IllegalStateException("The decoder returned no PCM output buffer.")
                                processor!!.consume(outputBuffer, info.offset, info.size)
                            }
                            outputEos = (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
                            decoder.releaseOutputBuffer(outputIndex, false)
                        }
                    }
                    val now = android.os.SystemClock.elapsedRealtime()
                    if (now - lastProgressAt >= 180L) {
                        val fraction = if (declaredDurationUs > 0L) {
                            (latestSampleTimeUs.toDouble() / declaredDurationUs.toDouble()).coerceIn(0.0, 1.0)
                        } else {
                            null
                        }
                        onProgress(
                            "Decoding audio",
                            fraction?.let { 0.05 + (it * 0.58) },
                        )
                        lastProgressAt = now
                    }
                }
                return (processor ?: throw IllegalArgumentException("The selected file contains no decoded PCM audio.")).finish()
            }
        } finally {
            decoder?.release()
            extractor.release()
        }
    }

    private fun outputConfiguration(format: MediaFormat): PcmOutputConfiguration {
        val sampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
        val channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
        val encodingValue = if (format.containsKey(MediaFormat.KEY_PCM_ENCODING)) {
            format.getInteger(MediaFormat.KEY_PCM_ENCODING)
        } else {
            AudioFormat.ENCODING_PCM_16BIT
        }
        val encoding = when (encodingValue) {
            AudioFormat.ENCODING_PCM_8BIT -> PcmEncoding.UNSIGNED_8
            AudioFormat.ENCODING_PCM_16BIT -> PcmEncoding.SIGNED_16
            AudioFormat.ENCODING_PCM_FLOAT -> PcmEncoding.FLOAT_32
            else -> throw IllegalArgumentException("The decoder returned an unsupported PCM encoding ($encodingValue).")
        }
        require(sampleRate > 0) { "The decoder returned an invalid sample rate." }
        require(channels in 1..8) { "The decoder returned an unsupported channel count ($channels)." }
        return PcmOutputConfiguration(sampleRate, channels, encoding)
    }

    private fun encodeOpusOgg(
        pcmFile: File,
        outputFile: File,
        onProgress: (stage: String, progress: Double?) -> Unit,
    ) {
        val format = MediaFormat.createAudioFormat(
            MIME_OPUS,
            Pcm16MonoResampler.OUTPUT_SAMPLE_RATE,
            1,
        ).apply {
            setInteger(MediaFormat.KEY_BIT_RATE, 32_000)
            setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16_384)
        }

        val encoderName = MediaCodecList(MediaCodecList.REGULAR_CODECS).findEncoderForFormat(format)
            ?: throw IllegalStateException("No compatible Android Opus encoder is available on this device.")
        val encoder = MediaCodec.createByCodecName(encoderName)
        val muxer = MediaMuxer(outputFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_OGG)
        var muxerStarted = false

        try {
            encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            encoder.start()
            FileInputStream(pcmFile).use { input ->
                var inputEos = false
                var outputEos = false
                var inputSamplesQueued = 0L
                var trackIndex = -1
                var lastProgressAt = 0L
                val totalPcmBytes = pcmFile.length().coerceAtLeast(1L)
                val info = MediaCodec.BufferInfo()

                while (!outputEos) {
                    if (!inputEos) {
                        val inputIndex = encoder.dequeueInputBuffer(CODEC_TIMEOUT_US)
                        if (inputIndex >= 0) {
                            val inputBuffer = encoder.getInputBuffer(inputIndex)
                                ?: throw IllegalStateException("The Opus encoder returned no input buffer.")
                            inputBuffer.clear()
                            val maxBytes = inputBuffer.remaining() - (inputBuffer.remaining() % 2)
                            require(maxBytes >= 2) { "The Opus encoder returned an input buffer too small for a PCM sample." }
                            val block = ByteArray(maxBytes)
                            var count = 0
                            var eof = false
                            while (count < maxBytes) {
                                val read = input.read(block, count, maxBytes - count)
                                if (read < 0) {
                                    eof = true
                                    break
                                }
                                if (read == 0) continue
                                count += read
                            }
                            if (count % 2 != 0) {
                                throw IOException("The converted PCM file ended on a partial sample.")
                            }
                            inputBuffer.put(block, 0, count)
                            val flags = if (eof && count == 0) {
                                MediaCodec.BUFFER_FLAG_END_OF_STREAM
                            } else if (eof) {
                                MediaCodec.BUFFER_FLAG_END_OF_STREAM
                            } else {
                                0
                            }
                            encoder.queueInputBuffer(
                                inputIndex,
                                0,
                                count,
                                inputSamplesQueued * 1_000_000L / Pcm16MonoResampler.OUTPUT_SAMPLE_RATE,
                                flags,
                            )
                            inputSamplesQueued += count / 2L
                            inputEos = eof
                            val now = android.os.SystemClock.elapsedRealtime()
                            if (now - lastProgressAt >= 180L) {
                                val fraction = (inputSamplesQueued * 2.0 / totalPcmBytes.toDouble()).coerceIn(0.0, 1.0)
                                onProgress("Encoding Opus audio", 0.68 + fraction * 0.29)
                                lastProgressAt = now
                            }
                        }
                    }

                    when (val outputIndex = encoder.dequeueOutputBuffer(info, CODEC_TIMEOUT_US)) {
                        MediaCodec.INFO_TRY_AGAIN_LATER -> Unit
                        MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                            if (muxerStarted) throw IllegalStateException("The Opus encoder changed its output format more than once.")
                            trackIndex = muxer.addTrack(encoder.outputFormat)
                            muxer.start()
                            muxerStarted = true
                        }
                        MediaCodec.INFO_OUTPUT_BUFFERS_CHANGED -> Unit
                        else -> if (outputIndex >= 0) {
                            if ((info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) info.size = 0
                            if (info.size > 0) {
                                check(muxerStarted && trackIndex >= 0) {
                                    "The Opus encoder emitted audio before its output format was ready."
                                }
                                val encoded = encoder.getOutputBuffer(outputIndex)
                                    ?: throw IllegalStateException("The Opus encoder returned no output buffer.")
                                encoded.position(info.offset)
                                encoded.limit(info.offset + info.size)
                                muxer.writeSampleData(trackIndex, encoded, info)
                            }
                            outputEos = (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
                            encoder.releaseOutputBuffer(outputIndex, false)
                        }
                    }
                }
            }
            check(muxerStarted) { "The Android Opus encoder never produced a muxable Ogg track." }
            muxer.stop()
            muxerStarted = false
        } finally {
            encoder.release()
            muxer.release()
        }
    }

    fun cleanupPrepared(context: Context, source: String) {
        val uri = Uri.parse(source)
        if (!uri.scheme.equals("file", ignoreCase = true)) return
        val path = uri.path ?: return
        val root = context.cacheDir.canonicalFile
        val candidate = File(path).canonicalFile
        if (candidate.parentFile == root && candidate.name.startsWith(OUTPUT_PREFIX)) {
            candidate.delete()
        }
    }

    private fun setExtractorSource(extractor: MediaExtractor, context: Context, source: String) {
        val uri = Uri.parse(source)
        when (uri.scheme?.lowercase()) {
            "content" -> extractor.setDataSource(context, uri, null)
            "file" -> extractor.setDataSource(uri.path ?: throw IllegalArgumentException("The file URI has no path."))
            "http", "https" -> extractor.setDataSource(source)
            null -> extractor.setDataSource(source)
            else -> throw IllegalArgumentException("Unsupported input URI scheme: ${uri.scheme}")
        }
    }

    private fun cleanStaleFiles(cacheDir: File) {
        val cutoff = System.currentTimeMillis() - TEMP_RETENTION_MS
        cacheDir.listFiles()?.forEach { file ->
            if ((file.name.startsWith(PCM_PREFIX) || file.name.startsWith(OUTPUT_PREFIX)) && file.lastModified() < cutoff) {
                file.delete()
            }
        }
    }

    private data class CompatibleSource(
        val uri: String,
        val size: Long,
    )

    private data class PcmOutputConfiguration(
        val sampleRate: Int,
        val channels: Int,
        val encoding: PcmEncoding,
    )

    private const val CODEC_TIMEOUT_US = 10_000L
}
