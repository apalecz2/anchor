# Anchor Privacy Policy

**Effective date / last updated: November 24, 2026**

This Privacy Policy describes how **Anchor** (the desktop application for Windows and
macOS, the "App"), its marketing website, and its download service handle information.
Anchor is developed and published by **Aiden Paleczny** ("we", "us"), in Ontario, Canada,
who is the data controller for the limited processing described below. Contact:
**aiden.paleczny@gmail.com**.

## 1. Information the App processes (locally only)

Anchor's purpose is to extract structured tables from documents you choose (PDFs and
images). Those documents may contain personal or sensitive information. All of the
following is created and stored **only on your device**, in the App's data directory
(`com.aidenpaleczny.anchor` under your operating system's application-data folder):

- the documents you open, and page images rendered from them;
- text recognized from those documents (OCR output) and the tables extracted from them,
  including provenance and confidence data;
- a local SQLite database of your sessions and settings.

**None of this content is transmitted to us or to any third party.** Optical character
recognition and AI extraction both run on your device: OCR via a local OCR engine
(oar-ocr by default, or Tesseract), and extraction via a local AI model served by a `llama-server` process that
listens only on your own machine's loopback interface (`127.0.0.1`). Exported files
(XLSX/CSV) are written only where you choose to save them.

We have no access to your documents or extracted data, and therefore cannot view,
recover, or delete them for you.

## 2. The App's only network activity

The App makes network connections in exactly one situation: the **first-run setup
download** (and any later re-download you initiate, e.g. after removing downloaded data).
During setup, the App downloads the components it needs to work (the Tesseract OCR
engine, the OCR recognition models, the llama.cpp model server, the PDFium renderer,
optional GPU runtime libraries, and AI model files, ~3.5 GB total) from:

- `anchor-assets.aidenpaleczny.com`, a download mirror we operate on Cloudflare R2; with
- `huggingface.co` as a fallback source for the AI model files.

These requests **send no personal information and no document content**; they are plain
file downloads. Like any web server, the download service receives standard connection
metadata (your IP address, user-agent, and the requested file) as an unavoidable part of
delivering a file over the internet.

**Cloudflare, Inc.** operates that infrastructure as our processor, under its Data
Processing Addendum, which incorporates the European Commission's Standard Contractual
Clauses as the transfer mechanism for personal data leaving the EEA, the UK, or
Switzerland. We have enabled **no log export, no analytics, and no audience measurement**
on the service: we never receive, export, or retain a copy of that connection metadata,
and it expires on Cloudflare's own short operational retention schedule for the service.
We do not use this metadata to identify users, do not combine it with any other data, and
receive no per-user analytics from it. Every downloaded file is verified against a pinned
SHA-256 checksum before use.

After setup completes, the App works **fully offline**. It performs no update checks, no
crash reporting, no analytics, and no other network calls. (The App's internal
communication with its local model server stays on `127.0.0.1` and never leaves your
machine.) The App's fonts and icons, and on Windows the runtime libraries it needs in
order to start, are bundled into the installer rather than fetched at launch, so nothing is
requested from a third party at launch or afterwards.

If you install Anchor from the Microsoft Store, Microsoft may process installation and
licensing data under [Microsoft's privacy statement](https://privacy.microsoft.com/); we
do not receive personal information from it.

## 3. Your control and data deletion

Everything the App stores is on your device and under your control:

- **Delete sessions** in the App to remove their documents, images, and extracted data
  from the local database.
- **Remove all downloaded data** (models, binaries, cache, database) via the App's
  settings, or by deleting the `com.aidenpaleczny.anchor` application-data folder.
- Uninstalling the App removes the program; if any downloaded data remains in the
  application-data folder, it can be deleted as above.

Because we hold no copy of your data, there is nothing for us to delete, export, or
disclose on our side.

## 4. The website

Our marketing website is a static site with **no accounts, no analytics scripts, no
advertising, and no tracking cookies**. It also loads **no third-party resources**: fonts,
icons, and images are served from the site's own origin, so visiting it makes no request
to any other company, and no third party receives your IP address as a result of the
visit. Its hosting infrastructure receives standard server-log metadata (IP address,
user-agent, pages requested) as an inherent part of serving web pages, used only for
operation and abuse prevention, on the same terms described for the download service in
§2.

## 5. Children

Anchor is a productivity tool, is not directed at children, and collects no personal
information from anyone, including children.

## 6. Legal bases, your rights, and international use

Anchor is designed so that no personal data is collected or transmitted by us. To the
extent that transient connection metadata in §2 and §4 constitutes personal data in your
jurisdiction (e.g. under the GDPR or UK GDPR), it is processed on the basis of legitimate
interest in operating and securing the download service and the website, is minimal, and
is not used for profiling or automated decision-making. You may use the App entirely
offline after setup.

Where the GDPR or UK GDPR applies to you, you have the rights of access, rectification,
erasure, restriction, objection, and data portability in respect of personal data we hold
about you. In practice we hold none: we receive no copy of the metadata described in §2
and §4, so there is nothing for us to retrieve, correct, or erase, and a request will be
answered saying so. You also have the right to **lodge a complaint with your local data
protection supervisory authority** (in the EEA, your national authority; in the UK, the
Information Commissioner's Office).

**We do not sell or share personal information**, and have never done so, as those terms
are used in the California Consumer Privacy Act as amended by the CPRA. We do not process
personal information for cross-context behavioural advertising, and there is no
"Do Not Sell or Share" choice to offer because there is no such processing to opt out of.

## 7. Changes to this policy

If Anchor ever gains features that change what this policy describes (for example crash
reporting, update checks, payments, any third-party resource loaded by the website, or any
transmission of data off the device), this policy will be updated **before** that feature
ships, with a new "last updated" date, and material changes will be highlighted in the
release notes. The current version is always available at the URL where you are reading it
and in the App's About screen.

## 8. Contact

Questions or concerns about privacy: **aiden.paleczny@gmail.com**.
