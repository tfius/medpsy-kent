# Reference translations of the adversarial bank (for the translation-safety eval)

These are **reference** translations of `questions_adversarial/` cases into the kiosk's
non-English UI languages, produced by a strong translator (Claude), **not** by the kiosk's
shipped translator (gemma). They are the *input* to the translation-safety eval
(`run_translation_eval.py`): the patient's native-language complaint that then goes through
the shipped gemma→medpsy path, so the eval measures gemma's fidelity — not the reference's.

One file per `<lang>/<source-file>.json`, mirroring `questions_adversarial/`. Each sample:
- `id`, `subcategory` — copied from the source case.
- `user_en` — the original English complaint (the baseline).
- `user` — the reference translation into `<lang>`.

Currently the **smoke slice**: `sl`, `zh`, `es` × `adv1_undertriage` + `adv3_drug_traps`
(20 cases each language). Slovenian is the known-fragile one (the June 12 decision disabled
gemma's *outbound* Slovenian on anecdote; this eval is the first measurement of the *inbound*
path) and is worth a native-speaker spot-check. See GitHub issue #1 for the full design.
