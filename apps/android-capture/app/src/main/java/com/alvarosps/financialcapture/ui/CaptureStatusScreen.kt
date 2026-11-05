package com.alvarosps.financialcapture.ui
import android.app.Activity
import android.widget.*
import com.alvarosps.financialcapture.R
import java.text.DateFormat
import java.util.Date

fun LinearLayout.line(text: String) { addView(TextView(context).apply { this.text = text; textSize = 16f; setPadding(0, 12, 0, 12) }) }
fun LinearLayout.action(label: Int, click: () -> Unit) { addView(Button(context).apply { setText(label); setOnClickListener { click() } }) }
fun LinearLayout.field(label: Int): EditText = EditText(context).also { it.setHint(label); it.isSingleLine = true; addView(it) }
fun LinearLayout.status(activity: Activity, permission: Boolean, paused: Boolean, pending: Int, lastEvent: Long, lastDelivery: Long, error: String?) {
  line(activity.getString(R.string.coverage_warning))
  line(activity.getString(if (permission) R.string.permission_on else R.string.permission_off))
  line(activity.getString(if (paused) R.string.paused else R.string.running))
  line(activity.getString(R.string.pending, pending))
  fun date(value: Long) = if (value == 0L) activity.getString(R.string.none) else DateFormat.getDateTimeInstance().format(Date(value))
  line(activity.getString(R.string.last_event, date(lastEvent)))
  line(activity.getString(R.string.last_delivery, date(lastDelivery)))
  if (error != null) line(activity.getString(
    if (error == "HTTP_401" || error == "HTTP_403") R.string.auth_error
    else if (error.startsWith("HTTP_4")) R.string.event_error else R.string.retry_error))
}
