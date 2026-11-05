package com.alvarosps.financialcapture.capture
object CaptureIdentity {
  fun hash(text: String): String = java.security.MessageDigest.getInstance("SHA-256")
    .digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
  fun sourceKey(pkg: String, key: String): String = hash("$pkg\u0000$key")
  fun nextRevision(current: Int, previous: String, next: String): Int =
    if (previous == next) current else Math.addExact(current, 1)
}
