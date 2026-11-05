package com.alvarosps.financialcapture

import android.content.Context
import androidx.room.Room
import com.alvarosps.financialcapture.capture.CaptureRepository
import com.alvarosps.financialcapture.security.DeviceCipher
import com.alvarosps.financialcapture.security.DeviceCredentials
import com.alvarosps.financialcapture.storage.CaptureDatabase
import com.alvarosps.financialcapture.storage.CapturePreferences
import java.util.concurrent.Executors

class CaptureGraph private constructor(context: Context) {
  val cipher = DeviceCipher()
  val credentials = DeviceCredentials(context, cipher)
  val settings = CapturePreferences(context)
  val db = Room.databaseBuilder(context, CaptureDatabase::class.java, "capture-v1.db").build()
  val repository = CaptureRepository(db, cipher)
  val executor = Executors.newSingleThreadExecutor()
  companion object {
    @Volatile private var instance: CaptureGraph? = null
    fun get(context: Context): CaptureGraph = instance ?: synchronized(this) {
      instance ?: CaptureGraph(context.applicationContext).also { instance = it }
    }
  }
}
