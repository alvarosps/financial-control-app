package com.alvarosps.financialcapture.capture

import com.alvarosps.financialcapture.security.DeviceCipher
import com.alvarosps.financialcapture.storage.CaptureDatabase
import com.alvarosps.financialcapture.storage.CaptureEvent
import com.alvarosps.financialcapture.storage.NotificationInstance
import org.json.JSONObject
import java.time.Instant
import java.util.UUID

class CaptureRepository(private val db: CaptureDatabase, private val cipher: DeviceCipher) {
  private fun data(parsed: MappedPurchase): JSONObject {
    val p = parsed.purchase
    return JSONObject().put("cardAccountId", parsed.cardId ?: JSONObject.NULL)
      .put("description", p.description).put("amount", p.amount).put("currency", p.currency)
      .put("amountMeaning", p.amountMeaning).put("kind", p.kind)
      .put("purchaseDate", p.purchaseDate ?: JSONObject.NULL).put("postedDate", JSONObject.NULL)
      .put("installmentNumber", p.installmentNumber ?: JSONObject.NULL)
      .put("totalInstallments", p.totalInstallments ?: JSONObject.NULL).put("confirmation", "observed")
  }
  fun capture(identity: String, parsed: MappedPurchase, observedAt: Long, owner: String): Boolean {
    require(owner.isNotBlank())
    var changed = false
    db.runInTransaction {
      val dao = db.events()
      dao.prune(System.currentTimeMillis() - 30L * 86400_000)
      val fields = data(parsed)
      val fingerprint = CaptureIdentity.hash(fields.toString())
      val old = dao.find(identity, owner)
      if (old?.fingerprint == fingerprint) return@runInTransaction
      check(dao.pending() < 1000 || old?.pending == true) { "QUEUE_FULL" }
      val id = old?.id ?: UUID.randomUUID().toString()
      val revision = old?.let { CaptureIdentity.nextRevision(it.revision, it.fingerprint, fingerprint) } ?: 1
      val originalObservedAt = old?.observedAt ?: observedAt
      val observed = Instant.ofEpochMilli(originalObservedAt).toString()
      val envelope = JSONObject().put("id", id).put("revision", revision)
        .put("parserVersion", parsed.purchase.parserVersion).put("observedAt", observed).put("data", fields)
      dao.put(CaptureEvent(id, identity, revision, fingerprint, cipher.encrypt(envelope.toString()), true, System.currentTimeMillis(), originalObservedAt, owner))
      changed = true
    }
    return changed
  }
  fun decode(event: CaptureEvent): JSONObject = JSONObject(cipher.decrypt(requireNotNull(event.sealed)))
  fun notification(owner: String, key: String, notificationWhen: Long, postTime: Long, parsed: MappedPurchase, observedAt: Long): Boolean {
    var changed = false
    db.runInTransaction {
      val dao = db.events()
      val old = dao.notification(owner, key)
      val knownInstance = old != null && old.active &&
        (old.postTime == postTime || (notificationWhen > 0 && old.notificationWhen == notificationWhen))
      val instanceId = if (knownInstance) requireNotNull(old).instanceId else UUID.randomUUID().toString()
      changed = capture(instanceId, parsed, observedAt, owner)
      dao.remember(NotificationInstance(owner, key, instanceId, notificationWhen, postTime, true, observedAt))
      dao.pruneNotifications(observedAt - 30L * 86400_000)
    }
    return changed
  }
}
