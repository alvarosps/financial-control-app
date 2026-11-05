# Third-party software

The MIT license in this repository covers the project's original code. Third-party packages and assets retain their own copyright notices and licenses. Preserve those notices when distributing dependencies or bundled artifacts. Review the licenses included in the resolved packages for complete terms.

Run `pnpm licenses list` after installing the lockfile to inspect the dependencies resolved for your platform. The dependency inventory includes MIT, Apache-2.0, ISC, BSD, MPL-2.0, CC-BY-4.0 and other open licenses. Some optional native Sharp packages include LGPL-licensed libvips components. Redistributing native binaries requires reviewing their accompanying notices and source availability requirements.

The Gradle wrapper JAR comes from the Gradle project and is covered by Apache-2.0. The repository's Android workflow verifies its SHA-256 before running it. Gradle, AndroidX and Android build dependencies include their own notices when downloaded. The wrapper distribution URL and checksum are pinned in `apps/android-capture/gradle/wrapper/gradle-wrapper.properties`.

The UI uses Lucide icons under ISC and shadcn/ui components under MIT. Dependency metadata and individual package license files provide author attribution and full license text. Bank and retailer names in the fictional demo are labels for synthetic examples and do not imply affiliation or endorsement.
