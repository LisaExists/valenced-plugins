@file:JvmName("CustomVoiceMessages")

package dev.lisaexists.customvoicemessages

import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import android.os.Environment
import app.valenced.plugins.plugin
import app.valenced.xposed.api.registerNativeAsyncMethod
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.Locale

private var activePicker: AudioDocumentPicker? = null
private var activeContextReady: CompletableDeferred<Context>? = null
@Volatile private var activeConversionProgress: Map<String, Any?>? = null

@Suppress("unused")
val customVoiceMessagesPlugin = plugin {
    start {
        val contextReady = CompletableDeferred<Context>()
        val picker = AudioDocumentPicker { message -> log.i(message) }
        activePicker = picker
        activeContextReady = contextReady

        withAppContext { context ->
            contextReady.complete(context.applicationContext ?: context)
        }
        withAppActivity { activity -> picker.attach(activity) }

        registerNativeAsyncMethod("${manifest.id}.pickAudio") {
            picker.pickAudio()
        }

        registerNativeAsyncMethod("${manifest.id}.prepare") { args ->
            val context = contextReady.await()
            val sourceUri = args.getOrNull(0) as? String
                ?: throw IllegalArgumentException("A selected audio-file URI is required.")

            activeConversionProgress = mapOf("stage" to "Starting conversion", "progress" to 0.0)
            try {
                withContext(Dispatchers.IO) {
                    AudioTranscoder.prepare(context, sourceUri) { stage, progress ->
                        activeConversionProgress = mapOf("stage" to stage, "progress" to progress)
                    }
                }
            } finally {
                activeConversionProgress = null
            }
        }

        registerNativeAsyncMethod("${manifest.id}.getPrepareProgress") {
            activeConversionProgress
        }

        registerNativeAsyncMethod("${manifest.id}.cleanupPrepared") { args ->
            val context = contextReady.await()
            val uri = args.getOrNull(0) as? String
                ?: throw IllegalArgumentException("A prepared audio URI is required.")
            withContext(Dispatchers.IO) {
                AudioTranscoder.cleanupPrepared(context, uri)
            }
            null
        }

        registerNativeAsyncMethod("${manifest.id}.download") { args ->
            val context = contextReady.await()
            val url = args.getOrNull(0) as? String
                ?: throw IllegalArgumentException("A download URL is required.")
            val suppliedName = args.getOrNull(1) as? String ?: "voice-message.ogg"
            val suppliedMimeType = args.getOrNull(2) as? String ?: "audio/ogg"

            withContext(Dispatchers.IO) {
                val uri = Uri.parse(url)
                val host = uri.host?.lowercase(Locale.ROOT)
                require(uri.scheme == "https" && host != null && DISCORD_CDN_HOSTS.contains(host)) {
                    "Only HTTPS Discord CDN attachment URLs can be downloaded by this action."
                }

                val filename = sanitizeFilename(suppliedName)
                val mimeType = suppliedMimeType.takeIf { it.startsWith("audio/", ignoreCase = true) }
                    ?: "application/octet-stream"
                val manager = context.getSystemService(DownloadManager::class.java)
                    ?: throw IllegalStateException("Android's DownloadManager is unavailable.")
                val request = DownloadManager.Request(uri)
                    .setTitle(filename)
                    .setDescription("Downloading a Discord voice message")
                    .setMimeType(mimeType)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename)
                manager.enqueue(request)
                true
            }
        }

        log.i("Loaded ${manifest.name}; use Voice Message in the chat attachment picker.")
    }

    stop {
        activePicker?.close()
        activePicker = null
        activeConversionProgress = null
        activeContextReady?.cancel(CancellationException("Custom Voice Messages was unloaded."))
        activeContextReady = null
        log.i("Unloaded ${manifest.id}")
    }
}

private val DISCORD_CDN_HOSTS = setOf(
    "cdn.discordapp.com",
    "cdn.discordapp.net",
    "media.discordapp.net",
)

private fun sanitizeFilename(value: String): String {
    val leaf = value.substringAfterLast('/').substringAfterLast('\\')
    val cleaned = leaf.replace(Regex("[^\\p{L}\\p{N}._ -]"), "_")
        .trim()
        .take(120)
    return cleaned.ifBlank { "voice-message.ogg" }
}
