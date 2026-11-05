package com.alvarosps.financialcapture.capture
import org.junit.Assert.*
import org.junit.Test

class CaptureIdentityTest {
  @Test fun sourceKeysAreStableAndSeparateEmittersDoNotMerge() {
    val original = CaptureIdentity.sourceKey("bank.fixture", "key")
    assertEquals(original, CaptureIdentity.sourceKey("bank.fixture", "key"))
    assertNotEquals(original, CaptureIdentity.sourceKey("bank.fixture", "another-key"))
    assertNotEquals(original, CaptureIdentity.sourceKey("wallet.fixture", "key"))
    assertEquals(3, CaptureIdentity.nextRevision(2, "old", "changed"))
    assertEquals(2, CaptureIdentity.nextRevision(2, "same", "same"))
  }
  @Test fun filtersBeforeParsingAndUsesExactCardMappingOnly() {
    val registry = ParserRegistry(setOf("bank.fixture"), mapOf("bank.fixture:1234" to "card-a", "bank.fixture:5678" to "card-b"))
    assertNull(registry.parse("other.fixture", "Compra R$ 10,00 em Loja final 1234", false))
    assertNull(registry.parse("bank.fixture", "Compra R$ 10,00 em Loja final 1234", true))
    assertEquals("card-a", registry.parse("bank.fixture", "Compra R$ 10,00 em Loja final 1234", false)?.cardId)
    assertEquals("card-b", registry.parse("bank.fixture", "Compra R$ 10,00 em Loja final 5678", false)?.cardId)
    assertNull(registry.parse("bank.fixture", "Compra R$ 10,00 em Loja", false)?.cardId)
    assertNull(registry.parse("bank.fixture", "Seu codigo OTP de compra R$ 10,00: 123456", false))
  }
}
