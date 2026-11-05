package com.alvarosps.financialcapture.capture
data class MappedPurchase(val purchase: ParsedPurchase, val cardId: String?)
class ParserRegistry(private val allowed: Set<String>, private val mappings: Map<String, String>) {
  fun parse(pkg: String, text: String, groupSummary: Boolean): MappedPurchase? {
    if (pkg !in allowed || groupSummary) return null
    val purchase = BankNotificationParser.parse(text) ?: return null
    val card = purchase.lastFour?.let { mappings["$pkg:$it"] }
    return MappedPurchase(purchase, card)
  }
}
