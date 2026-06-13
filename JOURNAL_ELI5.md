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

## The whole story in three sentences

We built a tiny medical AI helper, tried our hardest to break it, and found its
medical *safety* is genuinely solid — its real weakness is being a bit too cautious
and bad at making up official codes. We fixed the codes with a lookup tool instead of
trusting the AI's guesses. Then we wrapped it into a private, offline app and designed
how a hospital could use it safely, always with a human in charge.
