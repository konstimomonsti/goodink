package app.goodink.notes

// Files picked or saved through Android's system picker are content:// URIs, not paths. goodink
// works with paths, so a picked file is copied into the app's cache under its real name (importUri),
// and an export is written to a cache file first and then copied to the place picked (exportUri).
// Copies stream on a background thread; nothing passes through the web view.

import android.app.Activity
import android.net.Uri
import android.provider.OpenableColumns
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class ImportArgs {
  lateinit var uri: String
}

@InvokeArg
class ExportArgs {
  lateinit var path: String
  lateinit var uri: String
}

@TauriPlugin
class FilesPlugin(private val activity: Activity) : Plugin(activity) {
  private fun displayName(uri: Uri): String {
    var name: String? = null
    try {
      activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst() && !c.isNull(0)) name = c.getString(0)
      }
    } catch (_: Exception) {
    }
    if (name.isNullOrBlank()) name = uri.lastPathSegment?.substringAfterLast('/')
    val clean = (name ?: "file").replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), "_").trim().trimStart('.')
    return clean.ifEmpty { "file" }
  }

  @Command
  fun importUri(invoke: Invoke) {
    val args = invoke.parseArgs(ImportArgs::class.java)
    Thread {
      try {
        val uri = Uri.parse(args.uri)
        val dir = File(activity.cacheDir, "imports/${System.nanoTime()}")
        dir.mkdirs()
        val out = File(dir, displayName(uri))
        val input = activity.contentResolver.openInputStream(uri) ?: throw Exception("The file could not be opened")
        input.use { i -> out.outputStream().use { o -> i.copyTo(o, 1 shl 16) } }
        val ret = JSObject()
        ret.put("path", out.absolutePath)
        invoke.resolve(ret)
      } catch (e: Exception) {
        invoke.reject(e.message ?: "The file could not be read")
      }
    }.start()
  }

  @Command
  fun exportUri(invoke: Invoke) {
    val args = invoke.parseArgs(ExportArgs::class.java)
    Thread {
      try {
        val src = File(args.path)
        // "wt": replace what was there (a file picked to be overwritten)
        val output = activity.contentResolver.openOutputStream(Uri.parse(args.uri), "wt") ?: throw Exception("The place could not be written")
        output.use { o -> src.inputStream().use { i -> i.copyTo(o, 1 shl 16) } }
        src.delete()
        invoke.resolve()
      } catch (e: Exception) {
        invoke.reject(e.message ?: "The file could not be saved")
      }
    }.start()
  }
}
