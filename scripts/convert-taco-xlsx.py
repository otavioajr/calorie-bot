"""
Convert the official UNICAMP TACO 4th Edition Excel file to clean JSON.

Usage:
  python3 scripts/convert-taco-xlsx.py

Input:  docs/Taco-4a-Edicao.xlsx
Output: docs/taco_foods_extracted.json
"""

import json
import openpyxl

INPUT = "docs/Taco-4a-Edicao.xlsx"
OUTPUT = "docs/taco_foods_extracted.json"

# Column mapping: Excel col index -> JSON field name
COLUMNS = {
    1:  "name",
    2:  "humidity_pct",
    3:  "energy_kcal",
    4:  "energy_kj",
    5:  "protein_per_100g",
    6:  "lipids_per_100g",
    7:  "cholesterol_mg",
    8:  "carbs_per_100g",
    9:  "fiber_per_100g",
    10: "ash_g",
    11: "calcium_mg",
    12: "magnesium_mg",
    # 13 is duplicate number column — skip
    14: "manganese_mg",
    15: "phosphorus_mg",
    16: "iron_mg",
    17: "sodium_per_100g",
    18: "potassium_mg",
    19: "copper_mg",
    20: "zinc_mg",
    21: "retinol_mcg",
    22: "vitamin_a_re_mcg",
    23: "vitamin_a_rae_mcg",
    24: "thiamine_mg",
    25: "riboflavin_mg",
    26: "pyridoxine_mg",
    27: "niacin_mg",
    28: "vitamin_c_mg",
}


def parse_value(val):
    """Convert Excel cell value to a clean number or null."""
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return round(val, 2)
    s = str(val).strip()
    if s in ("NA", "na", "N/A", "-", "*", ""):
        return None
    if s in ("Tr", "tr", "TR"):
        return 0.0
    # Skip Excel formulas
    if s.startswith("="):
        return None
    try:
        return round(float(s.replace(",", ".")), 2)
    except ValueError:
        return None


def main():
    wb = openpyxl.load_workbook(INPUT, read_only=True)
    ws = wb["CMVCol taco3"]
    rows = list(ws.iter_rows(values_only=True))

    # Skip header rows (0, 1, 2)
    data_rows = rows[3:]

    foods = []
    number = 0

    for row in data_rows:
        cols = list(row)
        name = cols[1]

        # Skip empty rows
        if not name or str(name).strip() == "":
            continue

        number += 1
        full_name = str(name).strip()

        # Split on first comma: "Banana, prata, crua" → base="Banana", variant="prata, crua"
        parts = full_name.split(",", 1)
        food_base = parts[0].strip()
        food_variant = parts[1].strip() if len(parts) > 1 else ""

        food = {
            "number": number,
            "name": full_name,
            "food_base": food_base,
            "food_variant": food_variant,
        }

        for col_idx, field in COLUMNS.items():
            if field == "name":
                continue
            food[field] = parse_value(cols[col_idx] if col_idx < len(cols) else None)

        foods.append(food)

    # Write JSON
    with open(OUTPUT, "w", encoding="utf-8") as f:
        json.dump(foods, f, ensure_ascii=False, indent=2)

    print(f"Extracted {len(foods)} foods to {OUTPUT}")

    # Quick validation
    zero_energy = [f for f in foods if f["energy_kcal"] == 0 or f["energy_kcal"] is None]
    zero_sodium = [f for f in foods if f["sodium_per_100g"] == 0 or f["sodium_per_100g"] is None]
    print(f"  Zero/null energy: {len(zero_energy)}")
    print(f"  Zero/null sodium: {len(zero_sodium)}")

    # Validate base/variant split
    from collections import Counter
    base_counts = Counter(f["food_base"] for f in foods)
    multi_variant = [(b, c) for b, c in base_counts.most_common() if c > 1]
    print(f"  Bases with multiple variants: {len(multi_variant)}")

    # Spot check
    for f in foods:
        if f["name"] == "Arroz, integral, cozido":
            print(f"\n  Spot check — {f['name']}:")
            print(f"    base={f['food_base']}, variant={f['food_variant']}")
            print(f"    energy={f['energy_kcal']} kcal, sodium={f['sodium_per_100g']}mg")
            break


if __name__ == "__main__":
    main()
