package com.alvarosps.financialcapture

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.alvarosps.financialcapture.capture.*
import com.alvarosps.financialcapture.security.DeviceCipher
import com.alvarosps.financialcapture.storage.CaptureDatabase
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.util.UUID
import com.alvarosps.financialcapture.security.DeviceCredentials
import com.alvarosps.financialcapture.security.PairedDevice
import com.alvarosps.financialcapture.storage.CapturePreferences
import com.alvarosps.financialcapture.sync.CaptureUploader
import com.alvarosps.financialcapture.sync.UploadOutcome
import com.alvarosps.financialcapture.network.CaptureHttpException
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException

class CapturePipelineTest {
  @Test fun ownershipChangeBeforeBatchSelectionNeverUsesPreviousCredentials() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    val name = "fixture-${UUID.randomUUID()}"
    val db = Room.databaseBuilder(context, CaptureDatabase::class.java, "$name.db").build()
    val cipher = DeviceCipher()
    val credentials = DeviceCredentials(context, cipher, "$name-credentials")
    val settings = CapturePreferences(context, "$name-settings")
    try {
      val a = PairedDevice("https://a.invalid", "a", "a-token", "[]")
      val b = PairedDevice("https://b.invalid", "b", "b-token", "[]")
      credentials.save(a); settings.paused = false
      val repository = CaptureRepository(db, cipher)
      val purchase = MappedPurchase(requireNotNull(BankNotificationParser.parse("Compra R$ 12,34 em Loja")), null)
      val sent = mutableListOf<String>()
      val uploader = CaptureUploader(db, repository, credentials, settings) { device, body ->
        sent.add(device.id)
        val event = body.getJSONArray("events").getJSONObject(0)
        JSONObject().put("acknowledgements", JSONArray().put(JSONObject().put("id", event.getString("id")).put("revision", event.getInt("revision"))))
      }
      var changed = false
      uploader.upload {
        if (!changed) { changed = true; credentials.save(b); repository.capture("b", purchase, System.currentTimeMillis(), b.scope) }
        false
      }
      assertTrue("new owner data sent with previous credentials: $sent", sent.isEmpty())
      assertEquals(1, db.events().pending())
    } finally { db.close(); context.deleteDatabase("$name.db"); context.deleteSharedPreferences("$name-credentials"); context.deleteSharedPreferences("$name-settings") }
  }
  @Test fun oldUnauthorizedResponseDoesNotPauseRenewedCredentials() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    val name = "fixture-${UUID.randomUUID()}"
    val db = Room.databaseBuilder(context, CaptureDatabase::class.java, "$name.db").build()
    val cipher = DeviceCipher()
    val credentials = DeviceCredentials(context, cipher, "$name-credentials")
    val settings = CapturePreferences(context, "$name-settings")
    try {
      val first = PairedDevice("https://fixture.invalid", "fixture", "old-token", "[]")
      credentials.save(first); settings.paused = false
      val repository = CaptureRepository(db, cipher)
      repository.capture("fixture", MappedPurchase(requireNotNull(BankNotificationParser.parse("Compra R$ 12,34 em Loja")), null), System.currentTimeMillis(), first.scope)
      val uploader = CaptureUploader(db, repository, credentials, settings) { _, _ ->
        credentials.save(first.copy(token = "new-token")); settings.authFailed = false
        throw CaptureHttpException(401)
      }
      assertEquals(UploadOutcome.RETRY, uploader.upload())
      assertFalse(settings.authFailed)
      assertEquals(1, db.events().pending())
    } finally { db.close(); context.deleteDatabase("$name.db"); context.deleteSharedPreferences("$name-credentials"); context.deleteSharedPreferences("$name-settings") }
  }
  @Test fun lostResponseRetriesExactEnvelopeAndRevocationPreservesQueue() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    val name = "fixture-${UUID.randomUUID()}"
    val db = Room.databaseBuilder(context, CaptureDatabase::class.java, "$name.db").build()
    val cipher = DeviceCipher()
    val credentials = DeviceCredentials(context, cipher, "$name-credentials")
    val settings = CapturePreferences(context, "$name-settings")
    try {
      credentials.save(PairedDevice("https://fixture.invalid", "fixture", "fixture-token", "[]"))
      settings.paused = false
      val repository = CaptureRepository(db, cipher)
      val purchase = MappedPurchase(requireNotNull(BankNotificationParser.parse("Compra R$ 12,34 em Loja")), null)
      repository.capture("fixture", purchase, System.currentTimeMillis(), requireNotNull(credentials.read()).scope)
      val deliveries = mutableListOf<String>()
      val uploader = CaptureUploader(db, repository, credentials, settings) { _, body ->
        deliveries.add(body.toString())
        if (deliveries.size == 1) throw IOException("simulated lost response")
        val event = body.getJSONArray("events").getJSONObject(0)
        JSONObject().put("acknowledgements", JSONArray().put(JSONObject().put("id", event.getString("id")).put("revision", event.getInt("revision"))))
      }
      assertEquals(UploadOutcome.RETRY, uploader.upload())
      assertEquals(1, db.events().pending())
      assertEquals(UploadOutcome.DONE, uploader.upload())
      assertEquals(deliveries[0], deliveries[1])
      assertEquals(0, db.events().pending())
      repository.capture("other", purchase, System.currentTimeMillis(), requireNotNull(credentials.read()).scope)
      val unauthorized = CaptureUploader(db, repository, credentials, settings) { _, _ -> throw CaptureHttpException(401) }
      assertEquals(UploadOutcome.DONE, unauthorized.upload())
      assertTrue(settings.authFailed)
      assertEquals(1, db.events().pending())
      assertEquals(UploadOutcome.DONE, CaptureUploader(db, repository, credentials, settings) { _, _ -> throw AssertionError("revoked credential retried") }.upload())
    } finally {
      db.close(); context.deleteDatabase("$name.db")
      context.deleteSharedPreferences("$name-credentials"); context.deleteSharedPreferences("$name-settings")
    }
  }
  @Test fun encryptedQueueSurvivesReopenAndOldAckDoesNotEraseNewRevision() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    val name = "fixture-${UUID.randomUUID()}.db"
    fun open() = Room.databaseBuilder(context, CaptureDatabase::class.java, name).build()
    var db = open()
    try {
      var repository = CaptureRepository(db, DeviceCipher())
      val purchase = MappedPurchase(requireNotNull(BankNotificationParser.parse("Compra R$ 123,45 em Loja final 1234")), null)
      val observed = System.currentTimeMillis() - 60000
      assertTrue(repository.capture("fixture", purchase, observed, "fixture"))
      val first = db.events().inspect().single()
      assertFalse(requireNotNull(first.sealed).contains("Loja"))
      val firstEnvelope = repository.decode(first).toString()
      db.close()
      db = open()
      repository = CaptureRepository(db, DeviceCipher())
      assertEquals(firstEnvelope, repository.decode(db.events().inspect().single()).toString())
      assertFalse(repository.capture("fixture", purchase, observed + 1000, "fixture"))
      assertTrue(repository.capture("fixture", purchase.copy(purchase = purchase.purchase.copy(description = "Loja corrigida")), observed + 2000, "fixture"))
      val updated = db.events().inspect().single()
      assertEquals(first.id, updated.id)
      assertEquals(2, updated.revision)
      assertEquals(0, db.events().acknowledge(first.id, 1))
      assertEquals(1, db.events().pending())
      assertEquals(1, db.events().acknowledge(first.id, 2))
      assertNull(db.events().find("fixture", "fixture")?.sealed)
      assertFalse(repository.capture("fixture", purchase.copy(purchase = purchase.purchase.copy(description = "Loja corrigida")), observed + 3000, "fixture"))
      assertTrue(repository.capture("fixture", purchase, observed + 4000, "fixture"))
      assertEquals(repository.decode(first).getString("observedAt"), repository.decode(db.events().inspect().single()).getString("observedAt"))
      db.events().clearPending()
      assertEquals(0, db.events().pending())
    } finally { db.close(); context.deleteDatabase(name) }
  }

  @Test fun realListenerAcceptsOnlyAuthorizedFixturePackage() {
    assumeTrue("Only the dedicated emulator grants synthetic notification permissions", Build.FINGERPRINT.contains("generic") || Build.MODEL.contains("sdk"))
    val instrument = InstrumentationRegistry.getInstrumentation()
    val target = instrument.targetContext
    val emitter = target
    val graph = CaptureGraph.get(target)
    fun shell(command: String) { instrument.uiAutomation.executeShellCommand(command).use { android.os.ParcelFileDescriptor.AutoCloseInputStream(it).readBytes() } }
    val component = "${target.packageName}/com.alvarosps.financialcapture.capture.BankNotificationListener"
    shell("cmd notification allow_listener $component")
    if (Build.VERSION.SDK_INT >= 33) shell("pm grant ${emitter.packageName} android.permission.POST_NOTIFICATIONS")
    val manager = emitter.getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(NotificationChannel("fixture", "Synthetic fixture", NotificationManager.IMPORTANCE_DEFAULT))
    graph.credentials.save(PairedDevice("https://fixture.invalid", "fixture", "fixture-token", "[]"))
    graph.settings.authFailed = true
    graph.settings.paused = false
    graph.settings.allowed = emptySet()
    // Upload is blocked: synthetic observations remain local.
    val before = graph.db.events().pending()
    val eventTime = System.currentTimeMillis()
    fun awaitCondition(message: String, condition: () -> Boolean) {
      val deadline = android.os.SystemClock.uptimeMillis() + 10000
      while (!condition() && android.os.SystemClock.uptimeMillis() < deadline) Thread.sleep(100)
      assertTrue(message, condition())
    }
    fun post(id: Int, description: String = "Loja Fixture") = manager.notify(id, Notification.Builder(emitter, "fixture")
      .setWhen(eventTime)
      .setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle("Compra aprovada")
      .setContentText("Compra R$ 12,34 em $description final 1234").build())
    try {
      Thread.sleep(1500)
      post(101)
      Thread.sleep(750)
      assertEquals(before, graph.db.events().pending())
      graph.settings.allowed = setOf(emitter.packageName)
      post(102)
      awaitCondition("authorized notification captured") { graph.db.events().pending() == before + 1 }
      assertEquals(before + 1, graph.db.events().pending())
      val original = graph.db.events().inspect().last()
      post(102)
      Thread.sleep(500)
      assertEquals("same active notification repeated", before + 1, graph.db.events().pending())
      post(102, "Loja Corrigida")
      awaitCondition("notification update captured") {
        graph.db.events().inspect().any { it.id == original.id && it.revision == 2 }
      }
      val updated = graph.db.events().inspect().last()
      assertEquals(original.id, updated.id)
      assertEquals(2, updated.revision)
      val notification = manager.activeNotifications.single { it.id == 102 }
      val key = CaptureIdentity.sourceKey(emitter.packageName, notification.key)
      val owner = requireNotNull(graph.credentials.read()).scope
      manager.cancel(102)
      awaitCondition("notification removal persisted") { graph.db.events().notification(owner, key)?.active == false }
      post(102)
      awaitCondition("reused notification id captured as a new event") { graph.db.events().pending() == before + 2 }
      assertEquals("reused notification id must be a new event", before + 2, graph.db.events().pending())
    } finally {
      graph.settings.paused = true
      graph.settings.allowed = emptySet()
      graph.db.events().clearPending()
      manager.cancelAll()
      shell("cmd notification disallow_listener $component")
    }
  }
}
