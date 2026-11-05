plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.ksp)
}
android {
  namespace = "com.alvarosps.financialcapture"
  compileSdk = 36
  buildToolsVersion = "36.1.0"
  defaultConfig {
    applicationId = "com.alvarosps.financialcapture"
    minSdk = 26
    targetSdk = 36
    versionCode = 1
    versionName = "0.1.0"
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  testOptions { unitTests.isReturnDefaultValues = true }
}
kotlin { jvmToolchain(17) }
dependencies {
  implementation(libs.room.runtime)
  ksp(libs.room.compiler)
  implementation(libs.work)
  implementation(libs.core)
  testImplementation(libs.junit)
  androidTestImplementation(libs.junit)
  androidTestImplementation(libs.test.core)
  androidTestImplementation(libs.test.runner)
}
ksp { arg("room.schemaLocation", "$projectDir/schemas") }
