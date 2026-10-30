package dev.lisaexists.customvoicemessages

import android.app.Activity
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.provider.OpenableColumns
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeout
import java.lang.reflect.Method
import java.util.concurrent.atomic.AtomicReference

internal class AudioDocumentPicker(
    private val logInfo: (String) -> Unit,
) {
    private val activeActivity = AtomicReference<Activity?>(null)
    private val pendingResult = AtomicReference<CompletableDeferred<Map<String, Any?>?>?>(null)
    private val hookedClasses = mutableSetOf<String>()
    private val unhooks = mutableListOf<XC_MethodHook.Unhook>()

    @Synchronized
    fun attach(activity: Activity) {
        activeActivity.set(activity)
        var type: Class<*>? = activity.javaClass
        while (type != null && Activity::class.java.isAssignableFrom(type)) {
            if (hookedClasses.add(type.name)) {
                val resultMethods = type.declaredMethods.filter(::isActivityResultMethod)
                for (method in resultMethods) {
                    unhooks += XposedBridge.hookMethod(method, resultHook)
                }
            }
            type = type.superclass
        }
        logInfo("Audio document picker attached to ${activity.javaClass.name}")
    }

    suspend fun pickAudio(): Map<String, Any?>? {
        val activity = activeActivity.get()
            ?: throw IllegalStateException("Discord's activity is not available yet. Reopen the chat and try again.")
        val deferred = CompletableDeferred<Map<String, Any?>?>()
        check(pendingResult.compareAndSet(null, deferred)) {
            "An audio file picker is already open. Close it before opening another one."
        }

        activity.runOnUiThread {
            try {
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "audio/*"
                }
                activity.startActivityForResult(intent, REQUEST_CODE)
            } catch (error: Exception) {
                if (pendingResult.compareAndSet(deferred, null)) {
                    deferred.completeExceptionally(error)
                }
            }
        }

        return try {
            withTimeout(PICKER_TIMEOUT_MS) { deferred.await() }
        } finally {
            pendingResult.compareAndSet(deferred, null)
        }
    }

    @Synchronized
    fun close() {
        pendingResult.getAndSet(null)?.cancel()
        for (unhook in unhooks.asReversed()) unhook.unhook()
        unhooks.clear()
        hookedClasses.clear()
        activeActivity.set(null)
    }

    private val resultHook = object : XC_MethodHook() {
        override fun afterHookedMethod(param: MethodHookParam) {
            val args = param.args
            if (args.size < 3 || args[0] !is Int || args[0] != REQUEST_CODE) return
            val deferred = pendingResult.get() ?: return
            if (!pendingResult.compareAndSet(deferred, null)) return

            val resultCode = args[1] as? Int
            val data = args[2] as? Intent
            if (resultCode != Activity.RESULT_OK) {
                deferred.complete(null)
                return
            }
            val uri = data?.data
            if (uri == null) {
                deferred.completeExceptionally(
                    IllegalStateException("Android's picker returned no audio-file URI."),
                )
                return
            }

            try {
                val activity = activeActivity.get()
                    ?: throw IllegalStateException("Discord's activity disappeared while selecting audio.")
                val resultIntent = data ?: throw IllegalStateException("Android's picker returned no result intent.")
                val grantFlags = resultIntent.flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                if ((resultIntent.flags and Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) != 0 &&
                    (grantFlags and Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0
                ) {
                    try {
                        activity.contentResolver.takePersistableUriPermission(uri, grantFlags)
                    } catch (error: SecurityException) {
                        // Some document providers grant temporary access only; that grant can
                        // still be used for the current conversion, so do not reject the pick.
                        logInfo("The selected provider did not allow a persistent audio URI grant: ${error.message}")
                    }
                }
                deferred.complete(describeAudio(activity, uri))
            } catch (error: Exception) {
                deferred.completeExceptionally(error)
            }
        }
    }

    private fun describeAudio(activity: Activity, uri: Uri): Map<String, Any?> {
        var cursor: Cursor? = null
        try {
            cursor = activity.contentResolver.query(
                uri,
                arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
                null,
                null,
                null,
            )
            var displayName = "Selected audio"
            var sizeBytes: Double? = null
            if (cursor != null && cursor.moveToFirst()) {
                val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (nameIndex >= 0 && !cursor.isNull(nameIndex)) {
                    displayName = cursor.getString(nameIndex).takeIf(String::isNotBlank) ?: displayName
                }
                val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) {
                    val size = cursor.getLong(sizeIndex)
                    if (size >= 0L) sizeBytes = size.toDouble()
                }
            }
            val result = mutableMapOf<String, Any?>(
                "uri" to uri.toString(),
                "displayName" to displayName,
            )
            if (sizeBytes != null) result["sizeBytes"] = sizeBytes
            return result
        } finally {
            cursor?.close()
        }
    }

    private fun isActivityResultMethod(method: Method): Boolean =
        method.name == "onActivityResult" &&
            method.parameterTypes.size == 3 &&
            method.parameterTypes[0] == Int::class.javaPrimitiveType &&
            method.parameterTypes[1] == Int::class.javaPrimitiveType &&
            method.parameterTypes[2] == Intent::class.java

    private companion object {
        const val REQUEST_CODE = 0xC7D4
        const val PICKER_TIMEOUT_MS = 180_000L
    }
}
