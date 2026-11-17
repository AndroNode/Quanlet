# Mainnet: risk notice

The text a person reads and acknowledges before their first deposit on a mainnet build of the site, one tick per
section (apps/web/src/app/RiskNotice.tsx shows it). It describes how the product behaves; keep both in step with the
contracts and the site.

### 1. You hold the keys. Nobody can undo a mistake.

A Quanlet vault is a smart contract on Robinhood Chain that only your keys control. Quanlet never holds
your keys or your assets, and cannot move, freeze, recover or return them. There is no administrator, no pause
and no upgrade. If a transfer is signed by your keys and executes, it is final.

> I understand that no one, including Quanlet, can reverse a transaction or recover my assets for me.

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

> I understand that my assets can be unavailable for 7 days or longer if changes follow one another.

### 4. This is new software

The contracts cannot be patched: if a flaw is found, the only fix is to move assets to a new vault, if the flaw
still allows that. Post-quantum signatures (ML-DSA-44, NIST FIPS 204) are new to blockchains, and the on-chain
verifier is vendored from Fireblocks Labs (MIT).

> I understand that the software may contain flaws that cause a total loss, and that I should deposit only what I
> can afford to lose.

### 5. Things outside Quanlet

- **Robinhood Chain** is operated by others. It can stop producing blocks, delay transactions or change. Bridges
  to and from it carry their own risks.
- **Only ETH** can be moved out of a vault on mainnet. Tokens sent to a vault address stay there for good:
  the vault cannot transfer them.
- **This website** can be unavailable. Your vault keeps working without it; the standalone toolkit can sign and
  send every action through any RPC.
- **Your devices and wallet**: Quanlet cannot protect a compromised computer, phone or browser. Quanlet never asks
  for your wallet's seed phrase. A key password is typed only into the vault pages, to open that backup in your
  own browser; it is never sent anywhere. Check that you are on quanlet.xyz before you open a backup.
- **No protection scheme**: a vault is not a bank account. Nothing is insured or covered by any deposit or
  investor protection scheme.

> I understand these risks are outside Quanlet's control.

### 6. Your responsibilities

You are responsible for your keys, backups and passwords, for checking what you sign, for complying with the laws
that apply to you, and for any taxes. Nothing on this website is financial, legal or tax advice.

> I understand and accept these responsibilities.
