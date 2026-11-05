package com.alvarosps.financialcapture.storage
import androidx.room.*

@Entity(tableName = "capture_events", indices = [Index(value = ["owner", "identity"], unique = true)])
data class CaptureEvent(
  @PrimaryKey val id: String, val identity: String, val revision: Int,
  val fingerprint: String, val sealed: String?, val pending: Boolean, val updatedAt: Long,
  val observedAt: Long,
  val owner: String,
)
@Entity(tableName = "notification_instances", primaryKeys = ["owner", "sourceKey"], indices = [Index(value = ["sourceKey"])])
data class NotificationInstance(
  val owner: String, val sourceKey: String, val instanceId: String,
  val notificationWhen: Long, val postTime: Long, val active: Boolean, val updatedAt: Long,
)
@Dao
interface CaptureEventDao {
  @Query("SELECT * FROM capture_events WHERE identity = :identity AND owner = :owner LIMIT 1")
  fun find(identity: String, owner: String): CaptureEvent?
  @Insert(onConflict = OnConflictStrategy.REPLACE) fun put(event: CaptureEvent)
  @Query("SELECT * FROM capture_events WHERE pending = 1 AND owner = :owner ORDER BY updatedAt LIMIT 25")
  fun batch(owner: String): List<CaptureEvent>
  @Query("SELECT * FROM capture_events WHERE pending = 1 ORDER BY updatedAt LIMIT 25")
  fun inspect(): List<CaptureEvent>
  @Query("SELECT count(*) FROM capture_events WHERE pending = 1") fun pending(): Int
  @Query("UPDATE capture_events SET pending = 0, sealed = NULL WHERE id = :id AND revision = :revision")
  fun acknowledge(id: String, revision: Int): Int
  @Query("UPDATE capture_events SET pending = 0, sealed = NULL WHERE pending = 1") fun clearPending()
  @Query("DELETE FROM capture_events WHERE pending = 0 AND updatedAt < :before") fun prune(before: Long)
  @Query("SELECT * FROM notification_instances WHERE owner = :owner AND sourceKey = :key LIMIT 1")
  fun notification(owner: String, key: String): NotificationInstance?
  @Insert(onConflict = OnConflictStrategy.REPLACE) fun remember(instance: NotificationInstance)
  @Query("UPDATE notification_instances SET active = 0 WHERE sourceKey = :key") fun removed(key: String)
  @Query("UPDATE notification_instances SET active = 0 WHERE sourceKey NOT IN (:keys)") fun reconcile(keys: List<String>)
  @Query("DELETE FROM notification_instances WHERE active = 0 AND updatedAt < :before") fun pruneNotifications(before: Long)
}
