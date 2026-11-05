package com.alvarosps.financialcapture.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import com.alvarosps.financialcapture.capture.CaptureIdentity

class DeviceCipher {
  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    return (store.getKey("capture-v1", null) as? SecretKey) ?: KeyGenerator
      .getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
        init(KeyGenParameterSpec.Builder("capture-v1", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
      }.generateKey()
  }
  @Synchronized fun encrypt(text: String): String {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
    return Base64.encodeToString(cipher.iv + cipher.doFinal(text.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
  }
  @Synchronized fun decrypt(text: String): String {
    val bytes = Base64.decode(text, Base64.NO_WRAP)
    require(bytes.size >= 28)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
      init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
    }
    return String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
  }
}

data class PairedDevice(val origin: String, val id: String, val token: String, val cards: String) {
  val scope: String get() = CaptureIdentity.hash("$origin\u0000$id")
}

class DeviceCredentials(context: Context, private val cipher: DeviceCipher, name: String = "credentials") {
  private val prefs = context.getSharedPreferences(name, Context.MODE_PRIVATE)
  @Synchronized fun read(): PairedDevice? = prefs.getString("sealed", null)?.let {
    val json = JSONObject(cipher.decrypt(it))
    PairedDevice(json.getString("origin"), json.getString("id"), json.getString("token"), json.getString("cards"))
  }
  @Synchronized fun save(device: PairedDevice) {
    val json = JSONObject().put("origin", device.origin).put("id", device.id)
      .put("token", device.token).put("cards", device.cards)
    check(prefs.edit().putString("sealed", cipher.encrypt(json.toString())).commit())
  }
}
