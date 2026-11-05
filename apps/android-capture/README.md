# Captura Android

Coletor Kotlin para a inbox S04. As notificações geram observações para revisão: não lançam despesas, liquidam faturas nem alteram saldos. Seleção explícita de apps e mapeamento exato app + últimos quatro dígitos. Cartões adicionais podem apontar para a conta do titular.

## Build local (PowerShell)

Pré-requisitos: JDK 17, Android SDK platform 36, build-tools 36.1.0 e licenças Android aceitas. Defina JAVA_HOME e ANDROID_HOME, ou sdk.dir em local.properties (não versionado; no Windows escape os dois-pontos como C\:/...). O Gradle wrapper verifica o ZIP pelo SHA-256. Este projeto não integra o build pnpm/Next.

```powershell
Set-Location apps/android-capture
./gradlew.bat testDebugUnitTest lintDebug assembleDebug
# Somente com emulador/aparelho de teste selecionado:
$env:ANDROID_SERIAL = '<serial-do-emulador>'
./gradlew.bat connectedDebugAndroidTest
# Instalação de desenvolvimento no aparelho autorizado:
adb -s '<serial-do-aparelho>' install -r app/build/outputs/apk/debug/app-debug.apk
```

O teste do listener concede permissão apenas no emulador dedicado e usa uma notificação sintética do próprio app debug como emissor. Nunca execute a suíte instrumentada sobre uma instalação com dados pessoais. No telefone, o usuário concede o acesso na tela do sistema. A Activity Fixture, somente no APK debug, emite uma compra fictícia de R$ 12,34 para testar sem realizar pagamento; no pareamento real, essa sugestão deve ser ignorada na inbox.

## Versões verificadas em 28/09/2026

- AGP 9.1.1 (Kotlin integrado), Gradle 9.3.1, JDK Temurin 17 (patch resolvido pelo `setup-java` no CI).
- compile/target SDK 36; min SDK 26; build-tools 36.1.0.
- Room 2.8.5, WorkManager 2.11.2, KSP 2.3.6, AndroidX Core 1.17.0.
- SHA-256 wrapper JAR: b3a875ddc1f044746e1b1a55f645584505f4a10438c1afea9f15e92a7c42ec13.
- SHA-256 Gradle ZIP: b266d5ff6b90eada6dc3b20cb090e3731302e553a27c5d3e4df1f0d76beaff06.

Versões compatíveis fixadas; avisos de novas versões não equivalem a erro de lint. Fontes: [AGP](https://developer.android.com/build/releases/agp-9-1-0-release-notes), [Room](https://developer.android.com/jetpack/androidx/releases/room), [WorkManager](https://developer.android.com/jetpack/androidx/releases/work), [KSP](https://github.com/google/ksp/releases).

## Contrato e limites

- HTTPS apenas; sem redirects do endpoint nem certificados ignorados.
- POST /api/capture/pair: {code}. Código aleatório de 256 bits, validade de cinco minutos e uso único. Resposta: deviceId, token, expiresAt e catálogo id/nome dos cartões.
- POST /api/capture/events com Bearer restrito: {version:1, events:[{id,revision,parserVersion,observedAt,data}]}.
- data é o contrato S04, sempre confirmation=observed e postedDate=null. Sem userId, texto bruto, nome de pacote ou token no payload.
- Token válido por 90 dias. Renovar o mesmo dispositivo no portal preserva a identidade de eventos que aguardam envio. O token não é uma sessão web.
- Cada evento local pertence à origem HTTPS e ao dispositivo pareado na captura. A seleção do lote usa esse vínculo mesmo se o pareamento mudar durante o envio; uma resposta de credencial antiga não pausa o token renovado.
- Até 25 eventos/64 KiB por chamada; data de observação até 90 dias atrás ou cinco minutos à frente. Limites persistentes: 120 chamadas/minuto por dispositivo; teto global de 120 pareamentos e 1.000 envios/minuto.
- Fila de até 1.000 pendências. AES-GCM com Android Keystore, sem backup/transferência de dados. Texto bruto fica apenas na memória durante extração ou revisão do compartilhamento.
- Após ack, o conteúdo é apagado e resta um identificador/hash para reconhecer repetição por 30 dias. A data original da observação é preservada entre revisões. Pendências não expiram silenciosamente; consulte a fila antes de limpar.
- A instância ativa de uma notificação preserva UUID quando mantém postTime ou o horário explícito notification.when; mudança no conteúdo incrementa a revisão. Atualizações Android podem mudar postTime sem criar outra compra. Remoção e nova postagem, ou horários sem identidade confiável, geram nova evidência para revisão. O ciclo de vida fica persistido e é reconciliado com notificações ativas ao reconectar. Nunca unir compras só por valor/loja/horário. O comportamento de cada emissor precisa do piloto.
- Backoff e recuperação periódica de 15 minutos sujeitos ao Android/One UI; nenhum SLA de tempo real. Erro de credencial pausa upload; erros de evento preservam a fila para inspeção.
- Parser genérico de mensagens financeiras em português, versionado, aplicado apenas a emissores autorizados. Sem formatos reais coletados, não há garantia de cobertura para Google Wallet, Itaú ou outro banco.
- SMS: compartilhar texto manualmente. Sem READ_SMS, Accessibility ou leitura de tela. PDF continua sendo importado na web.

[Operação e piloto](../../docs/runbooks/android-capture-pilot.md).
