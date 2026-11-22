# The decoy

A DocLock doc can hold two texts: Yours, and a decoy. Each has its own
password. If you are ever forced to hand over a password, you give the
decoy's. It opens a harmless, believable text, and the doc does not show
that it holds anything else. This gives you plausible deniability; the
technique is known as
[deniable encryption](https://en.wikipedia.org/wiki/Deniable_encryption).

It is meant for people with no right to your text: A thief, an attacker,
someone threatening you. It is no defence against a lawful order
([the law](#the-law-and-your-responsibility)).

> **Read this first. Never unlock a doc with its decoy password to test
> it.** That removes your real text from the doc, and your real password no
> longer opens it. To look at your decoy, use **⋮ → Decoy…** in the editor.
> If it already happened: [Getting your text back](#getting-your-text-back).

## Using it

- **New doc:** On the password screen, tap **Add a decoy** and type a
  second password. DocLock then opens the Decoy screen, where you write
  the decoy's text.
- **Any doc:** In the editor, open the **⋮** menu and choose **Decoy…**.
  There you set, see, edit or remove the decoy's password and text.
- **Pick a password you will remember under pressure.** A sentence works
  well, like `My first bike, was red!` with your own words. It must differ
  from the doc's real password.
- **Make the text believable.** Something worth encrypting: A made-up
  wallet key, an old password list, private notes.

## Getting your text back

**Unlocking with the decoy password removes your real text from the doc.**
DocLock cannot avoid this: It must treat the doc exactly as it treats a
DocLock doc without a decoy. Everything looks normal when it happens: The
editor, the menu, "Unlocked". Nothing tells you, or anyone, that it was the
decoy. After that, your real password answers "Wrong password, or the doc
is damaged."

Your text is in an earlier version of the doc. There are two ways back.

**In the same browser: Just type your real password.** DocLock keeps the
last 20 saved versions of each doc in the browser, still encrypted. When
your password opens nothing in the doc but opens one of those, DocLock
offers to bring it back and saves it afresh. This leaves no trace.

**Anywhere else: Google Docs' version history.**

1. On a computer, open the doc in Google Docs. The Google Docs phone apps
   do not show version history.
2. **File → Version history → See version history.**
3. Pick the last version from before the decoy password was used. Go by
   date and time: The versions all look alike.
4. **Restore this version.**
5. In DocLock, open the doc again and type your real password. Wrong
   password again? Restore an earlier version and try again.

Restoring also brings the decoy back as it was. Do it soon: Google may
merge old versions over time, so do not count on them being kept forever.

A restored version stays in the history as an exact copy of an older one,
which no ordinary save produces. Someone studying the history closely
could notice it. To avoid that, do not restore: Copy the encrypted block
out of the old version (from `#####  DocLock…` to `#####  End…`), paste it
into a new Google Doc, and open that one in DocLock.

## What it costs

Room for a decoy is built into every DocLock doc, whether you set one or
not, and that has a price. These are accepted compromises of the design:

- **Unlocking with the decoy password removes your real text from the
  doc.** [Getting your text back](#getting-your-text-back) explains this
  and the ways back.
- **Every DocLock doc is the same size, with or without a decoy:** About
  89,000 characters of encrypted text, roughly 30 pages in Google Docs,
  even when your own text is one line.
- **A DocLock doc has room for a limited amount of your text:** About
  75,000 characters of ordinary writing, or about 40,000 if it is all
  random letters and digits (passwords, keys). In a DocLock doc with a
  decoy, the decoy's text uses part of that room. The editor shows how
  full the doc is when it gets close, and will not save past the limit.
  For more text, use a second doc.
- **Every unlock saves the doc again**, with or without a decoy, so each
  unlock adds a version to the doc's history in Google Docs. The text
  shows first and the save follows in the background, a second or two
  later. (Offline, with view-only access, or when the page is closed
  before that save is sent, there is none: The doc just opens.)
- **A DocLock doc with a decoy keeps no draft of unsaved changes in the
  browser**, so they do not survive a crash or a closed tab. A DocLock doc
  without a decoy does keep one. DocLock asks before you lock or reload
  with unsaved changes.

## Why the doc does not give it away

- **Every DocLock doc has two slots of the same size.** One holds your
  text. The other holds the decoy or, in a DocLock doc without a decoy,
  random bytes. Encrypted text and random bytes look the same, so the doc
  does not show which of the two it holds.
- **Every DocLock doc is the same length**, whatever it holds.
- **Each save writes both slots again**, in a random order, so neither
  their position nor the doc's history shows which slot you use.
- **Every unlock saves the doc once more**, freshly encrypted. Saves where
  the text did not change are therefore normal in every DocLock doc.
- **The decoy knows nothing of the real text.** Opened with the decoy
  password, the doc is like any DocLock doc without a decoy: The same
  screens, the same menu, an empty **Decoy…** screen.
- **The password of any DocLock doc can be changed** (**⋮ → Change
  password…**), so a password that does not open the doc's oldest versions
  is normal too. That is what a decoy added later looks like.
- **A DocLock doc with a decoy keeps no draft in the browser.** A draft
  that only the real password opens would show that the doc has a decoy.
  DocLock asks before you lock or reload with unsaved changes instead.

The code is public, and that is fine: It shows that any DocLock doc *may*
have a decoy, never whether yours does.

## What it cannot do

- **It cannot make someone believe you.** Anyone who knows DocLock knows
  that any DocLock doc may have a decoy, and you cannot prove yours has
  none either.
- **It does not hide the pattern of your saves.** Google's history shows
  every save and its time. While you work on your real text, the decoy
  stays the same, so its history reads as a text that is opened and saved
  often but rarely edited. Each save is explained by an unlock, but over a
  long history the pattern is a hint. Editing the decoy now and then makes
  it weaker. An empty decoy text is the clearest case: Always write one.
- **A password that opens only the newer versions can be questioned.** Any
  password may have been changed, but you cannot produce the "old" one.
  A decoy set when the doc is created opens every version.
- **Someone who can edit the doc can damage it.** Changing the part their
  password does not open harms nothing in a DocLock doc without a decoy,
  and destroys the real text in one with a decoy. What you do next (getting it
  back) can then show there was something to get back.
- **Someone who knows the decoy password and can still edit the doc can
  set a trap.** DocLock notices it and stops, but only if you let it:
  See [If someone tampers with the doc](#if-someone-tampers-with-the-doc).
- **It does not protect an unlocked screen.** While your real text is open,
  someone looking can see it, and the **Decoy…** screen shows the decoy.
- **It does not clean your device.** Browser history, screenshots, notes
  about your real password, or deleted data that can still be read from the
  disk are outside DocLock. **Forget account** on the first screen removes
  what DocLock itself stored.
- **A weak decoy password can be guessed** like any other. Guessing it
  shows only the decoy, but unlocking with it in DocLock also removes your
  real text from the doc.

## If someone tampers with the doc

Suppose you gave up the decoy password, and that person can still edit the
doc (a session left on your Google account, or the doc is shared with
them). With a tool of their own they can change the part their password
opens in a way DocLock never would: Edit it, damage it, give it a new
password. Then they wait. A DocLock doc without a decoy would keep that
change. One with a decoy would put the decoy back as it was at your next
save, and that would show them a second password exists.

DocLock checks for this every time your real password opens the doc. It
always writes your text and the decoy together, so a decoy that does not
match was not written by DocLock. When that happens:

- **Nothing is written.** No save on unlock, no repair. To whoever is
  watching, the doc looks as if you never opened it.
- **Your text opens read-only**, with a notice. You cannot edit, save,
  change the password or change the decoy in that doc.
- **You know you are being watched.**

What to do: Copy your text into a new doc, from a Google account they
cannot reach, and leave the old doc as it is. Do not restore an earlier
version of it: That is a change they would see too.

The limits: This only helps if you use DocLock itself and heed the notice.
And if the doc is changed this way while you have it open, DocLock refuses
the next save, but a save that was already on its way is not taken back.

This weakness is not special to DocLock. Deniable encryption in general
is hard to keep up against someone who can look at the storage more than
once, or change it: VeraCrypt says so about its hidden volumes, and
research has looked for stronger designs ([References](#references)).

## The law, and your responsibility

This is not legal advice. Laws differ by country and change.

- **What it is for.** Protecting yourself from people with no right to
  your text: A thief, an attacker, someone threatening you.
- **A lawful order is different.** In some countries a court or the
  police can order you to hand over a password or the readable text, and
  not complying is an offence. Among them are the UK
  ([Regulation of Investigatory Powers Act 2000, section 49](https://www.legislation.gov.uk/ukpga/2000/23/section/49),
  with the offence in [section 53](https://www.legislation.gov.uk/ukpga/2000/23/section/53)),
  Australia ([Crimes Act 1914, section 3LA](https://www5.austlii.edu.au/au/legis/cth/consol_act/ca191482/s3la.html)),
  France
  ([Code pénal, article 434-15-2](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000032654251))
  and India (Information Technology Act 2000, section 69).
  Wikipedia keeps a
  [list by country](https://en.wikipedia.org/wiki/Key_disclosure_law). The
  decoy is no defence against such an order.
- **Lying can be an offence in itself.** Telling investigators or a court
  that the decoy is all there is can count as
  [obstruction of justice](https://en.wikipedia.org/wiki/Obstruction_of_justice),
  or as [perjury](https://en.wikipedia.org/wiki/Perjury) under oath,
  whatever your real text is.
- **Some countries restrict encryption itself**, with or without a decoy
  ([cryptography law by country](https://en.wikipedia.org/wiki/Cryptography_law)).
- **Before you rely on it**, find out what the law says where you live and
  where you travel. If you face a real legal risk, ask a lawyer first.

How you use the decoy is your decision and your responsibility. DocLock
comes with no warranty ([GPL-3.0](../LICENSE)), and its author is not
responsible for what is done with it.

## The format

The exact layout of the block, and a few lines of Python that decrypt it
without DocLock, are in the [README](../README.md#technical-details). The
code is in [`app/cipher.js`](../app/cipher.js).

## References

The idea, and its known limits:

- Canetti, Dwork, Naor and Ostrovsky,
  [Deniable Encryption](https://eprint.iacr.org/1996/002) (1996): The
  paper that named the idea.
- Wikipedia: [Deniable encryption](https://en.wikipedia.org/wiki/Deniable_encryption)
  and [Rubber-hose cryptanalysis](https://en.wikipedia.org/wiki/Rubber-hose_cryptanalysis)
  (forcing a password out of someone).
- VeraCrypt: [Hidden Volume](https://veracrypt.io/en/Hidden%20Volume.html),
  the best-known decoy design, and its
  [Security Requirements for Hidden Volumes](https://veracrypt.io/en/Security%20Requirements%20for%20Hidden%20Volumes.html),
  which include the case of someone who sees the storage at several
  points in time.
- Czeskis, St. Hilaire, Koscher, Gribble, Kohno and Schneier,
  [Defeating Encrypted and Deniable File Systems: TrueCrypt v5.1a and the Case of the Tattling OS and Applications](https://www.usenix.org/legacy/event/hotsec08/tech/full_papers/czeskis/czeskis_html/)
  (USENIX HotSec 2008): How the system around the encrypted data gives a
  hidden text away. See "It does not clean your device" above.
- Blass, Mayberry, Noubir and Onarlioglu,
  [Toward Robust Hidden Volumes using Write-Only Oblivious RAM](https://eprint.iacr.org/2014/344)
  (2014): On an observer who compares several snapshots, and what it
  takes to resist one.

Google Docs:

- [See the history of changes to a file](https://support.google.com/docs/answer/190843):
  Version history, and restoring a version.

The law:

- United Kingdom: Regulation of Investigatory Powers Act 2000, Part III,
  [section 49](https://www.legislation.gov.uk/ukpga/2000/23/section/49)
  (notices requiring disclosure) and
  [section 53](https://www.legislation.gov.uk/ukpga/2000/23/section/53)
  (failure to comply).
- Australia: [Crimes Act 1914 (Cth), section 3LA](https://www5.austlii.edu.au/au/legis/cth/consol_act/ca191482/s3la.html)
  (an order to help the police get at data, and the offence of not
  complying).
- France: [Code pénal, article 434-15-2](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000032654251)
  (in French).
- India: [Information Technology Act, 2000](https://en.wikipedia.org/wiki/Information_Technology_Act,_2000),
  section 69.
- Wikipedia: [Key disclosure law](https://en.wikipedia.org/wiki/Key_disclosure_law)
  and [Cryptography law](https://en.wikipedia.org/wiki/Cryptography_law),
  by country.
