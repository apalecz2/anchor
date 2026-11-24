# Security Policy

## Reporting a vulnerability

If you believe you have found a security vulnerability in Anchor, its website, or its
download infrastructure (`anchor-assets.aidenpaleczny.com`), please report it privately:

- **Email:** aiden.paleczny@gmail.com — use the subject line `[SECURITY] Anchor`.

Please include: a description of the issue, steps to reproduce, the app version
(Settings → About) and OS, and any proof-of-concept. **Do not open a public issue for
security reports.**

What to expect:

- **Acknowledgement within 7 days**, and a status update within 30 days.
- Anchor is maintained by a single developer; fixes for confirmed vulnerabilities are
  prioritized over all other work and shipped in the next release.
- Please practice coordinated disclosure: allow a fix to ship before publishing details.
  You will be credited in the release notes unless you prefer otherwise.

## Scope notes

Anchor is a local-first desktop app: it has no accounts, no server-side user data, and no
telemetry. The most security-relevant surfaces are:

- the **first-run asset download** (all assets are pinned to SHA-256 digests and verified
  before use; a hash mismatch rejects the file),
- the **local `llama-server` process** (bound to `127.0.0.1` on an ephemeral port), and
- **document parsing** (PDF/image handling via PDFium and Tesseract).

Reports about malicious-document handling (crashes or memory-safety issues triggered by a
crafted PDF/image) are in scope and appreciated.

## Reporting problems with AI output

Anchor uses a local generative-AI model to extract tables. If the app produces harmful,
severely incorrect, or otherwise problematic output, report it to the same email with the
subject `[AI OUTPUT] Anchor`. This address is the designated report channel for the
Microsoft Store generative-AI policy (11.16).

## Copyright / takedown contact

Anchor's first-run wizard downloads third-party open-source binaries and AI models from
a mirror operated by the author, and the Windows installer ships Microsoft's DirectML and
Visual C++ runtime libraries alongside the app (licenses and attributions in
[NOTICES.md](NOTICES.md)).
If you believe any hosted or redistributed asset infringes your rights, contact
**aiden.paleczny@gmail.com** with the subject `[COPYRIGHT] Anchor`, identifying the
material, your rights in it, and the requested action. Good-faith reports are acted on
promptly.

## Supported versions

Only the **latest released version** receives security fixes. Update via the Microsoft
Store or the latest GitHub Release.

On Windows, the DirectML and Visual C++ runtime libraries installed next to `Anchor.exe`
are private copies. Windows Update does not service them, so security fixes to those
libraries reach you only through a new Anchor release. Each release is built with the
latest Visual C++ runtime available to the build machine.
