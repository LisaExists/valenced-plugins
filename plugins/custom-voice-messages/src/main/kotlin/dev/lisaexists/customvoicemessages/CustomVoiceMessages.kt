@file:JvmName("CustomVoiceMessages")

package dev.lisaexists.customvoicemessages

import android.content.Context
import app.valenced.plugins.plugin
import app.valenced.xposed.api.registerNativeAsyncMethod
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

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
