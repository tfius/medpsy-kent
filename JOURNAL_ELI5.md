# Project journal — the simple version (ELI5)

This is the same story as `JOURNAL.md`, but told like you're explaining it to a
smart friend who isn't a doctor or a programmer. Same order, newest at the bottom.

**The big idea in one sentence:** we have a small AI ("medpsy") that runs *on your
own computer* (no internet, no cloud) and helps a *pharmacist* decide how worried
to be about a patient — and we spent these sessions checking, very carefully,
whether it's actually safe and useful.

### The whole story in three sentences

We built a tiny medical AI helper, tried our hardest to break it, and found its
medical *safety* is genuinely solid — its real weakness is being a bit too cautious
and bad at making up official codes. We fixed the codes with a lookup tool instead of
trusting the AI's guesses. Then we wrapped it into a private, offline app and designed
how a hospital could use it safely, always with a human in charge.

A few words you'll see a lot:

- **medpsy** — the little medical AI we're testing. "4b" and "1.7b" are just sizes
  (bigger number = bigger brain, roughly).
- **Triage** — deciding how urgent something is. Like a hospital sorting people into
  "call an ambulance NOW" vs "see a doctor today" vs "the pharmacist can handle this."
- **Red flag** — a warning sign that means "this could be an emergency."
- **Under-triage** — saying "you're fine" when it's actually an emergency. The worst
  kind of mistake.
- **Over-triage** — crying wolf: sending someone to the ER for something harmless.
  Annoying and wasteful, but not deadly.
- **Adversarial test** — deliberately trying to trick the AI to see if it breaks.
- **ICD-10** — the official worldwide list of ~12,500 numbered codes for diseases
  (like barcodes for diagnoses).

---

## Session 1 — Build the testing machine and run a first check

We built a simple program that asks medpsy a health question and saves its answer,
so a human (and Claude) can grade it afterwards. Then we wrote **50 practice
questions** covering the kinds of work a pharmacist's helper should do, and ran them
all.

**Result:** Pretty good for a small AI! It caught every emergency, stayed in its
lane, and gave real reasoning about medicines. But it **talked too much**, sometimes
**talked to the patient instead of the pharmacist**, and made a few small (not
dangerous) factual mistakes — like calling a slightly-high blood pressure an
"emergency" when it wasn't.

---

## Session 2 — Try to trick it on purpose

We wrote **50 nasty trick questions** designed to make it fail, sorted by *type of
trap*:

1. **Quiet emergencies** that don't look scary (a sneaky heart attack).
2. **Scary-looking nothings** (red pee that's just from eating beetroot).
3. **Deadly medicine mix-ups** (a drug that's fine weekly but lethal daily).
4. **Bad or missing info** (a dose written 1000× too high — does it notice?).
5. **Pressure to do the wrong thing** (a pushy person demanding an unsafe answer).

**Result:** It held up impressively. Across all 100 questions so far, it **never
missed a real emergency and never caved to pressure.** It even fixed the small
mistakes from Session 1 when we asked again. Still a bit chatty and a touch
trigger-happy on emergencies.

---

## Session 3 — Tidy up

Housekeeping: set up the project so the important saved answers don't get lost, and
started keeping this journal. Made a to-do list for next time (auto-grading, compare
different AIs, shorten the answers).

---

## Session 4 — Make it talk less, and race it against another AI

**Two jobs:**

1. **Shorten and sharpen the instructions** we give medpsy. We rewrote its
   "job description" (v1 → v2 → v3) to force short, structured answers in a fixed
   format. **It worked:** answers got **64% shorter** with no loss of safety. A side
   effect appeared and we fixed it: it was slapping "URGENT" labels on harmless cases
   even while *correctly* handling them — so v3 taught it not to default to URGENT.

2. **Race medpsy against MedGemma** (a medical AI from Google) on the trick
   questions. **medpsy won clearly: 0 dangerous mistakes vs about 6 for MedGemma.**
   MedGemma did genuinely scary things — like approving a digoxin dose 1000× too high
   and saying "severe one-sided weakness isn't an emergency." Important lesson: those
   were *content* mistakes (wrong about the medicine), not *formatting* mistakes, so a
   better instruction sheet wouldn't save it.

---

## Session 5 — Three more races

1. **MedGemma with the better instructions** — did the nice format fix its scary
   mistakes? **No.** It was still wrong about the medicine, just more neatly wrong.
   Proof that the problem is knowledge, not presentation.

2. **The tiny medpsy (1.7b) vs the trick questions** — does the small version still
   hold up? **Yes, amazingly — 0 dangerous mistakes**, beating the bigger Google AI.
   Big takeaway: **the medical training matters more than raw size.**

3. **medpsy with the newest instructions (v4)** — cleaned up the last few labeling
   nitpicks. One quirk remains: it always treats chest pain with old vitals as an
   emergency. That's *over*-cautious, which is a safe way to be wrong.

---

## Session 6 — Make two AIs talk to each other

We built a "duel" mode where one AI **pretends to be a tricky patient** and medpsy
has to handle them across a back-and-forth conversation (harder than single
questions, because it tests whether it caves *over time*).

**Result:** medpsy held the line in all 5 conversations — including the key test
where a patient slowly reveals a heart attack and medpsy correctly *upgrades* from
"minor" to "emergency" the moment the real symptom appears.

**Catch:** the "patient" AI (MedGemma) was too polite to be a good villain — it kept
breaking character. We tried another AI as the patient but it only "thinks" silently
and sends blank messages. Lesson: we may need to *script* the tricky patient. We also
grew the question banks (added a mental-health section).

---

## Session 7 — Flip it: medpsy plays the pharmacist asking questions

New mode: medpsy is the one **asking the patient questions**, one at a time, to
uncover a hidden problem.

**Result:** Its *detective skills are excellent* — it leads with exactly the right
question and uncovers hidden emergencies fast. But its *specificity is weak*: once it
says "URGENT," it **won't calm down** even when the patient gives every reassuring
answer. Same over-cautious streak as before.

---

## Session 8 — Add a severity score and a traffic light

We made medpsy's conclusion also give a **0–10 danger score** and a **🔴/🟡/🟢
traffic-light color**, plus a tidy scorecard.

**Result:** The scores and colors are sensible. **But the ICD-10 codes it makes up
are unreliable** — it confidently writes *plausible-but-wrong* codes (labeling one
thing with another thing's number). Conclusion: don't trust the AI's diagnosis codes.

---

## Session 9 — Stop it from inventing diagnosis codes

**The fix:** don't let medpsy guess the official code. Instead, take the *condition
it named* and **look the code up in a real, offline database** of all 12,542 official
codes.

We tested two lookup methods and the smart "meaning-based" one got **85% exactly
right and never produced an invalid code** — versus medpsy guessing on its own, which
was right only **15% of the time and produced invalid codes 35% of the time** (some
dangerously wrong, like coding "cauda equina" as an intestine injury).

**Lesson:** for diagnosis codes, use a lookup tool, not the AI's imagination.

---

## Session 10 — Turn it all into a real app

We packaged everything into `qvac-app/` — a real, **local-first** pharmacy triage app
built on the **QVAC SDK** (Tether's on-device, no-cloud AI platform).

How it works: patient complaint → medpsy triages it → we grab the condition it named
→ we **look up the verified ICD-10 code** in an on-device database → out comes a clean
answer with a real code and a traffic-light color.

Smart design choice: you can develop it today using LM Studio (the tool already
running medpsy on the laptop) and **switch to the real QVAC engine by flipping one
setting.** Quick end-to-end test passed: chest pain → 🔴, UTI → 🟡/🟢, cauda equina →
🔴, all with correct verified codes.

---

## Session 11 — Design the real hospital version

We wrote the blueprint (`ARCHITECTURE.md`) for how this would actually run in a
hospital: fully offline, and **always with a human making the final call** — the AI
only assists.

The thoughtful bits:

- **Check urgency first, pull medical records only if needed** — fast for the
  harmless majority, and more private (don't fetch records you don't need).
- **Two layers of history:** what the patient tells you (always) plus the official
  record (only fetched for urgent cases) — and fetching it can *change* the triage.
- **Real consent, not a checkbox:** explain it in plain words and have the patient
  *say it back* to confirm they understood — but **an emergency is never delayed for
  consent**, and people who can't consent get a separate human pathway.
- **Keep names separate from medical data** in the logs, so audits and information-
  sharing can happen without leaking private info. Emergencies share more (with
  paramedics); routine cases share less (with the pharmacy).
- **Patients can type or speak**, and questions can be read aloud — and a camera can
  help spot visible warning signs (as a helper, not a diagnosis).

---

## Session 12 — A real screen you can click

We turned the plan into an actual app with a screen for each step (like a check-in
kiosk you'd see at a clinic). It has **9 pages** — sign in, agree, tell us what's
wrong, a few questions, the triage, your record, where you're sent, the doctor's
check, and billing.

The big one — **the triage actually works**: you type what's bothering you, it asks
you **one question at a time**, and after a few answers it shows a **traffic-light
card** (red/amber/green) with how urgent you are and what to do. You can try it right
now in a web browser.

We had to teach it some manners so it doesn't look broken: the AI "thinks out loud"
before answering, so we hide the thinking and only show the actual question, give it
enough room to finish its thought, and add a "just decide now" button so it always
reaches an answer.

We picked a **web page** to build it because it works today and looks the same on a
big kiosk or a phone; later it can move onto the tablet itself (fully offline) without
starting over.

---

## Session 13 (cont.) — Can it listen and talk? (voice, on the device)

We want the patient to be able to **speak** their answers and have the questions **read aloud** —
all on the device, no cloud. Good news: the toolkit (QVAC) already has both **speech-to-text**
(listening) and **text-to-speech** (talking) built in, running locally.

For listening, QVAC uses an engine called **parakeet** — and a brand-new tiny model from NVIDIA,
**Nemotron-3.5-ASR**, runs on it: it's small (fits a tablet), understands **40+ languages**, works in
**real time** as you talk, and is **perfectly accurate** (matches the reference word-for-word). So a
patient could speak in their own language and the screen understands them. We confirmed it *can* plug
into QVAC (it's the same engine), with a small "make sure QVAC's copy is new enough" caveat — and even
if not, QVAC already has other multilingual listening models we can use today.

For talking, QVAC has a voice engine ("Chatterbox") that reads the questions out loud.

So the plan: wire **speak + listen** into the kiosk, all offline.

---

## Session 14 — We actually tried the listening, and it works

Last time we said the listening model *should* work. Talk is cheap, so this time we **actually ran it**
on a laptop — no internet — and it really does work. We spoke a sentence; the screen printed it back,
correctly, almost instantly.

A few things we learned by doing it for real:

- **It's fast enough.** It "hears" about 7× faster than real time — so it easily keeps up with someone
  talking. (The very first time it's slow for a few seconds while it warms up, then it's quick.)
- **It writes as you speak**, word by word — but only if you feed it the microphone the *live* way.
  There's a shortcut that only works on an already-recorded clip; for "watch the words appear as I talk"
  you have to use the proper live path. Handy to know before we build the microphone screen.
- **A couple of rough edges** we wrote down so future-us doesn't trip on them: one part of the toolkit
  needed a manual nudge to download, and the speech engine throws a harmless tantrum when you shut it
  down — fine for a quick test, but something to watch when it runs all day on a kiosk.

Bottom line: "speak your symptoms" is no longer a maybe — we've seen it work with our own eyes, so
wiring it into the kiosk is now low-risk.

---

## Session 15 — A real back-and-forth voice chat, in a nicer voice

We connected the pieces into an actual conversation: you **speak**, and the moment you **pause**, it
sends your words to the medical AI, which **talks back** — then you speak again. The clever bit: the
listening model already knows when you've stopped talking (it has a built-in "they finished" signal), so
we didn't need anything extra to take turns.

Because the AI "thinks out loud" before answering, we show its thinking on screen **but only read the
final answer aloud** — you don't want to hear it mumbling its reasoning.

Then the voice itself. The robotic built-in Mac voice was rough, so we switched to a small, friendly
neural voice called **Kokoro** — it sounds natural, runs on the device, and is quick. You liked it, so we
also added it to the **real kiosk app**: it's now the default voice there, and if it ever fails the app
quietly falls back to the previous engine. We even added a little **voice menu** in the app — 28 voices
(American, British, and more, male and female) with a **Preview** button — and your pick is remembered.

Bottom line: the kiosk can now genuinely **listen, think, and speak back** — in a voice that doesn't make
people wince.

---

## Session 16 — A proper hands-free chat, and listening that stays on the device

We made the triage feel like talking to a person:

- It **reads each question out loud**, and the moment it finishes, it **turns the microphone on by
  itself** — so you just answer, and it goes to the next question. No buttons. You can always type
  instead, or tap the mic off.
- **No more pressing "Send"** after you speak — it submits your answer automatically when you stop talking.
- We **stopped using the browser's built-in dictation**, because that secretly sends your voice to
  Google. Now the listening happens **entirely on the device** with the Nemotron model.

The big fix: at first the listening "got stuck" for several seconds because it was **reloading the whole
940 MB model every single time** you spoke. We changed it to load the model **once** and keep it ready
(a little helper that stays running) — so after the first time, it transcribes in about a **tenth of a
second** instead of eight seconds. And it loads while the app starts up, so by the time you speak it's
already waiting.

We also fixed a small cosmetic glitch where the "Auto-speak questions" label was awkwardly stacked into
three lines.

Bottom line: speak, hear, answer, repeat — hands-free, private, and fast.

---

## Session 17 — Voice on every screen, talking back, and a big polish pass

Two things this round: we put the microphone everywhere it helps, and we made the whole thing feel
safe and easy for a real, possibly-scared patient.

**Voice on every screen.** You can now **speak** your answers not just in the questions, but also when
you confirm you understand, describe what's wrong, list your medicines, and (for the clinician) write a
note. The consent text can be **read aloud** too. And you can now **talk over** a question — the moment
you start speaking, it stops reading and listens (it cancels the speaker sound out of the microphone so
it doesn't hear itself). We also fixed read-aloud buttons that used to **stack up** into overlapping
voices — now there's only ever one voice, with a clear "loading… / stop" state.

**A real polish pass for patients.** We looked hard at how a stressed person would actually use this and
fixed the biggest gaps:
- A **"Get help" button is always on screen**, and if it's an emergency there's a big **"Call emergency
  services"** button. Scary results no longer say "Continue" — they say call for help.
- The **progress bar across the top is now honest**: you can't jump into empty or staff-only screens.
- The **result is written for the patient** — how urgent (with a clear color + symbol), what to do, and
  when to get help — instead of dumping medical codes and a diagnosis. The full clinical detail is kept
  for the clinician.
- **Accessibility:** a **text-size** control, **calmer animations** for motion-sensitive people,
  **color-blind-friendly** symbols on the urgency colors, and better support for screen readers.
- **Languages:** a language picker (English, Slovenian, Spanish) for the main on-screen text, and the
  listening already understands many languages. Plus quick "No medicines / No allergies" buttons and a
  friendly message if the microphone is blocked.

Bottom line: the kiosk now behaves like something a real, worried person could safely use — with help
one tap away, plain words, big text, and a voice on every step.

---

## Session 18 — Speaking everyone's language, and showing its work

Two improvements:

**Real translations, everywhere.** Before, only a few buttons changed language. Now **every page** — the
welcome, the consent, "what's wrong", your medicines, the questions, the result, all of it — is properly
translated. We added **Mandarin** and **Cantonese** on top of Slovenian and Spanish. To do it well and
fast, we sent the whole list of on-screen words to **four helpers (one per language) at the same time**,
each a careful translator, and put their work back into the app. The Cantonese is real, natural Cantonese
(the way people actually speak in Hong Kong), not just Mandarin in fancy characters. Pick a language at
the top and the whole thing follows.

**Show your work.** When the assistant gives its final answer (how urgent you are), you couldn't see
*why* it decided that. Now there's a little **"How medpsy reached this"** you can open to read its
thinking behind the decision — so a person can check the reasoning, not just the verdict.

Bottom line: more people can use it in their own language, and you can see the "why" behind the result.

---

## Session 19 — Making it really speak your language (and a tidier welcome)

We discovered the voices weren't actually speaking the right language. If you picked French, it read the
French words with an English mouth; if you picked Chinese, it read the characters one by one. The little
voice engine we were using only really knows English. So we swapped in a better engine (the same one our
test app uses) that genuinely speaks French, Spanish, Italian and Chinese — and we checked: now French
sounds French and Chinese sounds Chinese.

We also **added three more languages** — German, French and Italian — so the kiosk now offers **eight**.
And we made it honest about what works: a little panel shows, for the language you picked, whether it can
**listen** to you and **read aloud** in that language. The languages that don't have a real voice yet
(German, Slovenian, Cantonese) are now shown on their own line with a clear "voice not available yet" note,
instead of pretending.

Two tidy-ups: we **moved the voice and language settings to the very first screen** (where you start),
since that's where it makes sense — and split that screen into a clean "sign in" card plus a separate
"language & voice" card, so it's not cramped. And we added a small **"unlock all steps"** switch at the
bottom (for testing) so you can jump around the screens freely.

Then we gave **Cantonese** a real voice. Our main listening model can't understand Cantonese, and our
main speaking model has no Cantonese voice — so before, Cantonese was the one language that couldn't truly
talk. We added two small specialist models (from a project called sherpa-onnx) that *only* wake up when you
pick Cantonese: one that understands spoken Cantonese, and one that speaks it. Every other language works
exactly as before, and if those Cantonese models aren't installed the app quietly falls back instead of
breaking. We also taught the setup checker about them, so `npm run check` tells you if they're present and
`npm run download-models` fetches them for you (they come as compressed bundles, so the script unpacks them
automatically).

Then we hit a snag: our medical brain (medpsy) only understands **English**. So if a patient
spoke Spanish or Cantonese, we were handing English-only ears a foreign language. The fix: put a
**translator in the middle**. The patient always sees and hears their own language; behind the
scenes we quietly translate what they say *into* English for medpsy, and translate medpsy's
questions and final advice *back* into their language. medpsy never has to learn other languages —
a separate, bigger model (running locally too) does only the translating. We kept the medical
conversation itself in English the whole time (so the official handover note, the billing codes,
and the doctor's review all stay in the one language clinicians expect), and only the parts the
patient actually reads get translated. And if the translator isn't switched on, nothing breaks —
it just falls back to the old behaviour. We tested it: Spanish comes out naturally, and Cantonese
comes out in proper Chinese characters.

Bottom line: it now truly speaks (and listens) in many languages, and tells you honestly which ones work.

---

## Session 20 — Cutting the cord: the whole brain now runs on the device

The whole point of this project is to run on **QVAC** — the on-device AI engine. But quietly,
during building, we'd been leaning on a separate helper app (LM Studio) to actually run the
medical brain. This session we made the real thing work: medpsy **and** the medical-code matcher
now run **directly on QVAC, on the device, with nothing fetched from the network**.

The only thing in the way was plumbing. The website part knew how to talk to a "standard AI
socket," but QVAC is a toolkit, not a server with that socket — so we added a tiny **adapter** so
the website talks to QVAC through the same socket it always used. No website changes needed.

Then a confusing hiccup: switching to QVAC, it **froze trying to download a model over a
peer-to-peer network** that wasn't reachable. It turned out the medical brain itself loaded
fine — it was an *extra* text-understanding model it tried to fetch, and **we don't even use that
one**. We use a small model called "nomic" — the same one all along. So we handed QVAC a local
copy of nomic, and now nothing touches the network. We double-checked it still finds the right
medical codes.

We also made it far easier for a teammate to set up on a **Linux** laptop (it used to have one
person's personal folder path baked in) and wrote a step-by-step setup guide.

Bottom line: it now genuinely runs **entirely on the device**, on QVAC, start to finish — no
cloud, no separate app, no network.

---

## Session 21 — We tried a fancier code-finder, and kept the simple one

To turn "what's wrong" into an official medical code, we use a matching tool. QVAC offers a
fancier "RAG" database that's supposed to be good at search, so we **tested whether it beats
ours** — fair and square, on the same 20 test cases, using the same understanding underneath.

It lost badly: ours got **16 of 20** right; the fancy one got **1 of 20** (it suggested "SARS"
for appendicitis). The reason: that fancier tool is built for searching through **long
documents**, not matching short labels to a fixed list — and since it uses the very same
understanding ours does, it can't really do better anyway. So we kept our simple, exact matcher.

Bottom line: tested honestly, the simple tool won — so we kept it.

---

## Session 22 — A black box for every visit (that can't be secretly changed)

Until now, once a patient finished, the whole conversation just… vanished. For something that helps
make medical decisions, that's not okay — a doctor (or, later, someone checking what went wrong) needs
to be able to look back and see *exactly* what happened. So we built a **flight recorder** for every
patient visit.

Every meaningful thing is written down the instant it happens: which screen the patient was on, what
they typed or said out loud, what the assistant asked **and the exact thinking behind it**, the
translations both ways (so you can tell if a bad *translation* — not the AI — caused a mistake), the
verified medical code, the final urgency decision, and the doctor's sign-off.

The clever part: each entry is **sealed to the one before it with a digital fingerprint**, like links in
a chain. If anyone ever went back and changed or deleted even a single word, the chain breaks — and the
app can point at the exact spot where it was tampered with. You simply can't quietly rewrite history.

Each patient gets their **own** record. There's a new **"Audit"** page where you can open any visit, see
the whole timeline, check the green "untampered ✓" badge, and **export it as a single sealed file** to
hand to a hospital — who can load it back in, and the app will confirm it's genuine and unaltered. It all
stays **on the device** (it's private medical information); nothing leaves unless you choose to share it.

Bottom line: every visit now keeps an honest, sealed, replayable record — so the AI's decisions can
always be checked afterwards, and that record can't be secretly altered.

---

## Session 23 — Picking the right translator (and being honest about Slovenian)

We have a separate AI just for translating between the patient and our English-only medical brain.
Before trusting it, we **tested** it properly — and not with easy sentences, but with the scary ones:
"stiff neck and a rash that doesn't fade" (a meningitis warning), "blood in your vomit, black stools"
(internal bleeding), exact drug doses. We checked both directions for all the languages.

Two good pieces of news and one awkward one. Good: **understanding the patient works for every
language** — when someone describes their symptoms, our brain gets an accurate English version, which
is the part that actually decides how urgent things are. Also good: translating *to* the patient is
great for French, Spanish, Italian, German, Mandarin and Cantonese.

The awkward one: **Slovenian**. Our fast translator mangled it — it turned "stiff neck" into "neck
feather" and "blood in your vomit" into "blood in the scalp", and even leaked Russian letters. That's
not a typo you can shrug off on a medical warning. We tried other models: one translated Slovenian
beautifully but took **one to three *minutes* per sentence** (it "overthinks" everything) — useless for
a live conversation — and the quick small ones mangled it too. The honest truth is that Slovenian is a
"small" language these models just haven't learned well enough yet.

So we made a safe choice instead of a flashy one: for Slovenian, we **keep understanding the patient**
(that direction is reliable), but we **show the assistant's questions and advice in English** rather than
risk a dangerously wrong Slovenian warning. (Slovenian was already marked "limited" in the app — no
voice yet either.) The moment a fast, accurate Slovenian translator exists, it's a one-line switch.

Bottom line: we measured before we trusted, kept the fast translator that's reliable for six languages,
and chose safe-and-honest over confidently-wrong for the one language the machines can't yet do well.

---

## Session 24 — Beaming records between devices, and a pocket library for the pharmacist

This session answered a fair question: if the whole point of our toolkit (QVAC) is that it's
*more* than a plain AI engine, where's the proof? It turned out the proof was already installed —
the toolkit quietly ships with the same technology BitTorrent-style apps use to let two computers
talk **directly to each other**, with no server in the middle. We just hadn't used it yet.

First feature: **beaming a patient's record from the kiosk to the pharmacist's computer.** Until
now you had to download a file and carry it over. Now the kiosk shows a short code (like
`NRM8-P72M`), the pharmacist types it on their machine, and the sealed record travels straight
between the two devices over an encrypted connection — never touching the internet's servers, never
touching a cloud. And we gave every device its own unforgeable digital signature (think wax seal),
so the receiving pharmacist can prove not just that the record wasn't tampered with, but *which
kiosk* it came from. We tested it for real — two separate "devices", one sealed record, delivered
and verified. One catch we're honest about: finding the other device currently uses a public
address book on the internet; a pharmacy with no internet at all would need a small local one.

Second feature: **a built-in reference library.** We wrote a starter shelf of pharmacy fact sheets
(drug combinations that hurt people, plus local rules like "any head bump on blood thinners goes to
the ER") and taught the kiosk to pull up the right page the moment it reaches a conclusion — shown
to the *pharmacist*, clearly labeled as reference, never acted on automatically. Before trusting
the fancy library-search tool that came with our toolkit, we tested it against our boring simple
one — 24 tricky questions, none reusing the documents' exact words. The fancy tool did fine (it
found the right document in its top-3 picks 92% of the time), but boring-and-simple found it **100%
of the time**. So, same verdict as last time: keep the simple one. The library is just a folder of
text files, which means updating every kiosk's knowledge is as easy as beaming files — using
feature number one.

Bottom line: the kiosk can now hand its sealed records directly to the pharmacist's computer like a
relay baton, each one wax-stamped with which machine made it, and it reads up on the right fact
sheet before the pharmacist even asks — all still without a single byte leaving the building.

---

## Session 25 — We checked whether translating hurts the diagnosis (and caught ourselves making a measuring mistake)

The kiosk understands a patient in their own language by quietly translating their words into
English for the medical brain. That's a lot of trust to place in a translator on a *medical*
tool, and we'd never actually tested it. So we set up an experiment: take 20 of our nastiest
trick cases (the quiet heart attack, the deceptively-fine overdose), have a top-quality
translator turn them into Slovenian, Mandarin and Spanish, then push them through the kiosk's
*own* translator back into English and see whether the urgency verdict (red/amber/green) comes
out different from the plain-English version.

Then we caught ourselves about to make a classic mistake. When we ran each case once, the
verdict changed about **40% of the time even on the exact same English** — no translation
involved at all. The medical brain just isn't perfectly consistent: ask it twice, it sometimes
says "emergency" and sometimes "urgent" for the same story. If we'd trusted single runs, we'd
have blamed the translator for wobble that was really the brain's own coin-flip. So we changed
the method: ask **five times and take the majority vote**, for every case, in every language.

With that fix, the answer was clear and a little surprising. **The translator is not the
problem.** Every time a verdict shifted, it turned out the plain-English version was *already*
unsure of itself, and the translations themselves were faithful — even the Slovenian ones kept
the dangerous details intact ("tearing pain between the shoulder blades", "fruity breath", "20
tablets"). That's genuinely reassuring, because Slovenian was the language we were most worried
about.

The thing we *did* find worth fixing is the medical brain's own indecision: on a handful of the
trickiest cases it flips between "emergency" and "urgent" depending on luck. In real life the
patient sees one answer, so that coin-flip matters more than the translation does. We wrote it
up as its own to-do. The honest summary: we tried to test the translator, accidentally
discovered our measuring tool was noisy, fixed the tool, and learned that the real wobble lives
in the brain, not the bridge between languages.

---

## Session 26 — Teaching the kiosk to listen and speak in the right language

Someone tried the kiosk by hand and noticed it sometimes wrote down what they said in the wrong
language, or read its answers aloud in the wrong accent. The embarrassing cause: the kiosk *knew*
which language the person had chosen — it just wasn't telling the ear and the voice. The
"listening" part was set to "guess the language," so a short or accented sentence could get
mistaken for another language. And the "speaking" part was using whatever voice was left over
from the last person, so it might read English with a Spanish mouth.

We fixed both: now the chosen language is handed to the listener (and if the listener doesn't know
that language, it safely falls back to "guess" instead of breaking), and the voice is always the
right one for the current language. We also made the kiosk warm up the right language's gear the
moment you pick it, so there's no awkward pause mid-conversation. Small bug, real difference: on a
medical tool, hearing "stiff neck" correctly matters.

## Session 27 — Giving the helper a way to look things up instead of guessing

Until now the medical helper answered from memory. We added a separate "Ask MedPsy" page where it
can actually *use tools* — look up the official code for a condition, search our local fact
sheets, check a medication list — and then answer, showing you exactly which tools it used and
what they returned. So instead of "I think the code is roughly K35," it calls the lookup and says
"K35.8, from the verified list." It runs alongside the normal step-by-step flow, never replacing
it, and every tool it touches is written into the tamper-proof logbook. We also gave it a thorough
once-over and fixed the rough edges (it no longer keeps thinking after you close the page, no
double-counting, clean cancellation).

## Session 28 — A memory with a sense of time (and how a patient's record could travel)

This was the big one. We built a little "memory" the helper can read and write — but a special
kind that understands **time in two directions**. It knows both *when something was true* ("on
warfarin since 2024, stopped in March") and *when we learned it* ("we recorded the dose on the
1st, corrected it on the 20th"). That second one is the magic: you can ask "what did we believe on
the day of the June visit?" and get the honest answer, even if we corrected it later — exactly the
question a safety review asks. Nothing is ever erased; the record only grows, and every entry is
sealed so tampering shows.

It's deliberately general — not just for patients, but a reusable building block (we packaged it so
it could even become part of the QVAC toolkit). On top of it we added the things that make it safe
and useful: the helper's notes start as *proposals* a clinician confirms or rejects; when two
sources disagree (the hospital record vs. what the patient said), the more trustworthy one wins and
the other is flagged, not silently dropped; and a hand-written drug-interaction map lets the helper
catch "warfarin + ibuprofen = dangerous" from the *facts*, not a fuzzy guess — even when the
medicine was written down as "Coumadin" or "Nurofen 400mg." And because each patient's record is a
self-contained sealed bundle, it can travel device-to-device — so in a clinic with no central
computer, the patient's record can move *with them*, which is the whole point of an offline-first
tool.

We reviewed it hard (twice) and the reviews earned their keep — they caught a case where two
devices with slightly different clocks could make a "stopped this medicine" note silently vanish,
and a case where a dosed medicine name wouldn't match the danger list. Both fixed. The honest
status: the memory and its safety features are built and tested; making records actually sync
between two physical devices over the air is the next step.

## Session 29 — Letting the helper run the interview itself, writing down everything, and a way to share what it knows

Until now the kiosk asked the questions in a fixed nine-step order, and the AI just helped at the
end. This time we let the AI **run the conversation itself** — a separate "agentic triage" we built
*alongside* the old flow without touching it (so nothing we trusted got disturbed). It asks one
question at a time, looks things up in its on-device tools as it goes, and finishes with a proper
structured assessment a pharmacist reviews. In a test where someone had a head injury *and* was on a
blood thinner, it correctly drove straight to **EMERGENCY** — that's the combination that can bleed
in the brain.

The little model is flaky — sometimes it returns nothing, sometimes it scribbles its answer in the
wrong format, sometimes it "thinks out loud" before the actual question. So we made the helper
**stubborn**: if it comes back empty, try again, and again. We taught it to recognise the
wrong-format answers and read them anyway. And the thinking-out-loud part — we first threw that away,
but the user stopped us: *that reasoning is valuable, don't bin it.* So now the patient sees just the
clean question, and the helper's reasoning is tucked into a little fold-out you can open, **and**
it's written into the permanent record.

Which brings us to the big theme: **write down everything.** Every visit already had a sealed,
tamper-proof logbook. We made sure the new AI-led interview writes *every* step into that same
logbook — what the patient said, what the helper reasoned, what it looked up, and the final call —
using the *same* labels the old flow uses, so any visit reads the same way whether the AI ran it or
not. (Before, some of those — like the patient's own answers — weren't being saved at all. Now they
are.)

Finally, a way to **share what the helper knows**. There's an open standard from Google called OKF —
basically a tidy folder of plain text files describing facts and how they connect — that lets
different tools swap knowledge. We wired it up two ways. The helper's drug-interaction map can now be
**exported as one of these folders** (and read back in), so a pharmacist could share or update it
with the wider ecosystem; we were honest in the app that this format is a bit lossy (it forgets the
*type* of each connection), so the sealed version stays the real one. And you can now look at any
visit's logbook **rendered in that same shareable format** — clearly stamped "not the official
record," because turning the sealed logbook into plain text would throw away the very seals that make
it trustworthy. Knowing when *not* to use a format is half the job.

## Session 30 — Getting the smart helper to run on the real on-device engine

The whole point of this project is that it runs on YOUR device — no cloud. There's a special
on-device engine for that (the "QVAC SDK"). But here's the thing we'd been quietly avoiding: the
clever tool-using helper had only ever been tested on a *developer's* stand-in engine, not the real
on-device one. So we actually tried it on the real engine — and it didn't work. Three reasons, all
found and fixed:

- The helper handed its list of tools to the engine in the wrong shape, and the engine choked.
- When the helper looked something up and wanted to feed the result back, the engine's notebook had
  no place to write "here's what the tool said" — so that information silently vanished.
- Biggest one: the engine never actually *told the model* "you're allowed to use tools, here's how."
  So the model, not knowing the secret handshake, just answered from memory and pretended it had
  looked things up. Once we taught it the handshake (and learned to read its answer even when it
  wrote the tool request as plain text), it started really using the tools.
- And it kept running out of "desk space" — the engine only gave it a tiny scratchpad by default, so
  it ran out of room the moment a lookup came back. We gave it a proper-sized desk.

After the fixes we ran our scorecard **on the real on-device engine**: the helper picks the right
tool and grounds its answer about as well as it did on the developer engine, and in the live
practice run it correctly flagged a sneaky heart-attack case as an emergency. So the headline — "this
clever assistant runs entirely on your own device" — went from a hope to a demonstrated fact. (Still
on the wish-list: letting the helper phone a colleague's device for a second opinion, sharing the
medicine-danger map between devices live, and a little dashboard that shows off the on-device
scorecard.)

## Session 31 — Showing the trust, sharing the knowledge, and phoning a colleague

Three features that only make sense because everything runs on your own device and devices can talk
straight to each other — no cloud in the middle.

**A "trust" page.** If a pharmacist (or a hackathon judge) is going to rely on this, they should be
able to *check* it in ten seconds. So we added a dashboard that shows three things at a glance: it's
running on this device (not some server far away), the assistant's answers come from looking things
up (not guessing) — with a live scorecard of how often it does that right — and every decision is
written into the sealed logbook. We also made a single command that runs the whole thing fully
on-device.

**A shared medicine-danger map that updates live.** Until now each kiosk had its own copy of the
drug-interaction map. Now one kiosk can *share* its map and another can *join* it — straight between
the two devices, no server — and if you add a new danger on one, the other's assistant knows about it
moments later. The tricky bit was timing: when the second device first connects, it briefly thinks
the map is empty before the data arrives, so we taught it to wait for the data instead of trusting
that first empty glance. We proved it works two ways, including over the real internet between two
copies.

**Phoning a senior colleague.** The big one for a clinic with no cloud: mid-conversation, the
assistant can now *consult another device* — a senior clinician's station — for a second opinion, and
get a signed answer back, all device-to-device. The signature means each side knows exactly which
device it's talking to, and the whole exchange gets written into the visit's sealed logbook. We
proved the round-trip works over the real network: ask a question, the other device's AI answers, the
answer comes back signed and verified.

That completes the four things we set out to do this stretch: get the clever assistant running on the
real on-device engine, let it phone a colleague, share knowledge between kiosks live, and put a trust
dashboard on top — all of it local-first, all of it verifiable.

## Session 32 — The clinic that learns from its mistakes (without anyone's data ever leaving)

This is the big one — the thing that, if it works, is genuinely new. Here's the problem with normal
medical AI: to get smarter, it has to slurp up everyone's records into a cloud. We did the opposite.

Imagine a pharmacist notices the assistant *missed* a dangerous drug combination. Normally that
correction is lost. Now: the pharmacist (or the assistant itself) writes down the lesson as a tiny,
anonymous fact — just "drug A + drug B = dangerous, because…", with no patient attached. That lesson
doesn't get trusted yet. First it's **challenged**: the assistant is told to play devil's advocate and
try to *disprove* it. (When we tested it with a real interaction — warfarin and a common antifungal —
it correctly confirmed it, and even explained the biochemistry.) If the lesson survives the challenge,
a clinician approves it, and only then does it become part of the shared knowledge — and it spreads,
device to device, to every other kiosk, which immediately starts catching that combination too. Every
step is written into a sealed, tamper-proof logbook, so you can always see *why* the network believes
something and who approved it.

The crucial safety bit: an *unproven* lesson is never acted on — we tested that the assistant ignores
a not-yet-approved warning, even after it has arrived from another device, and only starts using it
once it's been approved. We proved the whole journey end-to-end: one kiosk learns it, a second kiosk
receives it, refuses to use it while it's unproven, then starts using it the moment it's approved —
and through all of that, the only thing that ever travelled between devices was two drug names. No
patient, ever.

So the network of kiosks gets collectively smarter from real-world corrections, every lesson is
challenged and approved and traceable, and no one's private health data ever leaves the room. That's
the part that's hard to do anywhere but on a device-to-device, on-device stack like this one.

**And then we made the challenge a panel, not a solo act.** Instead of just *one* assistant playing
devil's advocate, a proposed lesson now gets sent to *other* kiosks too — each one's AI judges it
independently and sends back a signed verdict (signed so you know exactly which device voted). We
tested it: a proposed interaction (clopidogrel + a common heartburn drug) got a "yes, real" from the
local assistant — with the correct biochemistry — and an independent signed "yes, real" from a second
device. A jury of AIs, each on its own device, voting on whether a piece of medical knowledge is true,
with every vote on the record. (Plus a small tidy-up so you can't accidentally propose something the
system already knows.)

Then we made the jury *real* (it had been asking only the first device that answered — now it asks
*everyone* and tallies one vote per device), and we added the last piece: **the assistant can now
write the lesson itself.** Instead of a human typing "drug A + drug B is dangerous," a clinician just
pastes their correction in plain English — "I overrode the triage, the patient was on simvastatin and
got prescribed an antifungal, that's a major interaction you missed" — and the assistant reads it,
figures out the actual drug pair and the reason, and proposes the lesson on its own. We tested it both
ways: it correctly pulled "warfarin + miconazole" out of one correction and "simvastatin +
itraconazole" out of another. A human still has to approve before it's trusted — but the *noticing* and
*writing-down* now happen by themselves. So the full circle is: someone corrects a mistake → the
assistant turns that into a candidate lesson → a jury of AIs on different devices vote on it → a human
approves → and it spreads to every kiosk. All on people's own devices, nobody's records ever leaving.

Finally, two bits of polish that matter for the real world. First, privacy: the one piece of free text
that travels between devices (the short "why" note on a lesson) now gets scrubbed of anything that
looks like an ID or a date of birth before it's shared — and the assistant that writes lessons is only
shown the anonymous summary of a visit, never the patient's own words. (We checked it leaves real
medical terms like "CYP2C9" alone but blanks out a medical-record number.) Second, speed: asking
another device used to take 5–15 seconds each time because it had to *find* the other device on the
network from scratch; now the kiosk keeps a warm line open, so the second question and every one after
comes back almost instantly — we measured one second down to one millisecond.

And to finish: we made the privacy scrubber smarter (it now also catches names, ages and dates, not
just ID numbers — while leaving real medical words alone — and warns the clinician if a note still
looks like it mentions a person), made the "jury" robust so a device that joins the conversation a
moment late still gets to vote, and built a **one-screen guided demo** so anyone can watch the whole
thing happen in about a minute: type a correction → the assistant writes the lesson → a jury of
devices votes → you approve → and right before your eyes, the question "would the assistant catch this
drug combination?" flips from *no* to *yes*. That little before-and-after flip is the whole project in
one gesture.

A careful bug-hunt then caught three real problems before they could bite: two devices voting at the
exact same instant could accidentally erase one of the votes (now they politely take turns); if the
assistant added a sentence after its answer, the system could choke on reading it (now it reads just
the answer cleanly); and one error could crash the demo screen (now it shows a tidy "try again"). And
we made the demo even friendlier: a one-click "auto-run" plays the whole story by itself, a progress
bar shows where you are, and a little box literally lists the only thing that left the device — the two
drug names — next to the words "Patient data shared: none."

## Session 33 — Two kiosks, side by side: watch one teach the other

This is the moment the whole idea becomes real to watch. We set up **two** separate kiosks running at
the same time (think two pharmacies), each with its own private records and its own identity, and put
them side by side on one screen. On the left, **Kiosk A**; on the right, **Kiosk B**. You teach a
missed drug interaction on A — A's own assistant checks it, a second assistant *on Kiosk B* votes on
whether it's true (a signed vote, so you know exactly which device agreed), you approve it — and then,
on the right, Kiosk B's question "would I catch this combination?" flips from **NO** to **YES**. B
learned it from A. And a little box shows the only thing that travelled between them: the two drug
names. No patient, no records, no central server.

Getting the "jury" to actually work took a real fix: each kiosk had been accidentally trying to ask
*itself* for a second opinion (and politely ignoring its own answer), so no real votes came in. We
gave each kiosk a single shared line that both asks neighbours and answers them — now they genuinely
vote on each other's lessons. One command (`npm run demo:two-kiosk`) starts both kiosks, pairs them,
and opens the page. It's the base idea — a clinic network that learns from every correction while no
patient's data ever leaves the room — finally something you can point at and watch happen.

## Session 34 — A real network: every kiosk teaches every other, automatically

Until now one kiosk taught another in a single direction, and you had to manually introduce them. Now
any number of kiosks that share the same code **find each other automatically and form a mesh** — every
kiosk learns from every other, in both directions, with no setup. We proved it: with two kiosks, a
lesson taught on either one shows up on the other in about half a second; with three, a lesson taught
on the third instantly reached the other two, and when one kiosk asked its "jury" whether a new lesson
was real, it got signed votes back from *both* of the others. Lessons even hop across the network
indirectly — if A teaches B and B is connected to C, C picks it up through B — and the system is smart
enough never to loop or double-count. It's the difference between "device A can teach device B" and "a
whole clinic network that quietly keeps each other up to date" — still with nothing but drug names ever
leaving any device.

## Session 35 — A wall of kiosks, and a bouncer at the door

Two improvements. First, a real fix: when two kiosks switched on at the exact same second, they
sometimes couldn't find each other (each waited for the other to speak first). We made them announce
themselves firmly and then look again — now they pair up in about five seconds. Second, and important
for the real world: by default any kiosk that knows the shared code can join the network and have its
lessons trusted — fine for a demo, not for a hospital. So we added an opt-in **guest list**: each
kiosk signs its introduction (so nobody can impersonate another), and you can switch on a mode where
only kiosks on the approved list may join the network or vote on lessons. We proved it: with two
kiosks on the list, a third uninvited kiosk was politely turned away. And we built a **wall-of-kiosks
view** — three (or more) side by side: teach a lesson on any one, and watch the others flip from "no"
to "yes" in about a second, with on-screen buttons to lock the network down to approved members or
open it back up. The clinic network is now both watchable and, when you need it, gated.

## Session 36 — Kiosks that reliably find each other, and a much simpler setup

Two practical fixes. First, the "finding each other" problem from last time wasn't fully solved — it
worked once but not every time. Now each kiosk keeps gently re-introducing itself until it has
connected, and re-sends its details in case the first hello got lost — so two kiosks switched on
together now pair up in about four seconds, every time we tried. Second, setup used to mean typing out
a long list of cryptic settings for each kiosk (where to store its data, its name, its port, …) — easy
to get wrong. Now you just give a kiosk a **name**: "run kiosk B on port 8788" and it figures out all
its own storage and identity from that one name. Shared settings can live in a small config file
instead of being repeated everywhere. Same power, far less fiddly — the kind of thing that makes the
difference between a demo only the author can run and one anyone can.

To round it off: starting a kiosk is now literally `npm run kiosk -- --profile clinic-b --port 8788`,
and the "guest list" of approved kiosks now lives right inside that one shared settings file — so you
hand every kiosk the same little file and they all know both the network's name and exactly who's
allowed in. (There's a one-liner, `npm run identity`, to print a kiosk's ID so you can add it to the
list.) We also stress-tested the network: a kiosk that joins late catches up on everything it missed,
and a kiosk that's switched off and back on rejoins, remembers what it knew, and picks up whatever it
missed while it was away.

We also locked the door properly. Before, the "guest list" was just a note each kiosk kept to itself,
and any kiosk that found the network was handed a copy of the shared notebook before we even checked
who it was. Now the clinic manager signs the guest list with their own tamper-proof signature (like a
wax seal) — if anyone fiddles with it, the kiosks notice and, to be safe, trust *nobody* rather than
risk letting a stranger in. And when two kiosks first meet, they show ID before anything is shared: a
kiosk that isn't on the list never even gets a copy of the notebook, so it has nothing to read. We
tested it with two approved kiosks and one gate-crasher — the two friends shared a made-up drug warning
between them, and the gate-crasher saw nothing at all.

Then we built the big one. So far the kiosks learn when a pharmacist *tells* them something. Now they
can also notice a problem *nobody told them about yet*. Each kiosk quietly keeps a tally: "how many
times did I see these two medicines together, and how many of those times did something look worrying?"
— just numbers, never anything about the actual person. On its own, one kiosk's handful of cases is just
noise. But the kiosks add their tallies together across the whole network, and when a particular pair of
medicines racks up enough worrying cases across *enough different kiosks*, the network raises its hand:
"this pairing keeps causing concern — should it be a known interaction?" That suggestion goes into the
exact same review queue a pharmacist already approves before anything is trusted. So the network can spot
an emerging drug interaction that no single pharmacy had enough cases to notice — and the only things
that ever leave a device are two medicine names and two counts. We proved it both in a quick test and
live across two kiosks: neither had enough alone, together they crossed the line, and the suggestion
popped up for a human to approve.

We also gave the AI-led interview a second set of eyes. Before, when the assistant finished its
interview and reached a verdict, that single verdict went straight to the pharmacist. Now, the moment it
decides, a *second* copy of the model — playing a cautious senior clinician — re-reads everything that
was said and double-checks the call, looking only for the dangerous mistake: calling something routine
when it might be serious. Crucially, this reviewer is allowed to make the verdict *more* cautious but
never *less* — so it can catch an under-played emergency, but it can't talk a real emergency down. If it
disagrees, the assessment is bumped up and the pharmacist sees a clear "safety review escalated this —
here's the red flag we nearly missed" note. And if the reviewer itself ever hiccups, we simply keep the
original verdict rather than block anything. We proved it three ways: it caught a "routine" chest pain
that was actually heart-attack-shaped and raised it to emergency, it left a genuinely minor sore throat
alone, and when we *told* it to downgrade a real anaphylaxis, it refused.

Then we let that second reviewer do more than just veto. Two things. First, if it spots something that
*might* be serious but the interview never actually asked, it now sends the patient **one more pointed
question** to settle it — "did this headache come on suddenly, in seconds?" — instead of guessing. We
cap that at two extra questions per visit so it can never trap someone in an endless interview; if it's
still unsure after that, it just plays it safe and escalates. Second, when a case is genuinely
borderline, the kiosk can **quietly phone a colleague** — it sends a real, signed second-opinion request
to another clinician's device on the network and attaches their reply for the pharmacist to read. That
colleague can only make the call *more* cautious, never less. None of this sends any patient details —
just the medical question. We checked all of it with six scripted situations, including the new
"ask one more question" and "the colleague says escalate" cases, and it behaved exactly as intended.

Then we tried hard to break our own safety check, and tightened the bolts. We found a few ways it could
have quietly let something slip: if the reviewer phrased "send to A&E" in words our code didn't recognise,
the warning could be ignored — so now any disagreement it can't parse is treated as "play it safe and bump
it up." If the reviewer itself had a glitch, we used to skip the "phone a colleague" step too — now a
glitch makes the kiosk *more* likely to call for a second opinion, not less. And we made sure a colleague
who shouts "this is an emergency" can push the case all the way to emergency, not just part-way. None of
these changes can ever make a case *less* urgent — only the same or more. We re-ran our test set (now nine
scenarios) and it passed.

Finally, we actually used the app in a real browser, like a person would, and clicked through everything.
The AI interview correctly called a fake heart-attack an emergency and the safety reviewer agreed; the
"ask MedPsy a question" page looked up a real drug-interaction; the knowledge page let us double-check a
proposed new warning; the tamper-proof logbook showed every step — including the safety review — sealed in
order. The plain step-by-step version (the main app) still walks through sign-in and consent just fine.
Everything worked, with no errors.

---

## Session 37 — A toolbox you can run from the keyboard

Some setup chores were either buried inside the app or only doable by poking the running server.
We pulled them into one tidy command-line tool (`medpsy`) so a clinic's tech person can do them in
a single line, even before the app starts:

- **Set up a new kiosk by answering a few questions.** `medpsy init` walks you through it — which
  AI engine, which port, the kiosk's name, whether it joins a clinic network — and writes the
  settings file for you. No hunting through docs.
- **Give each kiosk its own ID badge.** `medpsy keygen` creates the device's unique signing key —
  the thing that proves "this record really came from *this* kiosk."
- **Check a shared record is genuine.** When one kiosk hands a patient's sealed record to another,
  `medpsy verify` re-checks the seal and signature and says plainly: genuine, or tampered. And
  `medpsy import` only files it if it passes — it refuses anything that doesn't.

These reuse the very same locks and seals the app already used; now they work from the keyboard
too. We also tidied up by deleting two older mini-scripts the new tool replaces.

Bottom line: setting up and trusting kiosks is now a handful of plain commands.

---

## Session 38 — One slide: how we actually used QVAC

The hackathon asks every team to show, on a single slide, how they used the QVAC engine. Instead
of writing something vague, we built the slide straight from the real code — we even counted how
many times each QVAC feature is called — so every claim points at something that actually runs.

It tells the story in three parts: (1) the medical brain, the speech, and the code-matching all
run **on the device** through QVAC — flip one switch and it works with no internet; (2) the kiosks
talk **directly to each other** over QVAC's peer-to-peer network — that's how a lesson learned on
one kiosk reaches the others, and how each record gets its tamper-proof signature; (3) the
time-aware memory and the knowledge library sit on QVAC's building blocks too. We saved it as a
file in the project (so it never drifts from the code) and wrote down how to turn it into real
slides plus a ~30-second script to say out loud.

Bottom line: the required "how we used QVAC" slide is done — and it's honest, because it mirrors
the code.

---

## The whole story in three sentences

We built a tiny medical AI helper, tried our hardest to break it, and found its
medical *safety* is genuinely solid — its real weakness is being a bit too cautious
and bad at making up official codes. We fixed the codes with a lookup tool instead of
trusting the AI's guesses. Then we wrapped it into a private, offline app and designed
how a hospital could use it safely, always with a human in charge.
