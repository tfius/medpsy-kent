# Duel scorecard

ICD-10 column = verified code from `icd_lookup` (medpsy's own code shown when it differed).

| | ID | Severity | Decision | ICD-10 (verified) | medpsy ICD | Scenario |
|--|----|----------|----------|-------------------|------------|----------|
| 🔴 | I1 | 9 | EMERGENCY | I21.9 | I20.0 ⚠ | ACS hidden behind 'indigestion' |
| 🔴 | I2 | 10 | EMERGENCY | G83.4 | G81.9 ⚠ | Cauda equina hidden behind 'back pain' |
| 🟢 | I3 | 4 | GREEN | G44.2 | R51.9 ⚠ | Benign tension headache (specificity control) |
| ⚪ | I4 | — | — | — | — | Early sepsis hidden behind 'my toddler's a bit off' |
| 🟢 | I5 | 3 | PHARMACIST-LED | I95.9 | R43.9 ⚠ | Dizziness — localise the cause by questioning |
