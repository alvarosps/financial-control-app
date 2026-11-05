package com.alvarosps.financialcapture.capture
import com.alvarosps.financialcapture.network.CaptureApi
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream

class CaptureTransportTest {
  @Test fun requiresHttpsOriginWithoutCredentialsOrPaths() {
    assertEquals("https://fixture.invalid", CaptureApi.origin("https://fixture.invalid/"))
    for (url in listOf("http://fixture.invalid", "https://user:secret@fixture.invalid", "https://fixture.invalid/path", "https://fixture.invalid?token=x")) {
      assertThrows(IllegalArgumentException::class.java) { CaptureApi.origin(url) }
    }
  }
  @Test fun rejectsOversizedResponsesWithoutDependingOnNewAndroidApis() {
    assertEquals(65536, CaptureApi.readLimited(ByteArrayInputStream(ByteArray(65536))).size)
    assertThrows(IllegalArgumentException::class.java) { CaptureApi.readLimited(ByteArrayInputStream(ByteArray(65537))) }
  }
  @Test fun bankWalletAndSharedSmsHaveEquivalentMinimizedFieldsWithoutImpliedDates() {
    val messages = listOf("Compra aprovada R$ 12,34 em Loja final 1234", "Você pagou R$ 12,34 em Loja final 1234", "Compra R$ 12,34 em Loja final 1234")
    for (text in messages) {
      val purchase = requireNotNull(BankNotificationParser.parse(text))
      assertEquals("12.34", purchase.amount)
      assertEquals("Loja", purchase.description)
      assertEquals("1234", purchase.lastFour)
      assertNull(purchase.purchaseDate)
      assertEquals("unknown", purchase.amountMeaning)
    }
  }
}
