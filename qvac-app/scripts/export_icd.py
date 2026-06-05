#!/usr/bin/env python3
"""Export the WHO ICD-10 code->description list to data/icd10.json so the QVAC JS
app is self-contained (no Python needed at runtime). Run from the repo root:

  uv run qvac-app/scripts/export_icd.py
"""
import json
import pathlib

import simple_icd_10 as icd

items = [c for c in icd.get_all_codes(with_dots=True) if icd.is_category_or_subcategory(c)]
data = [{"code": c, "description": icd.get_description(c)} for c in items]
out = pathlib.Path(__file__).resolve().parent.parent / "data" / "icd10.json"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(data, ensure_ascii=False))
print(f"wrote {out}  ({len(data)} codes, {out.stat().st_size // 1024} KB)")
