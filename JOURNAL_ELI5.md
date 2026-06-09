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

## The whole story in three sentences

We built a tiny medical AI helper, tried our hardest to break it, and found its
medical *safety* is genuinely solid — its real weakness is being a bit too cautious
and bad at making up official codes. We fixed the codes with a lookup tool instead of
trusting the AI's guesses. Then we wrapped it into a private, offline app and designed
how a hospital could use it safely, always with a human in charge.
