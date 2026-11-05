package com.alvarosps.financialcapture.capture

import java.math.BigDecimal
import java.text.Normalizer

data class ParsedPurchase(
  val amount: String,
  val description: String,
  val currency: String = "BRL",
  val kind: String = "purchase",
  val amountMeaning: String = "unknown",
  val purchaseDate: String? = null,
  val installmentNumber: Int? = null,
  val totalInstallments: Int? = null,
  val lastFour: String? = null,
  val parserVersion: String = "financial-pt-1",
)

object BankNotificationParser {
  fun parse(text: String): ParsedPurchase? {
    if (text.length > 4000) return null
    val normalized = Normalizer.normalize(text, Normalizer.Form.NFD)
      .replace(Regex("\\p{M}"), "").lowercase()
    if (Regex("\\b(codigo|senha|token|otp|autenticacao|recusad[ao]|negad[ao]|cancelad[ao]|pix|boleto|fatura)\\b")
        .containsMatchIn(normalized)) return null
    if (!Regex("\\b(compra|comprou|pagou|estorno|reembolso|pagamento aprovado)\\b")
        .containsMatchIn(normalized)) return null
    val amounts = Regex("(R\\$|US\\$|€|£)\\s*([0-9][0-9.,]*)").findAll(text).toList()
    if (amounts.size != 1) return null
    val amountMatch = amounts.single()
    val raw = amountMatch.groupValues[2].trimEnd('.', ',')
    if (!Regex("(?:[0-9]{1,3}(?:\\.[0-9]{3})*,[0-9]{2}|[0-9]{1,12}[.,][0-9]{2})").matches(raw)) return null
    val amount = runCatching {
      BigDecimal(if (raw.contains(',')) raw.replace(".", "").replace(',', '.') else raw)
    }.getOrNull() ?: return null
    if (amount.signum() <= 0 || amount.precision() > 14) return null
    val currency = when (amountMatch.groupValues[1]) {
      "US$" -> "USD"; "€" -> "EUR"; "£" -> "GBP"; else -> "BRL"
    }
    val part = Regex("\\bparcela\\s+(\\d{1,3})/(\\d{1,3})\\b").find(normalized)
    val number = part?.groupValues?.get(1)?.toInt()
    val count = part?.groupValues?.get(2)?.toInt()
    if (number != null && (number < 1 || count == null || count > 120 || number > count)) return null
    val merchant = Regex("\\b(?:em|na|no)\\s+(.+?)(?=\\s+(?:no\\s+cart[aã]o|cart[aã]o|parcela|final|em\\s+\\d+x)\\b|$)", RegexOption.IGNORE_CASE)
      .find(text.substring(amountMatch.range.last + 1))?.groupValues?.get(1)?.trim()
    val description = merchant?.takeUnless { Regex("[0-9]{7,}").containsMatchIn(it) }?.take(200) ?: "Compra"
    return ParsedPurchase(
      amount = amount.setScale(2).toPlainString(),
      description = description,
      currency = currency,
      kind = if (Regex("\\b(estorno|reembolso)\\b").containsMatchIn(normalized)) "refund" else "purchase",
      amountMeaning = if (normalized.contains("valor total")) "purchase_total" else if (part != null) "installment" else "unknown",
      installmentNumber = number,
      totalInstallments = count,
      lastFour = Regex("\\bfinal\\s+(\\d{4})\\b").find(normalized)?.groupValues?.get(1),
    )
  }
}
