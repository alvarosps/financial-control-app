package com.alvarosps.financialcapture.storage
import android.content.Context
import org.json.JSONObject
class CapturePreferences(context: Context, name: String = "capture-settings") {
  private val prefs = context.getSharedPreferences(name, Context.MODE_PRIVATE)
  var paused: Boolean
    get() = prefs.getBoolean("paused", true)
    set(value) { check(prefs.edit().putBoolean("paused", value).commit()) }
  var authFailed: Boolean
    get() = prefs.getBoolean("authFailed", false)
    set(value) { check(prefs.edit().putBoolean("authFailed", value).commit()) }
  var error: String?
    get() = prefs.getString("error", null)
    set(value) { prefs.edit().putString("error", value).apply() }
  var lastEvent: Long
    get() = prefs.getLong("lastEvent", 0)
    set(value) { prefs.edit().putLong("lastEvent", value).apply() }
  var lastDelivery: Long
    get() = prefs.getLong("lastDelivery", 0)
    set(value) { prefs.edit().putLong("lastDelivery", value).apply() }
  var allowed: Set<String>
    get() = prefs.getStringSet("allowed", emptySet())?.toSet() ?: emptySet()
    set(value) { check(prefs.edit().putStringSet("allowed", value.toSet()).commit()) }
  var mappings: Map<String, String>
    get() {
      val json = JSONObject(prefs.getString("mappings", "{}") ?: "{}")
      return json.keys().asSequence().associateWith { json.getString(it) }
    }
    set(value) { check(prefs.edit().putString("mappings", JSONObject(value).toString()).commit()) }
}
