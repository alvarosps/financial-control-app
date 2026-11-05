package com.alvarosps.financialcapture.storage
import androidx.room.Database
import androidx.room.RoomDatabase
@Database(entities = [CaptureEvent::class, NotificationInstance::class], version = 1, exportSchema = true)
abstract class CaptureDatabase : RoomDatabase() { abstract fun events(): CaptureEventDao }
