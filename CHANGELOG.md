# Changelog

All notable changes to `@kashdao/cli` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the package is `0.x`, minor versions may include breaking changes —
breaking changes are explicitly called out in the entry. See the
**Stability promise** section of `README.md` for what is and is not part
of the SemVer-stable contract.

The runtime contract surface (error envelope, version manifest, config
envelope, command tree) is also pinned by `tests/unit/contracts.test.ts`
— any drift there forces a deliberate update to both the schema and
the test, which surfaces in this changelog.

## [Unreleased]
