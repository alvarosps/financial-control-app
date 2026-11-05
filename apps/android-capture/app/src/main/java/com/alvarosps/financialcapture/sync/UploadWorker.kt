package com.alvarosps.financialcapture.sync

import android.content.Context
import androidx.work.*
import com.alvarosps.financialcapture.CaptureGraph
import com.alvarosps.financialcapture.network.CaptureApi
import java.util.concurrent.TimeUnit

class UploadWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  override fun doWork(): Result {
    val graph = CaptureGraph.get(applicationContext)
    val uploader = CaptureUploader(graph.db, graph.repository, graph.credentials, graph.settings) { device, body ->
      CaptureApi.post(device.origin, "events", body, device.token)
    }
    return when (uploader.upload { isStopped }) {
      UploadOutcome.DONE -> Result.success()
      UploadOutcome.RETRY -> Result.retry()
      UploadOutcome.REJECTED -> Result.failure()
    }
  }

  companion object {
    fun schedule(context: Context) {
      val manager = WorkManager.getInstance(context)
      val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
      manager.enqueueUniqueWork("capture-upload", ExistingWorkPolicy.KEEP,
        OneTimeWorkRequestBuilder<UploadWorker>().setConstraints(constraints)
          .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build())
      manager.enqueueUniquePeriodicWork("capture-recovery", ExistingPeriodicWorkPolicy.KEEP,
        PeriodicWorkRequestBuilder<UploadWorker>(15, TimeUnit.MINUTES).setConstraints(constraints).build())
    }
  }
}
