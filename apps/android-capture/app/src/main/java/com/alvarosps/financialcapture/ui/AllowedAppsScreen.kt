package com.alvarosps.financialcapture.ui
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import com.alvarosps.financialcapture.R
import com.alvarosps.financialcapture.storage.CapturePreferences

fun showAllowedApps(activity: Activity, settings: CapturePreferences) {
  val apps = activity.packageManager.queryIntentActivities(
    Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
    .distinctBy { it.activityInfo.packageName }.sortedBy { it.loadLabel(activity.packageManager).toString() }
  val selected = settings.allowed.toMutableSet()
  val labels = apps.map { "${it.loadLabel(activity.packageManager)}\n${it.activityInfo.packageName}" }.toTypedArray()
  AlertDialog.Builder(activity).setTitle(R.string.allowed_apps)
    .setMultiChoiceItems(labels, apps.map { it.activityInfo.packageName in selected }.toBooleanArray()) { _, index, checked ->
      val pkg = apps[index].activityInfo.packageName
      if (checked) selected.add(pkg) else selected.remove(pkg)
    }.setPositiveButton(R.string.save) { _, _ -> settings.allowed = selected }
    .setNegativeButton(android.R.string.cancel, null).show()
}
