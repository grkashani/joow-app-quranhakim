# Private JooW SDK archive

`joow-sdk-0.9.0-rc.3.tgz` is the private, unpublished and `UNLICENSED`
`@joow/sdk` release-candidate archive used by this app.

- Package: `@joow/sdk@0.9.0-rc.3`
- SDK contract: `2.1.0`
- Source repository: `shooji-SENEX/joow-sdk-ts`
- Source commit: `5cd2e23926ccaba2a0d884fd3907e25e80d47ae6`
- Source tree: `aecf9003a49ae667ff2992b5f2b12882da0cbb6b`
- SHA-256: `8cc37f103ad0cd3ffefd41490f7747b3f49c2d5d9394ed1bd5d7c75d634d65b1`

The committed archive avoids mutable Git dependencies and cross-repository
credentials during CI. It must not be published or used outside an
owner-authorized private JooW integration.

Produced with `npm pack` from the source commit above. The archive is
content-identical (`diff -r` over the unpacked trees) to the
`joow-sdk-0.9.0-rc.3.tgz` vendored by `joow-app-mail`; only the gzip framing
differs, hence the different SHA-256.
