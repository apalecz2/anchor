# Anchor End User License Agreement & Terms of Use

**Effective date / last updated: November 24, 2026**

This End User License Agreement ("**Agreement**") is between you and **Aiden Paleczny**
("**Licensor**", "we") and governs your use of the **Anchor** desktop application,
including its documentation and any updates (the "**App**"), and, per Section 15, the
Anchor website. By installing or using the App you agree to this Agreement. If you do not
agree, do not install or use the App.

*Note: this Agreement governs your use of the installed App. The source code of Anchor is
separately licensed under the Elastic License 2.0 (see the repository `LICENSE` file);
nothing in this Agreement limits rights that license grants you with respect to the
source code.*

## 1. License grant and eligibility

Subject to this Agreement, Licensor grants you a personal, worldwide, non-exclusive,
non-transferable, non-sublicensable license to install and use the App on devices you own
or control, for any lawful purpose, including commercial use of the App's output.

You must be of the age of majority in your place of residence, and otherwise legally able
to enter into a binding contract, to accept this Agreement. If you accept it on behalf of
an organization, you represent that you have authority to bind that organization, and
"you" then means that organization.

## 2. Free and paid functionality

The App's core functionality is free of charge. Certain additional features (for example,
multi-page document extraction) may be offered as "**Paid Features**", unlocked by a
one-time purchase and enabled by a license key or equivalent activation mechanism.

- A Paid Features purchase grants a perpetual license to the purchased features for the
  purchased major version of the App, for your own use, on devices you own or control.
- You may not share, resell, or publish license keys, and you may not bypass, remove,
  disable, or circumvent the license-key or feature-gating functionality of the App, nor
  distribute copies of the App with such functionality bypassed.
- Prices, the feature split between free and paid tiers, and availability may change;
  changes do not affect features you have already purchased.
- **Refunds and billing** are handled by the store or payment platform through which you
  purchased (e.g. the Microsoft Store), under its terms. Where no platform policy
  applies, contact us within 14 days of purchase for a refund if the Paid Features do not
  work on your system. Nothing in this section limits any non-waivable statutory refund
  or warranty rights you have under local consumer law.

## 3. Pre-release software

The App is currently distributed as **pre-release (beta) software**, and installers may be
unsigned. Pre-release software is made available for evaluation: it is incomplete, is
expected to contain defects, may change or lose functionality between versions, and may
fail in ways that interrupt your work. Do not use it as the only tool in a workflow where
an interruption or a defect would cause harm or loss, and keep your own copies of any
source documents you process. Sections 9 (no warranty) and 10 (limitation of liability)
apply with particular force to pre-release versions.

## 4. AI-generated output: verify before relying on it

The App extracts tables using optical character recognition and a **local generative AI
model**:

- **Output may be inaccurate, incomplete, or wrong.** OCR can misread characters; the AI
  model can misplace, merge, invent, or omit values. The App's confidence indicators and
  provenance highlighting are aids to review; **they are not a guarantee of accuracy**,
  and a "high confidence" marking can still be wrong.
- **You are solely responsible for verifying extracted data against the source document
  before relying on it or providing it to others.** Do not use unverified output for any
  purpose where an error could cause harm or loss, including financial, accounting, tax,
  medical, legal, safety, or regulatory purposes.
- **The App is a data-entry tool, not a source of professional advice.** It does not
  provide financial, accounting, tax, medical, legal, or other professional advice, and
  neither the App nor its output is a substitute for the judgment of a qualified
  professional. Any decision you take on the basis of extracted data is your own.
- The App produces output only from documents you supply; the model runs on your device
  and output is shown only to you. It is your responsibility to review output before any
  further use or distribution.

## 5. Your documents and your responsibilities

You retain all rights in the documents you process and in the extracted output. The App
sends neither off your device (see the [Privacy Policy](PRIVACY.md)). You are responsible
for (a) having the necessary rights to the documents you process, and (b) your compliance
with laws that apply to your use of the App and its output, including privacy and data
protection laws covering personal data contained in your documents.

## 6. Acceptable use

You may not use the App: (a) in violation of applicable law or third-party rights; (b) to
process documents you have no right to process; or (c) in any manner intended to
circumvent Section 2 (feature gating) or to misrepresent AI-generated output as
verified/certified data where accuracy is legally required.

## 7. Third-party components

The App is built with, downloads, and redistributes third-party software, font software,
and AI models — including llama.cpp, Tesseract OCR, PDFium, ONNX Runtime and the
PaddleOCR PP-OCRv6 recognition models, Microsoft DirectML, the Microsoft Visual C++ runtime
libraries and NVIDIA CUDA runtime libraries (Windows only, the latter where applicable), the
Qwen3.5 model, and the Inter, Source Serif 4, and Material Symbols typefaces. These
components are licensed under their own terms, reproduced in the App's **Licenses &
Notices** screen and in the repository's `NOTICES.md`; this Agreement does not modify those
licenses. Some components are included in the installer; the rest are fetched on first run
from Licensor's mirror (or the upstream source) and verified against pinned SHA-256
checksums.

**Proprietary runtime components.** The Microsoft Visual C++ runtime libraries and the NVIDIA
CUDA runtime libraries are proprietary to Microsoft Corporation and NVIDIA Corporation
respectively, not open source. They are redistributed under those companies' redistribution
terms and are licensed, not sold, solely for use as part of the App. You may not (a) use them
separately from the App, provide them as a stand-alone offering, or incorporate them into other
software; (b) copy (except as part of installing the App), share, publish, distribute, rent,
lease, lend, sublicense, or transfer them; (c) modify them or create derivative works of them;
(d) reverse engineer, decompile, or disassemble them, or otherwise attempt to derive their
source code, except to the extent applicable law expressly permits despite this limitation;
(e) work around any technical limitations, security, or authentication mechanisms in them; or
(f) remove, minimize, block, or modify any copyright, trademark, or other notice of Microsoft,
NVIDIA, or their suppliers in them. Microsoft, NVIDIA, and their suppliers
provide these components "as is", without any warranty, and are not liable to you for any
damages arising from your use of them; Section 9 and Section 10 apply to them as they do to
the rest of the App.

## 8. Updates

Updates may be delivered through your installation channel (e.g. the Microsoft Store) and
may add, change, or remove functionality. This Agreement applies to updates unless an
update is accompanied by revised terms, in which case the revised terms apply from the
version they accompany. We have no obligation to provide updates or support, though we
aim to fix reported problems (see `SECURITY.md` for contact).

## 9. NO WARRANTY

**THE APP IS PROVIDED "AS IS" AND "AS AVAILABLE", WITH ALL FAULTS AND WITHOUT WARRANTY OF
ANY KIND. TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, LICENSOR DISCLAIMS ALL
WARRANTIES AND CONDITIONS, EXPRESS, IMPLIED, OR STATUTORY, INCLUDING ANY IMPLIED
WARRANTIES OF MERCHANTABILITY, SATISFACTORY QUALITY, FITNESS FOR A PARTICULAR PURPOSE,
ACCURACY, NON-INFRINGEMENT, AND UNINTERRUPTED OR ERROR-FREE OPERATION. WITHOUT LIMITING
THE FOREGOING, LICENSOR MAKES NO WARRANTY THAT EXTRACTED DATA WILL BE ACCURATE, COMPLETE,
OR FIT FOR YOUR PURPOSES.** Some jurisdictions do not allow the exclusion of certain
warranties, so parts of this section may not apply to you; in that case the excluded
warranties are limited to the minimum scope and period required by law.

## 10. LIMITATION OF LIABILITY

**TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, AND REGARDLESS OF THE THEORY OF
LIABILITY — WHETHER IN CONTRACT, TORT (INCLUDING NEGLIGENCE), STRICT LIABILITY, BREACH OF
STATUTORY DUTY, OR OTHERWISE, AND EVEN IF A REMEDY FAILS OF ITS ESSENTIAL PURPOSE: (A)
LICENSOR SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL,
EXEMPLARY, OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF PROFITS, REVENUE, DATA, GOODWILL, OR
BUSINESS OPPORTUNITY, OR FOR THE COST OF SUBSTITUTE SERVICES, ARISING OUT OF OR RELATED TO
THIS AGREEMENT OR THE APP, INCLUDING ANY DAMAGES ARISING FROM RELIANCE ON INACCURATE OR
INCOMPLETE EXTRACTED DATA, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES; AND (B)
LICENSOR'S TOTAL AGGREGATE LIABILITY ARISING OUT OF OR RELATED TO THIS AGREEMENT OR THE
APP SHALL NOT EXCEED THE GREATER OF THE AMOUNT YOU PAID FOR THE APP IN THE TWELVE (12)
MONTHS BEFORE THE CLAIM AROSE OR TEN US DOLLARS (US$10).** Nothing in this Agreement
excludes or limits liability that cannot be excluded or limited under applicable law
(including liability for death or personal injury caused by negligence, fraud, or wilful
misconduct), or your non-waivable statutory consumer rights.

## 11. Indemnification

To the maximum extent permitted by applicable law, you will defend, indemnify, and hold
harmless Licensor against any third-party claim, demand, proceeding, loss, liability,
damage, cost, or expense (including reasonable legal fees) arising out of or related to:
(a) the documents you process with the App, including any claim that processing them
infringed a third party's rights or breached a privacy or data-protection obligation you
owed; (b) your use of the App or of its output, including any distribution of or reliance
on extracted data; or (c) your breach of this Agreement, in particular Sections 5 and 6.

Licensor will notify you of any such claim, will not settle it without your consent (not
to be unreasonably withheld), and may participate in its defence with counsel of
Licensor's choosing at Licensor's own expense. This section does not apply to the extent a
claim arises from Licensor's own fraud or wilful misconduct, and does not apply where you
are a consumer and applicable consumer law prohibits it.

## 12. Time limit on claims

To the maximum extent permitted by applicable law, any claim arising out of or related to
this Agreement or the App must be brought within **one (1) year** after the claimant knew
or reasonably should have known of the facts giving rise to it; a claim brought after that
period is permanently barred. Where applicable law does not permit this period to be
shortened, the statutory limitation period applies instead.

## 13. Termination

This Agreement is effective until terminated. It terminates automatically if you
materially breach it (including Section 2's anti-circumvention terms or Section 6). Upon
termination you must stop using and uninstall the App. Sections 2 (anti-circumvention and
no-resale), 4, 5, 9, 10, 11, 12, 14, 15, 16, and 17 survive termination. You may terminate
at any time by uninstalling the App.

## 14. Export compliance

The App uses only standard TLS for downloads and contains no proprietary cryptography.
You agree not to use or export the App in violation of applicable export-control or
sanctions laws.

## 15. Website terms

The Anchor website (including its download pages) is provided "as is" for informational
purposes. Its content is Copyright (c) Aiden Paleczny except where attributed; downloads
obtained through it are governed by this Agreement and the licenses in `NOTICES.md`.
Links to third-party sites are provided for convenience and are not endorsements. The
warranty disclaimer (Section 9), the liability limitation (Section 10), the indemnity
(Section 11), and the time limit on claims (Section 12) apply equally to the website.
Copyright or takedown concerns: see Section 18.

## 16. Governing law and disputes

This Agreement is governed by the laws of the Province of Ontario and the federal laws of
Canada applicable therein, excluding their conflict-of-laws rules, and the courts of
Ontario have exclusive jurisdiction over disputes arising from it, except that if you are
a consumer, you retain any right under local law to bring proceedings in, and be protected
by the mandatory consumer laws of, your country of residence. The United Nations
Convention on Contracts for the International Sale of Goods does not apply.

## 17. General

This Agreement (with the Privacy Policy and, for source code, the repository `LICENSE`)
is the entire agreement regarding the App and supersedes prior communications. If any
provision is held unenforceable, it will be enforced to the maximum extent permissible
and the remainder stays in effect. A failure to enforce a provision is not a waiver. You
may not assign this Agreement; Licensor may assign it in connection with a transfer of
the Anchor product. Material changes to these terms will be published with a new
effective date before they apply.

This Agreement creates no rights in any third party, and no person other than you and
Licensor may enforce any of its terms. Licensor is not liable for any failure or delay in
performance caused by events beyond its reasonable control.

## 18. Contact

**aiden.paleczny@gmail.com**
