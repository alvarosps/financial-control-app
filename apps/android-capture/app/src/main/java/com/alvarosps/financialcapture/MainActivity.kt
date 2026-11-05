package com.alvarosps.financialcapture

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.view.WindowManager
import android.widget.*
import androidx.core.app.NotificationManagerCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.alvarosps.financialcapture.capture.*
import com.alvarosps.financialcapture.network.CaptureApi
import com.alvarosps.financialcapture.security.PairedDevice
import com.alvarosps.financialcapture.sync.UploadWorker
import com.alvarosps.financialcapture.ui.*
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

class MainActivity : Activity() {
  private val graph by lazy { CaptureGraph.get(this) }
  private var shared: String? = null
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    if (intent.action == Intent.ACTION_SEND && intent.type == "text/plain")
      shared = intent.getStringExtra(Intent.EXTRA_TEXT)?.take(4001)
  }
  override fun onResume() { super.onResume(); refresh() }
  private fun notify(message: Int) { Toast.makeText(this, message, Toast.LENGTH_LONG).show() }
  private fun cards(device: PairedDevice?): List<CardChoice> {
    val array = JSONArray(device?.cards ?: "[]")
    return (0 until array.length()).map { index -> array.getJSONObject(index).let { CardChoice(it.getString("id"), it.getString("name")) } }
  }
  private fun refresh() {
    graph.executor.execute {
      try {
        val pending = graph.db.events().pending()
        val device = graph.credentials.read()
        runOnUiThread { if (!isFinishing) render(pending, device) }
      } catch (_: Exception) { runOnUiThread { notify(R.string.storage_error) } }
    }
  }
  private fun render(pending: Int, device: PairedDevice?) {
    val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(32, 32, 32, 48) }
    val scroll = ScrollView(this).apply { addView(layout) }
    ViewCompat.setOnApplyWindowInsetsListener(scroll) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      insets
    }
    setContentView(scroll)
    layout.line(getString(R.string.app_name))
    layout.status(this, packageName in NotificationManagerCompat.getEnabledListenerPackages(this),
      graph.settings.paused, pending, graph.settings.lastEvent, graph.settings.lastDelivery, graph.settings.error)
    layout.action(R.string.notification_permission) { startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) }
    layout.action(R.string.allowed_apps) { showAllowedApps(this, graph.settings) }
    layout.action(R.string.card_mapping) { showMappings(this, graph.settings, cards(device)) }
    layout.action(if (graph.settings.paused) R.string.resume else R.string.pause) {
      if (device == null) { notify(R.string.pair_first); return@action }
      graph.settings.paused = !graph.settings.paused
      UploadWorker.schedule(this); refresh()
    }
    layout.action(R.string.refresh) { UploadWorker.schedule(this); refresh() }
    layout.action(R.string.inspect_queue) { inspectQueue() }
    layout.action(R.string.clear_queue) {
      AlertDialog.Builder(this).setMessage(R.string.clear_queue_help)
        .setPositiveButton(R.string.clear_queue) { _, _ -> graph.executor.execute { graph.db.events().clearPending(); refresh() } }
        .setNegativeButton(android.R.string.cancel, null).show()
    }
    if (device != null) {
      layout.line(getString(R.string.paired_server, device.origin))
      layout.action(R.string.open_inbox) { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("${device.origin}/purchases"))) }
      layout.action(R.string.revoke_help) { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("${device.origin}/settings"))) }
    }
    layout.line(getString(R.string.pair_help))
    val server = layout.field(R.string.server_url).apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI; setText(device?.origin.orEmpty()) }
    val code = layout.field(R.string.pair_code).apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
    layout.action(R.string.pair) {
      val address = server.text.toString()
      val secret = code.text.toString().trim()
      code.text.clear()
      graph.executor.execute {
        try {
          val origin = CaptureApi.origin(address)
          val previous = graph.credentials.read()
          // Do not exchange a one-time code against another server while events are pending.
          check(previous == null || graph.db.events().pending() == 0 || previous.origin == origin)
          val response = CaptureApi.post(origin, "pair", JSONObject().put("code", secret))
          val next = PairedDevice(origin, response.getString("deviceId"), response.getString("token"), response.getJSONArray("cards").toString())
          synchronized(graph.credentials) {
            val current = graph.credentials.read()
            check(current == null || graph.db.events().pending() == 0 || current.scope == next.scope)
            if (current != null && current.scope != next.scope) graph.settings.mappings = emptyMap()
            graph.credentials.save(next)
            graph.settings.authFailed = false
            graph.settings.error = null
          }
          UploadWorker.schedule(this)
          runOnUiThread { notify(R.string.paired); refresh() }
        } catch (_: Exception) { runOnUiThread { notify(R.string.pair_error) } }
      }
    }
    shared?.let { text -> shared = null; reviewShared(text, device) }
  }
  private fun reviewShared(text: String, device: PairedDevice?) {
    val parsed = BankNotificationParser.parse(text)
    if (parsed == null || device == null) { notify(if (device == null) R.string.pair_first else R.string.unparsed); return }
    val options = listOf(CardChoice("", getString(R.string.review_card))) + cards(device)
    val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 16, 24, 16) }
    layout.line(getString(R.string.share_help))
    layout.line(text)
    layout.line("${parsed.description}\n${parsed.currency} ${parsed.amount}\n${getString(R.string.unknown_date)}")
    val card = Spinner(this).apply { adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, options.map { it.name }); layout.addView(this) }
    AlertDialog.Builder(this).setTitle(R.string.share_title).setView(ScrollView(this).apply { addView(layout) })
      .setPositiveButton(R.string.send_review) { _, _ ->
        val cardId = options[card.selectedItemPosition].id.ifBlank { null }
        graph.executor.execute {
          try {
            synchronized(graph.credentials) {
              val current = graph.credentials.read()
              check(current?.scope == device.scope)
              graph.repository.capture(CaptureIdentity.hash("shared:${UUID.randomUUID()}"), MappedPurchase(parsed, cardId), System.currentTimeMillis(), device.scope)
            }
            graph.settings.lastEvent = System.currentTimeMillis()
            UploadWorker.schedule(this)
            refresh()
          } catch (_: Exception) { runOnUiThread { notify(R.string.storage_error) } }
        }
      }.setNegativeButton(android.R.string.cancel, null).show()
  }
  private fun inspectQueue() {
    graph.executor.execute {
      try {
        val events = graph.db.events().inspect()
        val labels = events.map {
          val data = graph.repository.decode(it).getJSONObject("data")
          "${data.getString("description")} — ${data.getString("currency")} ${data.getString("amount")}"
        }.toTypedArray()
        runOnUiThread {
          if (events.isEmpty()) { notify(R.string.empty_queue); return@runOnUiThread }
          AlertDialog.Builder(this).setTitle(R.string.inspect_queue).setItems(labels) { _, index ->
            AlertDialog.Builder(this).setMessage(getString(R.string.discard_one, labels[index]))
              .setPositiveButton(R.string.discard) { _, _ -> graph.executor.execute {
                graph.db.events().acknowledge(events[index].id, events[index].revision); refresh()
              } }.setNegativeButton(android.R.string.cancel, null).show()
          }.setNegativeButton(android.R.string.cancel, null).show()
        }
      } catch (_: Exception) { runOnUiThread { notify(R.string.storage_error) } }
    }
  }
}
