package com.alvarosps.financialcapture.sync
import com.alvarosps.financialcapture.capture.CaptureRepository
import com.alvarosps.financialcapture.security.DeviceCredentials
import com.alvarosps.financialcapture.security.PairedDevice
import com.alvarosps.financialcapture.storage.CaptureDatabase
import com.alvarosps.financialcapture.storage.CapturePreferences
import org.json.JSONObject
import org.json.JSONArray
import com.alvarosps.financialcapture.network.CaptureHttpException

enum class UploadOutcome { DONE, RETRY, REJECTED }
class CaptureUploader(
  private val db: CaptureDatabase, private val repository: CaptureRepository,
  private val credentials: DeviceCredentials, private val settings: CapturePreferences,
  private val send: (PairedDevice, JSONObject) -> JSONObject,
) {
  fun upload(stopped: () -> Boolean = { false }): UploadOutcome {
    if (settings.paused || settings.authFailed) return UploadOutcome.DONE
    var attempted: PairedDevice? = null
    try {
      val device = credentials.read() ?: return UploadOutcome.DONE
      attempted = device
      repeat(4) {
        if (stopped() || settings.paused) return UploadOutcome.DONE
        val batch = db.events().batch(device.scope)
        if (batch.isEmpty()) return UploadOutcome.DONE
        val events = JSONArray()
        batch.forEach { events.put(repository.decode(it)) }
        val response = send(device, JSONObject().put("version", 1).put("events", events))
        val acknowledgements = response.getJSONArray("acknowledgements")
        require(acknowledgements.length() == batch.size)
        val expected = batch.associateBy { it.id }
        val seen = mutableSetOf<String>()
        for (index in 0 until acknowledgements.length()) {
          val ack = acknowledgements.getJSONObject(index)
          val id = ack.getString("id")
          require(seen.add(id) && expected[id]?.revision == ack.getInt("revision"))
        }
        db.runInTransaction {
          batch.forEach { db.events().acknowledge(it.id, it.revision) }
        }
        settings.lastDelivery = System.currentTimeMillis()
        settings.error = null
      }
      return if (db.events().pending() > 0) UploadOutcome.RETRY else UploadOutcome.DONE
    } catch (error: CaptureHttpException) {
      if (error.status == 401 || error.status == 403) {
        return synchronized(credentials) {
          val current = credentials.read()
          if (current?.scope != attempted?.scope || current?.token != attempted?.token) {
            UploadOutcome.RETRY
          } else {
            settings.error = "HTTP_${error.status}"
            settings.authFailed = true
            UploadOutcome.DONE
          }
        }
      }
      settings.error = "HTTP_${error.status}"
      return if (error.status == 400 || error.status == 404 || error.status == 409 || error.status == 413)
        UploadOutcome.REJECTED else UploadOutcome.RETRY
    } catch (_: Exception) {
      settings.error = "NETWORK_OR_STORAGE"
      return UploadOutcome.RETRY
    }
  }
}
