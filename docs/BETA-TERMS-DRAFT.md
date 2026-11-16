# Mainnet beta: risk notice and terms (draft for legal review)

Status: **draft, not in force, not legal advice.** The development team wrote this so counsel starts from the
product's actual behaviour. Counsel decides the final wording, structure and anything jurisdiction-specific.
Text in [square brackets] is a decision for the project owner or counsel. Nothing here has been reviewed by a
lawyer.

Where it will appear: the risk notice (Part A) is shown on a mainnet build before a person's first deposit, and they
tick each acknowledgement to continue. The terms (Part B) are linked from the footer and from the notice
(`packages/config` `beta.termsUrl`). Part C lists what we need counsel to answer.

---

## Part A. Risk notice

Plain language, shown in full. Each heading ends with a statement the person acknowledges.

### 1. You hold the keys. Nobody can undo a mistake.

A Quanlet vault is a smart contract on Robinhood Chain that only your keys control. [Operator name] never holds
your keys or your assets, and cannot move, freeze, recover or return them. There is no administrator, no pause
and no upgrade. If a transfer is signed by your keys and executes, it is final.

> I understand that no one, including [operator name], can reverse a transaction or recover my assets for me.

### 2. Five keys, and what each one can do

Each vault has five keys, each saved to its own password-protected backup file:

- **Primary** signs every payment. On its own it can pay only the recipients you listed for FAST, up to the FAST
  allowance you set. If it is stolen, the thief can move up to that allowance, but only to those recipients.
- **Approver** co-signs every other payment and every change to the rules or keys.
- **Guardians 1 to 3** exist only to recover the vault. Any two of them can replace the primary and approver. This
  takes 7 days, during which nothing can leave the vault, and **the primary and approver cannot stop it**. Only two
  guardians can cancel it.

So: if someone gets two of your guardian keys, they can take control of the vault after 7 days. If you lose keys
beyond what your guardians can replace, the assets in the vault are lost for good.

A backup file and its password together are the key. Anyone who has both can sign as that key.

> I understand what each of my keys can do, that two guardians together can take over the vault in 7 days, and
> that losing my keys can mean losing my assets permanently.

### 3. Delays and frozen funds

Payments outside FAST wait the delay you chose (none, 1 hour, 24 hours or 72 hours) and must then be executed
within 7 days. A change to the rules or to the primary and approver waits the same delay; a recovery or a guardian
change waits 7 days. While any change is pending, nothing can leave the vault. Plan for times when you cannot move
your assets.

> I understand that my assets can be unavailable for up to [7 days, or longer if changes follow one another].

### 4. This is new software

The vault contracts were reviewed by [review firms] in [month year] ([links to the reports]). A review reduces risk;
it does not remove it. The contracts cannot be patched: if a flaw is found, the only fix is to move assets to a new
vault, if the flaw still allows that. Post-quantum signatures (ML-DSA-44, NIST FIPS 204) are new to blockchains, and
the on-chain verifier is [vendored from Fireblocks Labs and reviewed as part of the review above].

During the beta this website keeps each vault at or below [cap] ETH. That is a limit of this website only: the
contracts accept any deposit, and anyone can send assets straight to a vault's address.

> I understand that the software may contain flaws that cause a total loss, and that I should deposit only what I
> can afford to lose.

### 5. Things outside Quanlet

- **Robinhood Chain** is operated by others. It can stop producing blocks, delay transactions or change. Bridges
  to and from it carry their own risks.
- **Tokens** are issued by others, who may be able to freeze or change them. A vault only protects who may move
  them.
- **This website** can be unavailable. Your vault keeps working without it; the standalone toolkit can sign and
  send every action through any RPC [once it is published].
- **Your devices and wallet**: Quanlet cannot protect a compromised computer, phone or browser. Quanlet never asks
  for your wallet's seed phrase. A key password is typed only into the vault pages, to open that backup in your
  own browser; it is never sent anywhere. Check that you are on [quanlet.xyz] before you open a backup.
- **No protection scheme**: a vault is not a bank account. Nothing is insured or covered by any deposit or
  investor protection scheme.

> I understand these risks are outside [operator name]'s control.

### 6. Your responsibilities

You are responsible for your keys, backups and passwords, for checking what you sign, for complying with the laws
that apply to you, and for any taxes. Nothing on this website is financial, legal or tax advice.

> I have read the beta terms.

---

## Part B. Beta terms (structure and plain-language intent)

Counsel to draft the legal text. Each clause states what it must achieve and the product facts it rests on.

| # | Clause | Intent and facts |
| --- | --- | --- |
| 1 | Parties, acceptance | Who offers the website ([legal entity, registered address]); using the website or toolkit means accepting these terms; the risk notice is part of them. |
| 2 | Eligibility | [Minimum age 18]; not a person or resident of a sanctioned or [restricted] jurisdiction; not acting for one. [Whether and how the website restricts access, see Part C.] |
| 3 | What we provide | The website, the open-source vault contracts, the standalone toolkit and documentation. Non-custodial: we never hold keys or assets and cannot act on a vault. The contracts have no owner and keep working if the website stops. |
| 4 | Beta conditions | Capped beta: the website keeps each vault at or below [cap] ETH and supports [assets]. We may change, limit or end the website, the cap or the supported assets at any time; that cannot affect a deployed vault. No promise of availability. |
| 5 | Your responsibilities | Keys, backups, passwords and devices; checking every summary before signing; choosing recipients and delays; compliance with applicable law; taxes. |
| 6 | No advice | Nothing is financial, investment, legal or tax advice. No fiduciary relationship. |
| 7 | Fees | [No fee during the beta.] Relay fees, if a person chooses to pay one, are signed by that person and go to the recipient they name. Network gas is paid to Robinhood Chain, not to us. |
| 8 | Prohibited use | Unlawful activity, sanctions evasion, interfering with the website or other people's vaults. Security research only under the bug bounty rules (`docs/BUG-BOUNTY.md`), which include a safe harbour. |
| 9 | Open source and licences | Smart contracts under MIT; the website, Worker API and toolkit under AGPL-3.0-only. Third-party code under its own licence (ML-DSA-44 verifier: MIT, Fireblocks Labs). Trademarks: Robinhood is a third party; no affiliation or endorsement is claimed. |
| 10 | Disclaimers | Website and software provided as is, without warranties, to the extent the law allows. |
| 11 | Limitation of liability | [Cap and exclusions, as counsel advises]. Must not claim to exclude liability that cannot be excluded where the person lives. |
| 12 | Indemnity | [If any, as counsel advises.] |
| 13 | Changes and ending | How changes to these terms are announced and take effect; ending access to the website does not end anyone's control of their vault. |
| 14 | Privacy | What the website processes: wallet addresses the person connects, and the vault details kept in their own browser. [Server logs at Cloudflare; any analytics.] Link to a privacy notice. |
| 15 | Law and disputes | [Governing law, venue or arbitration.] |
| 16 | Contact | [Legal contact address]; security reports to [security address] (`SECURITY.md`). |

---

## Part C. Questions for counsel

1. **Regulatory status.** The operator never holds keys or assets and cannot act on a vault; it publishes software
   and a website that helps people sign and send their own transactions. Does this need a licence or registration
   (for example as a virtual asset service provider or money transmitter) in [target jurisdictions]?
2. **Access restrictions.** Must the website block access from certain places, or screen connected wallet
   addresses against sanctions lists? The contracts cannot block anyone.
3. **The beta cap.** The cap is a website limit and the contracts accept any deposit. Is describing it this way
   enough, or does a published cap create an expectation we cannot enforce?
4. **Consumer law.** Which disclosures and cooling-off or withdrawal rules apply to a free, non-custodial website
   in [target jurisdictions], and can liability be limited as in clause 11?
5. **Third-party code.** The signature verifier is vendored from Fireblocks Labs (MIT) and was not audited
   upstream. What should the terms say about it?
6. **Token statement.** Quanlet has no token. Should the terms say so, to counter impersonation?
7. **Names.** The product runs on Robinhood Chain and names it. Is our current "independent project, no
   affiliation or endorsement" statement enough?
8. **Acknowledgements.** Is a tick-box acknowledgement per section of Part A adequate evidence of informed
   acceptance, and should it be repeated when the terms change?
