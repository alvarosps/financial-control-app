package com.alvarosps.financialcapture.capture

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import com.alvarosps.financialcapture.CaptureGraph
import com.alvarosps.financialcapture.sync.UploadWorker

class BankNotificationListener : NotificationListenerService() {
  override fun onListenerConnected() {
    val graph = CaptureGraph.get(this)
    val active = activeNotifications.orEmpty().filter { it.packageName in graph.settings.allowed }
    graph.executor.execute {
      graph.db.events().reconcile(active.map { CaptureIdentity.sourceKey(it.packageName, it.key) })
    }
    active.forEach { onNotificationPosted(it) }
    UploadWorker.schedule(this)
  }
  override fun onNotificationRemoved(sbn: StatusBarNotification) {
    val graph = CaptureGraph.get(this)
    val key = CaptureIdentity.sourceKey(sbn.packageName, sbn.key)
    graph.executor.execute { graph.db.events().removed(key) }
  }
  override fun onNotificationPosted(sbn: StatusBarNotification) {
    val graph = CaptureGraph.get(this)
    if (graph.settings.paused || sbn.packageName !in graph.settings.allowed) return
    if (sbn.notification.flags and Notification.FLAG_GROUP_SUMMARY != 0) return
    val extras = sbn.notification.extras
    val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
    val body = (extras.getCharSequence(Notification.EXTRA_BIG_TEXT)
      ?: extras.getCharSequence(Notification.EXTRA_TEXT))?.toString().orEmpty()
    val parsed = ParserRegistry(graph.settings.allowed, graph.settings.mappings)
      .parse(sbn.packageName, "$title $body", false) ?: return
    val key = CaptureIdentity.sourceKey(sbn.packageName, sbn.key)
    val observed = System.currentTimeMillis()
    graph.executor.execute {
      try {
        if (graph.settings.paused || sbn.packageName !in graph.settings.allowed) return@execute
        val changed = synchronized(graph.credentials) {
          val device = graph.credentials.read() ?: return@execute
          graph.repository.notification(device.scope, key, sbn.notification.`when`, sbn.postTime, parsed, observed)
        }
        if (changed) {
          graph.settings.lastEvent = observed
          UploadWorker.schedule(this)
        }
      } catch (_: Exception) { graph.settings.error = "STORAGE" }
    }
  }
}
