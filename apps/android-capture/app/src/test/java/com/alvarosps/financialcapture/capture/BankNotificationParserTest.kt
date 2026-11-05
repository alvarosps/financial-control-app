package com.alvarosps.financialcapture.capture

import org.junit.Assert.*
import org.junit.Test

class BankNotificationParserTest {
  @Test fun sentencePunctuationDoesNotInvalidateMoney() {
    for (text in listOf("Compra aprovada R$ 12,34.", "Compra aprovada R$ 12,34, em Loja")) {
      assertEquals("12.34", BankNotificationParser.parse(text)?.amount)
    }
  }
  @Test fun explicitTotalIsNotTurnedIntoAnInstallmentValue() {
    val result = BankNotificationParser.parse("Compra valor total R$ 1.000,00 em Loja parcela 1/10")
    assertEquals("purchase_total", result?.amountMeaning)
    assertEquals(10, result?.totalInstallments)
  }
  @Test fun capturesPurchaseWithoutInventingDate() {
    val result = BankNotificationParser.parse("Compra aprovada de R$ 123,45 em MERCADO TESTE no cartão final 1234")!!
    assertEquals("123.45", result.amount)
    assertEquals("MERCADO TESTE", result.description)
    assertEquals("1234", result.lastFour)
    assertNull(result.purchaseDate)
    assertEquals("unknown", result.amountMeaning)
  }
  @Test fun rejectsPrivateOrNonPurchaseMessages() {
    listOf("", "Seu código de verificação 123456. Compra R$ 20,00", "Compra recusada R$ 10,00",
      "Saldo disponível R$ 100,00", "Fatura paga R$ 40,00", "Pix enviado R$ 90,00",
      "Compra aprovada R$ 10,00 e limite disponível R$ 300,00")
      .forEach { assertNull(it, BankNotificationParser.parse(it)) }
  }
  @Test fun keepsInstallmentAmountAndRefundMeaning() {
    val installment = BankNotificationParser.parse("Compra aprovada R$ 89,90 em LOJA TESTE parcela 2/10")!!
    assertEquals("89.90", installment.amount)
    assertEquals(2, installment.installmentNumber)
    assertEquals(10, installment.totalInstallments)
    assertEquals("installment", installment.amountMeaning)
    assertEquals("refund", BankNotificationParser.parse("Estorno de compra R$ 25,00 em LOJA TESTE")!!.kind)
  }
  @Test fun parsesBrazilianThousandsAndExplicitTotalOnly() {
    val total = BankNotificationParser.parse("Compra aprovada valor total R$ 1.234,56 em LOJA TESTE em 3x")!!
    assertEquals("1234.56", total.amount)
    assertEquals("purchase_total", total.amountMeaning)
    assertNull(total.installmentNumber)
    assertNull(total.totalInstallments)
  }
}
