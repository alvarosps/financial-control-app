package com.alvarosps.financialcapture.ui
import android.app.Activity
import android.app.AlertDialog
import android.text.InputFilter
import android.text.InputType
import android.widget.*
import com.alvarosps.financialcapture.R
import com.alvarosps.financialcapture.storage.CapturePreferences

data class CardChoice(val id: String, val name: String)
fun showMappings(activity: Activity, settings: CapturePreferences, cards: List<CardChoice>) {
  val apps = settings.allowed.sorted()
  if (apps.isEmpty() || cards.isEmpty()) {
    Toast.makeText(activity, R.string.mapping_prerequisite, Toast.LENGTH_LONG).show(); return
  }
  val layout = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 16, 24, 16) }
  layout.line(activity.getString(R.string.mapping_help))
  val pkg = Spinner(activity).apply { adapter = ArrayAdapter(activity, android.R.layout.simple_spinner_dropdown_item, apps); layout.addView(this) }
  val digits = layout.field(R.string.last_four).apply { inputType = InputType.TYPE_CLASS_NUMBER; filters = arrayOf(InputFilter.LengthFilter(4)) }
  val card = Spinner(activity).apply { adapter = ArrayAdapter(activity, android.R.layout.simple_spinner_dropdown_item, cards.map { it.name }); layout.addView(this) }
  settings.mappings.forEach { (key, id) -> layout.line("$key → ${cards.find { it.id == id }?.name ?: activity.getString(R.string.review_card)}") }
  AlertDialog.Builder(activity).setTitle(R.string.card_mapping).setView(ScrollView(activity).apply { addView(layout) })
    .setPositiveButton(R.string.save) { _, _ ->
      if (digits.text.toString().matches(Regex("[0-9]{4}"))) {
        settings.mappings = settings.mappings + ("${apps[pkg.selectedItemPosition]}:${digits.text}" to cards[card.selectedItemPosition].id)
      } else Toast.makeText(activity, R.string.four_required, Toast.LENGTH_LONG).show()
    }.setNeutralButton(R.string.clear_mappings) { _, _ -> settings.mappings = emptyMap() }
    .setNegativeButton(android.R.string.cancel, null).show()
}
