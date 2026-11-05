package com.alvarosps.financialcapture
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import android.os.Bundle
import android.widget.Button

// Debug-only synthetic notification emitter. No financial operation is performed.
class FixtureActivity : Activity() {
  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 17)
    setContentView(Button(this).apply {
      setText(R.string.fixture_notification)
      setOnClickListener {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("fixture", "Fixture", NotificationManager.IMPORTANCE_DEFAULT))
        manager.notify(System.currentTimeMillis().toInt(), Notification.Builder(this@FixtureActivity, "fixture")
          .setSmallIcon(R.drawable.ic_capture).setContentTitle("Compra aprovada")
          .setContentText("Compra R$ 12,34 em Loja Fixture final 1234").build())
      }
    })
  }
}
