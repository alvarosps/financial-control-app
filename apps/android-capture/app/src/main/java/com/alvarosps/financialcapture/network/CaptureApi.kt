package com.alvarosps.financialcapture.network

import org.json.JSONObject
import java.net.URI
import java.io.ByteArrayOutputStream
import java.io.InputStream
import javax.net.ssl.HttpsURLConnection

class CaptureHttpException(val status: Int) : Exception("HTTP_$status")

object CaptureApi {
  fun readLimited(stream: InputStream): ByteArray {
    val result = ByteArrayOutputStream()
    val buffer = ByteArray(4096)
    while (true) {
      val count = stream.read(buffer)
      if (count < 0) break
      require(result.size() + count <= 65536)
      result.write(buffer, 0, count)
    }
    return result.toByteArray()
  }
  fun origin(input: String): String {
    val uri = URI(input.trim())
    require(uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.userInfo == null
      && uri.rawQuery == null && uri.rawFragment == null && (uri.path.isNullOrEmpty() || uri.path == "/"))
    return "https://" + uri.rawAuthority
  }
  fun post(origin: String, endpoint: String, body: JSONObject, token: String? = null): JSONObject {
    require(endpoint == "pair" || endpoint == "events")
    val connection = URI("${origin(origin)}/api/capture/$endpoint").toURL().openConnection() as HttpsURLConnection
    try {
      connection.requestMethod = "POST"
      connection.instanceFollowRedirects = false
      connection.connectTimeout = 15000
      connection.readTimeout = 20000
      connection.doOutput = true
      connection.setRequestProperty("Content-Type", "application/json")
      token?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
      val bytes = body.toString().toByteArray(Charsets.UTF_8)
      require(bytes.size <= 65536)
      connection.setFixedLengthStreamingMode(bytes.size)
      connection.outputStream.use { it.write(bytes) }
      val status = connection.responseCode
      if (status !in 200..299) throw CaptureHttpException(status)
      val response = connection.inputStream.use { readLimited(it) }
      require(response.size <= 65536)
      return JSONObject(String(response, Charsets.UTF_8))
    } finally { connection.disconnect() }
  }
}
