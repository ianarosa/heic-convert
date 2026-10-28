# LAUNCH.md — monetisation and promotion, without the hype

This is the playbook for turning Safelight into something that earns passively. It is
written to let you decide whether this is worth **$5/month or $500/month** before you spend
another weekend on it, so it leads with the unflattering numbers.

Read [§0](#0-read-this-first-the-honesty-conflict) before you do anything else. It is the
one decision that can't be undone quietly.

---

## Contents

- [0. Read this first: the honesty conflict](#0-read-this-first-the-honesty-conflict)
- [1. What this can realistically earn](#1-what-this-can-realistically-earn)
- [2. The timeline, honestly](#2-the-timeline-honestly)
- [3. AdSense setup, step by step](#3-adsense-setup-step-by-step)
- [4. Promotion](#4-promotion)
- [5. Why privacy is the wedge, and how to talk about it](#5-why-privacy-is-the-wedge-and-how-to-talk-about-it)
- [6. What to build next](#6-what-to-build-next)
- [7. Licensing — you must read this](#7-licensing--you-must-read-this)
- [8. Pre-launch checklist](#8-pre-launch-checklist)

---

## 0. Read this first: the honesty conflict

**Turning on AdSense makes your own homepage lie.** Two specific lines:

| File | Line | Says today | After AdSense |
|---|---|---|---|
| `index.html` | ~515 | `No accounts · No uploads · No tracking` | **False.** AdSense tracks. |
| `index.html` | ~442 | "no upload, no request, **not even an analytics ping**" | **False.** The ad script is a request, and it pings. |

The whole brand is "don't trust us, check" — and the check you invite people to run is
**F12 → Network**. The moment AdSense is live, a reader who takes you up on that sees
`googlesyndication.com` in the network tab about two seconds after landing. That reader is
your best reader. They came here *because* you told them to be suspicious.

The wire tap makes this worse, in a good way: it literally counts "Requests to other
domains" on your front page. With AdSense on, **your own instrument will report a non-zero
number in red, on the page that says the number is zero.** That is not a bug to hide; it is
your design working. But you must decide, on purpose, which of these you're doing:

**Option A — Keep the claim exactly as it is. Don't run AdSense.**
Use a non-tracking ad network instead: [EthicalAds](https://www.ethicalads.io/) or
[Carbon Ads](https://www.carbonads.net/) serve ads with no cookies and no personal-data
tracking. Both are approval-based and skew developer-audience, so a consumer photo tool may
not be accepted, and RPMs are lower. But `No tracking` stays true, the wire tap's
third-party counter is the only thing that moves, and you keep the one asset nobody else in
this market has.

**Option B — Run AdSense, and change the claims to match.** This is legitimate and it is
what most people should do. It requires, on the same deploy:
- Footer → something true: `No accounts · No uploads · Your photos stay on your device`.
- The "not even an analytics ping" paragraph → rewrite. The honest version is strong:
  *"The ads on this page make requests. Your photos don't. Watch the Network tab: you'll see
  the ad script load, and you will never see your photo go anywhere."*
- The FAQ line "there's nothing else here to monetise" → still true and worth keeping.
- `privacy/index.html` → flip the advertising section (it has an `<!-- OWNER: -->` block).

**Option C — AdSense with personalised ads disabled** (AdSense → Blocking controls). Still
sets cookies, still a third-party request, so `No tracking` still has to go. Earns less than
A? No — less than B, more than nothing. Rarely the right pick.

**The recommendation:** start with **Option A** through the HN/Product Hunt launch, because
the launch narrative *is* the no-tracking claim and you get exactly one shot at it. Switch to
**Option B** later, deliberately, with the copy changes shipped in the same commit, once
traffic is real enough that the money is worth the edit. Do not do B silently. The people who
will notice are precisely the people who will write about you.

> Whatever you choose: a privacy tool caught quietly contradicting itself doesn't get a
> correction, it gets a screenshot. The cost of being wrong here is the entire brand.

---

## 1. What this can realistically earn

Earnings = `(monthly pageviews ÷ 1000) × RPM`.

**RPM** (revenue per 1,000 pageviews) for a *utility* like this realistically runs
**$2–$15**. Where you land depends mostly on geography:

- Global mix (lots of India, Brazil, SEA): **$2–5**.
- Mostly US / UK / CA / AU / DE: **$8–15**.
- HEIC traffic skews **iPhone owners**, who skew wealthy and US/EU. That's genuinely in your
  favour — call it **$4–10** as a working estimate.

Working against you: a converter is low commercial intent (nobody is buying anything), one
or two pageviews per session, and users leave the second the download finishes. Those are
RPM-suppressing facts and no amount of design fixes them.

### The table

| Monthly pageviews | @ $2 RPM | @ $5 RPM | @ $10 RPM | @ $15 RPM |
|---:|---:|---:|---:|---:|
| 1,000 | $2 | $5 | $10 | $15 |
| 5,000 | $10 | $25 | $50 | $75 |
| 10,000 | $20 | $50 | $100 | $150 |
| 25,000 | $50 | $125 | $250 | $375 |
| 50,000 | $100 | $250 | $500 | $750 |
| 100,000 | $200 | $500 | $1,000 | $1,500 |
| 250,000 | $500 | $1,250 | $2,500 | $3,750 |

### So is it $5/month or $500/month?

**Year one: it is a $5–50/month project.** Probably closer to $5 for the first six months.
Anyone who tells you otherwise is selling a course.

**$500/month needs ~50,000–100,000 pageviews/month.** That is not a fantasy — "heic to jpg"
and its variants are high-volume, evergreen, and non-seasonal — but understand who is already
sitting on page one: `heictojpg.com`, `freeconvert.com`, `cloudconvert.com`, `iloveimg.com`,
plus `apple.com` and `microsoft.com` support pages. They have years of domain authority and
backlink profiles you cannot buy your way past this year.

**The honest shape of the bet:**
- The head terms ("heic to jpg") — you will not win these soon. Don't plan around them.
- The **trust cluster** (`is heictojpg.com safe`, `is freeconvert safe`, `heictojpg
  alternative`) — genuinely winnable. Low competition, real intent, and nobody else is
  answering them with sourced quotes from the actual terms of service. This is your wedge.
- The **long tail** (`heic to jpg without uploading`, `batch convert heic to jpg`,
  `why can't i open heic files windows 11`) — winnable in 6–12 months with links.

**Expected value, plainly stated:** most likely outcome is **$10–80/month by month twelve**,
which pays for the domain and buys a coffee. The realistic good outcome is **$150–400/month
in year two** if the launch lands, the trust cluster ranks, and you keep adding pages. The
tail outcome — one guide gets linked by a big publication and the whole domain lifts — is
real but is not a plan.

Treat the money as a bonus. The reliable returns here are the portfolio piece and the tool
you actually use.

---

## 2. The timeline, honestly

**SEO ramp is 3–6 months minimum. There is no version of this where you are earning in
week two.**

| When | What actually happens |
|---|---|
| Week 1 | Google discovers the sitemap. Pages get indexed. Rankings: nowhere. |
| Weeks 2–8 | Pages bounce around positions 40–90. Traffic ≈ 0. This is normal and is not failure. |
| Months 3–4 | Long-tail terms start landing on page 2–3. First trickle: tens of visits/day. |
| Months 4–6 | Trust-cluster pages start ranking (low competition pays off first). Hundreds/month. |
| Months 6–12 | If links arrived, the long tail reaches page 1. Thousands/month. This is where AdSense money becomes visible at all. |
| Year 2+ | Compounding, or a plateau if you stopped adding pages. |

Two things that genuinely accelerate this, in order:
1. **Backlinks.** This is the whole game. The HN/Product Hunt launch is not for traffic —
   the traffic spike lasts 48 hours and converts to nothing. **It is for links.** One link
   from a real publication is worth more than any on-page work you will ever do.
2. **More pages** (see §6). Each new tool is a new set of queries at near-zero cost.

Things that do not help: posting the URL in more places, tweaking meta descriptions monthly,
buying links (actively harmful), and refreshing Search Console every day.

---

## 3. AdSense setup, step by step

**Prerequisite: decide §0 first.** If you picked Option A, skip this section entirely.

### Getting approved

AdSense rejects thin sites. The single most common rejection is **"Low value content"** —
which is exactly what a bare converter with no prose would get. This is a real, non-obvious
reason the 13 content pages exist: they are what makes the site approvable at all.

You already have what's required: original content, a real privacy policy at `/privacy/`,
working navigation, a custom domain, and no scraped or AI-slop text.

1. Sign up at <https://adsense.google.com> with the domain.
2. Add the verification snippet to `index.html`'s `<head>` (AdSense gives you the exact tag).
3. Wait. **1–14 days is typical; a few weeks happens.** Don't resubmit in a loop.
4. If rejected: read the reason, fix it, wait two weeks, reapply. Rejection is not permanent.

### Wiring it up

Your publisher ID goes in **three places** — all three, or nothing works:

1. **`js/config.js`** (~line 113): `export const AD_CLIENT = 'ca-pub-XXXXXXXXXXXXXXXX';`
   Also fill `AD_SLOTS.belowTool.slot` and `AD_SLOTS.inContent.slot` with the per-unit slot IDs.
2. **`ads.txt`**: uncomment the `google.com` line, paste the `pub-…` form (**no** `ca-`
   prefix here). The file explains itself.
3. **`<head>` of each page with a slot**, plus an `<ins class="adsbygoogle">` inside each
   `.ad__box`. Slots exist on `index.html` (two) and the 9 guide/compare pages (one each).
   The hubs, `/privacy/` and `404.html` have none, on purpose.

Heights are already reserved in `css/app.css` (`--ad-h-below`, `--ad-h-content`), so filling
a slot shifts nothing. **Do not let AdSense auto-ads insert units for you** — auto-ads inject
unreserved slots and will wreck the CLS score this layout was built to protect.

### The EU/UK obligation — not optional

Under **GDPR/ePrivacy**, advertising cookies require **consent before they are set**, and
Google requires publishers serving EEA/UK traffic to use a **certified Consent Management
Platform**. Google publishes a list of certified CMPs; Google's own is free and integrates
with AdSense.

Your traffic will be substantially EU. Skipping this risks your AdSense account, not just a
fine. Budget an afternoon.

**Then update `privacy/index.html` in the same deploy.** It states as present fact that no
ads are served and no advertising cookies are set. That becomes false the day you ship. The
file carries an `<!-- OWNER: -->` block listing every edit. Shipping ads without that edit
means your privacy policy is factually wrong — which is both a legal problem and, for this
brand specifically, a fatal one.

### If AdSense won't take you

| Network | Threshold | Note |
|---|---|---|
| **EthicalAds** | Low | No tracking. Fits the brand. Dev-skewed audience. |
| **Carbon Ads** | Approval-based | No tracking. Design/dev audience. Selective. |
| **Ezoic** | ~10k visits/mo | Higher RPM than AdSense, heavier script, real CLS risk. |
| **Mediavine** | 50k sessions/mo | Much higher RPM. Realistically a year-two conversation. |
| **Raptive** | 100k pageviews/mo | Best rates. A long way off. |

---

## 4. Promotion

> **Verify every rule below before you post.** Reddit blocks automated access, so the
> subreddit rules here could not be checked against the source and are written from general
> knowledge. **Rules change and mods do not care that you didn't know.** Open the sidebar,
> read the rules, read the wiki, and check the last month of posts to see what actually
> survives. Getting banned from r/apple is a permanent, unrecoverable loss of your best
> audience — treat one post there as worth more than ten anywhere else.

### Hacker News — the best shot, and it's free

This qualifies as a **Show HN**. Verified against <https://news.ycombinator.com/showhn.html>:
"Show HN is for something you've made that other people can play with" — a browser tool with
no signup is exactly the target. (Blog posts, sign-up pages and landing pages don't qualify;
you're fine.) The rules also say: **"Please don't ask friends to upvote or comment. That's
not ok on HN."** Don't. They detect it and it kills the post and possibly the account.

**The hook is not the converter.** Nobody needs another converter. The hook is
**verifiability**: a privacy claim you can check in ten seconds, and a page that instruments
itself and dares you to catch it lying. HN's audience is constitutionally suspicious of
privacy marketing — which is why a claim engineered to be *falsifiable* lands there.

Title candidates (plain, no adjectives — HN punishes marketing voice):
- `Show HN: HEIC to JPG in the browser – turn off your Wi-Fi and it still works`
- `Show HN: A HEIC converter that counts its own network requests and dares you to check`
- `Show HN: I read the terms of service of the top HEIC converters so you don't have to`

That third one is a different, possibly better post — it leads with the trust cluster and the
tool is the footnote. HN loves receipts.

**Mechanics:** post Tue–Thu, ~8–10am ET. Be in the thread all day answering. Expect the top
comment to be "libheif in wasm, neat" followed by someone asking why JPGs come out bigger —
you already answer that on the front page, which will be noticed and appreciated. If it
flops, that's normal; you may repost once after a while, and a second attempt often does
better.

### Reddit

**The general shape** (verify each, per the warning above): most large subs ban self-promo
outright or restrict it to a weekly thread; Reddit's long-standing site-wide guidance is that
self-promotion should be a small minority (the widely-cited ~10%) of your activity, and an
account that only posts its own link is spam by definition.

| Sub | Realistic read |
|---|---|
| **r/apple**, **r/iphone** | **Strict. Do not post your link.** These are the biggest relevant audiences and the fastest bans. The only safe play is answering existing "how do I open HEIC" threads helpfully, *disclosing you built it*, and only when it genuinely answers the question. |
| **r/SideProject**, **r/InternetIsBeautiful** | Built for this. IIB has a real quality bar and mods remove low-effort posts. |
| **r/webdev** | Has a dedicated showoff thread — use it, not the main feed. |
| **r/privacy**, **r/degoogle** | Perfect audience, allergic to product promo. Lurk first. A post about *what the terms of service actually say*, with the tool as a footnote, fits where an ad never would. |
| **r/windows11**, **r/techsupport** | The "why can't I open HEIC" question is asked constantly. Answer it properly — link the guide only if it genuinely helps. |

**The rule that keeps you un-banned:** always disclose you made it, never post the bare link,
and make the comment useful even if nobody clicks. If you'd be embarrassed for a mod to read
it, don't post it.

### Product Hunt

Worth one shot, mostly for the backlink and the "featured on" credibility. Launch Tue–Thu,
00:01 PT. You need a gallery, a clear tagline and a first comment explaining the *why*. Reply
to every comment. Don't buy upvotes — it's detectable and disqualifying. Expect a traffic
spike that decays in 48 hours; **you are doing this for the link, not the traffic.**

### The quietly effective one

Find the existing forum, Quora and Reddit threads asking "how do I open HEIC on Windows"
— there are thousands, they rank, and they never die. Answer them properly, disclose, help.
This is slow, unglamorous, and it is how tools like this actually get found.

---

## 5. Why privacy is the wedge, and how to talk about it

**Every competitor uploads your photos.** That's not an accusation — it's their architecture,
it's legitimate, and it's on their own websites. But it means there is one claim they
structurally cannot make, and you can: *the file never leaves the device.*

**Why it works commercially:** most people converting HEICs are not converting art. They're
converting a photo of a passport for a visa form, a signed contract, a payslip for a rental
application, a medical letter, a whiteboard from work, their kids. The moment someone
realises what they were about to upload, the decision makes itself.

**How to talk about it honestly — the rules that make this credible:**

1. **Never say a competitor is unsafe or dishonest.** Say what their terms say, quote it
   exactly, link the source, date it. Let the reader conclude. Every page in `/compare/`
   already does this.
2. **Give competitors their due, loudly.** CloudConvert's published practices are genuinely
   strong — immediate deletion, no permanent storage, isolated containers — and the site says
   so plainly. That single paragraph buys more credibility than any claim about ourselves,
   because it proves the pages aren't a hit job.
3. **Lead with the falsifiable version.** "We don't upload" is marketing. "Turn off your
   Wi-Fi and it still works" is a test. Always ship the test, never the adjective.
4. **Volunteer your own downsides first.** Files get ~168% bigger. EXIF is dropped. Big zips
   hit browser memory limits. A 1.4 MB decoder downloads once. Saying this unprompted is why
   anyone believes the rest.
5. **Never overstate.** You are not audited. You are not a company. You are one person and a
   static site, and saying so is more convincing than a trust badge.

**The line that does the work:** *server-side conversion is a perfectly reasonable way to
build a converter — it's just a choice you should get to make knowingly, and right now nobody
is telling you you're making it.*

---

## 6. What to build next

The client-side image core already in `js/` — decode, canvas re-encode, resize, batch queue,
streamed zip — is most of the work for several more tools. Each is a new set of search
queries at **near-zero marginal cost**, on a domain that already ranks, sharing the same
design system, the same tests and the same wire tap.

In rough order of traffic-per-effort:

| Tool | Reuses | Extra work | Queries it opens |
|---|---|---|---|
| **Image compressor** | encode + quality + queue | A size-target loop | "compress jpeg", "reduce image size" — huge volume |
| **Bulk image resizer** | resize + queue | Presets UI | "bulk resize images", "resize photos for web" |
| **EXIF stripper** | decode + encode | You already strip EXIF — just *say* so | "remove exif", "remove gps from photo" — **perfect brand fit** |
| **PNG/JPG/WebP converter** | all of it | Input format detection | "png to jpg", "webp to png" — enormous volume |

**The EXIF stripper is the one to build first.** It is nearly free — the pipeline already
drops metadata as a side effect, so the "feature" is mostly honest labelling and a
verification panel. And it's the strongest brand fit you will ever get: *removing location
data from photos, on a tool that can't see the photos.* It also converts today's honest
caveat ("EXIF is dropped") into a headline feature.

**What not to build: HEIC → PDF.** The query has real volume and the tool cannot do it.
There is no page for it, and there must not be one. `/compare/heictojpg-alternative/` handles
that user honestly by sending them to a cloud converter. Shipping a page promising PDF would
earn a few hundred visits and cost the only thing this project actually has.

---

## 7. Licensing — you must read this

`vendor/libheif-bundle.mjs` is **LGPL-3.0**. This matters more for a web app than people
assume, and there is **one real gap open right now**.

*Not legal advice. This is a careful reading of the licence text (`vendor/LICENSE.libheif-js.txt`)
against how this app actually ships. If real money starts arriving, get a real opinion.*

### The thing people get wrong

There is no SaaS loophole here. LGPL obligations trigger on **conveying** the library — and
**you ship libheif to every visitor's browser**. That is distribution. If libheif ran on your
server and only JPGs came back, almost none of this would apply. Because it executes on the
user's device, it does.

### The good news, precisely

**You do not have to open-source your own code.** `js/main.js`, `js/ui.js`, `js/queue.js` and
the rest are an **"Application"** in LGPL terms: work that *uses the library's interface* but
is not *based on* the library. Under LGPL-3.0 §4 the result is a **"Combined Work"**, and the
licence's whole point — the "Lesser" — is that combining does not infect your code. Your JS
stays yours, under whatever licence you like. Ads are fine. Charging money would be fine.

You're also in the easiest possible posture for §4's hard requirement: the library is
**unmodified**, and it's a **separate file** (`vendor/libheif-bundle.mjs`) loaded by a dynamic
`import()`. §4(d) demands users be able to **relink your app against a modified version of the
library**. Anyone can drop in their own build of that one file and the app picks it up. You
satisfy that by construction — a bundler that inlined libheif into one blob would have
destroyed this, which is one more reason the no-build-step architecture was a good call.

### ⚠️ The gap you need to close (5 minutes)

**LGPL-3.0 §4(b) requires you to "Accompany the Combined Work with a copy of the GNU GPL and
this license document."** That is **two** documents — LGPL-3.0 is written as a set of
additional permissions layered *on top of* GPL-3.0, so both texts are required.

`vendor/` currently contains only `LICENSE.libheif-js.txt` (the LGPL-3.0 text, 165 lines).
**The GPL-3.0 text is not there.** Verified by grep.

**To comply:**

1. **Add `vendor/LICENSE.GPL-3.0.txt`** — the verbatim GPL-3.0 text from
   <https://www.gnu.org/licenses/gpl-3.0.txt>. This alone closes the §4(b) gap.
2. **Give notice that libheif is used and is LGPL-licensed** (§4(a)). Today the footer says
   "Built on libheif" and links the repo — that's attribution, but it does not state the
   licence. Make it explicit, e.g. *"Built on libheif, used under the LGPL-3.0"*, linking the
   licence text. A small `/licenses/` page listing libheif (LGPL-3.0), client-zip (MIT) and
   linking both texts is the tidy version and is what most projects do.
   *(This needs a footer edit in `index.html`, which was outside the scope of the SEO work —
   so it is still open. The content pages inherit the same footer and the same gap.)*
3. **Publish the library's source.** libheif is public at
   <https://github.com/strukturag/libheif>; the wasm build came from `libheif-js` v1.19.8.
   Linking the upstream repo *and naming the exact version* you vendored is the practical bar.
   `vendor/README.md` already records the version — link it from the notice.
4. **Don't add terms that forbid reverse engineering.** If you ever write a ToS, §4 prohibits
   restricting reverse engineering for debugging modifications to the library.

### One thing to never do accidentally

**libheif's HEVC *encoder* path uses x265, which is GPL — not LGPL.** libheif's own README
warns: *"note that x265 is GPL."* If a future build ever compiles x265 in (i.e. if you add
HEIC *writing*), the combined work would arguably fall under **GPL-3.0**, and the "your code
stays yours" conclusion above **evaporates**.

You are safe today: this build **decodes only**, and `vendor/libheif-bundle.mjs` contains
zero occurrences of `x265` or `encoder` (verified by grep). Re-check that after any
`npm run vendor:libheif`.

### The other two

- **`vendor/client-zip.js` — MIT.** Keep `LICENSE.client-zip.txt` next to it. Already done.
  Nothing else required.
- **JSZip — MIT.** A devDependency, used only in the tests as an independent zip *reader*.
  It never ships to a browser, so it carries no distribution obligation at all.

### Summary

| Question | Answer |
|---|---|
| Must you open-source your JS? | **No.** |
| Can you run ads / charge money? | **Yes.** |
| Must you ship the LGPL text? | **Yes** — done. |
| Must you ship the GPL-3.0 text too? | **Yes** — ⚠️ **missing.** Add `vendor/LICENSE.GPL-3.0.txt`. |
| Must you state libheif is LGPL? | **Yes** — ⚠️ footer says "Built on libheif" but not the licence. |
| Must users be able to relink a modified libheif? | **Yes** — already satisfied (separate unmodified file). |
| Must you publish libheif's source? | Link upstream + the exact version. `vendor/README.md` has it. |

---

## 8. Pre-launch checklist

**Before you deploy**
- [ ] `node test/verify.seo.mjs` passes — zero console errors, all links resolve, sitemap matches the filesystem.
- [ ] `npm test` passes.
- [ ] Decide **§0**: Option A (no tracking, keep the claim) or Option B (AdSense, fix the copy).
- [ ] Close the **LGPL gap**: add `vendor/LICENSE.GPL-3.0.txt`, state the licence in the footer.
- [ ] Put a real contact email in `privacy/index.html` (it's a marked placeholder — AdSense will want one anyway).

**Deploy**
- [ ] Cloudflare Pages: framework **None**, no build command, output `/`.
- [ ] Custom domain live, HTTPS good.
- [ ] Check `/robots.txt`, `/sitemap.xml`, `/ads.txt` all load as plain text.
- [ ] Hit a nonsense URL and confirm `404.html` renders.

**Search Console (do this on day one — the 3–6 month clock starts here)**
- [ ] Add the property, verify via DNS.
- [ ] Submit `sitemap.xml`.
- [ ] Request indexing on `/` and the two or three best guides.
- [ ] Then leave it alone for a month. Checking daily changes nothing.

**Launch**
- [ ] Show HN, Tue–Thu ~8–10am ET. Be in the thread all day. Don't ask anyone to upvote.
- [ ] Product Hunt, Tue–Thu 00:01 PT.
- [ ] Reddit: **read every sidebar first.** Disclose you built it. Never post a bare link.

**If you turn ads on later**
- [ ] `AD_CLIENT` in `js/config.js` + slot IDs.
- [ ] `ads.txt` uncommented with your real `pub-…` ID.
- [ ] Script tag + `<ins>` in each page with a slot.
- [ ] **CMP live for EU/UK traffic** before a single ad serves.
- [ ] **`privacy/index.html` updated in the same deploy** (see its `<!-- OWNER: -->` block).
- [ ] **Footer and the "not even an analytics ping" line fixed** — see §0. Same deploy. No exceptions.
