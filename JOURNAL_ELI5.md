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

## The whole story in three sentences

We built a tiny medical AI helper, tried our hardest to break it, and found its
medical *safety* is genuinely solid — its real weakness is being a bit too cautious
and bad at making up official codes. We fixed the codes with a lookup tool instead of
trusting the AI's guesses. Then we wrapped it into a private, offline app and designed
how a hospital could use it safely, always with a human in charge.
