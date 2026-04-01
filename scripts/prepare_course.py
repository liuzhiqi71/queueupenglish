#!/usr/bin/env python3
from __future__ import annotations

import csv
import hashlib
import json
import re
import sys
from collections import Counter
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path


GRAMMAR_KEYWORDS_EN = {
    "adjective",
    "adverb",
    "affirmative",
    "auxiliary",
    "base form",
    "clause",
    "countable noun",
    "dialogue",
    "form",
    "future",
    "grammar",
    "imperative",
    "main verb",
    "negative",
    "noun",
    "object pronoun",
    "paragraph",
    "past",
    "plural",
    "predicate",
    "present",
    "pronoun",
    "proper noun",
    "question",
    "sentence",
    "subject",
    "tense",
    "verb",
    "word order",
}

GRAMMAR_KEYWORDS_CN = (
    "形式",
    "副词",
    "动词",
    "名词",
    "形容词",
    "代词",
    "时态",
    "句",
    "疑问",
    "肯定",
    "否定",
    "过去式",
    "语法",
)

TEMPLATE_PREFIXES = (
    "we learned ",
    "we can use ",
    "our teacher wrote ",
)

TEMPLATE_PHRASES = (
    "in english class today",
    "in class today",
    "in a simple sentence",
)


@dataclass
class CourseItem:
    id: str
    rowNumber: int
    text: str
    cnHint: str
    itemType: str
    example: str
    category: str
    difficulty: str
    difficultyRank: int
    practiceEligible: bool
    capstoneEligible: bool
    exampleNatural: bool
    searchText: str
    capstoneTarget: str | None


CSV_FIELDS = ("单词", "中文", "词组", "词组中文", "例句")


def normalize_space(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip())


def strip_quotes(value: str) -> str:
    return value.replace("“", "").replace("”", "").replace("’", "'").replace("‘", "'")


def looks_full_sentence(text: str) -> bool:
    cleaned = normalize_space(text)
    return bool(cleaned and cleaned[-1] in ".?!")


def is_proper_noun(text: str) -> bool:
    tokens = re.findall(r"[A-Za-z][A-Za-z'.-]*", text)
    if not tokens:
        return False
    capitalized = sum(token[0].isupper() for token in tokens)
    if len(tokens) >= 2 and capitalized >= len(tokens) - 1:
        return True
    return len(tokens) == 1 and capitalized == 1 and text != text.lower()


def detect_category(text: str, cn_hint: str) -> str:
    text_lower = text.lower()
    if "->" in text or "不规则" in cn_hint or "过去式" in cn_hint:
        return "irregularForm"
    if looks_full_sentence(text):
        return "fullSentence"
    if any(keyword in text_lower for keyword in GRAMMAR_KEYWORDS_EN):
        return "grammar"
    if any(keyword in cn_hint for keyword in GRAMMAR_KEYWORDS_CN):
        return "grammar"
    if is_proper_noun(text):
        return "properNoun"
    return "lexical"


def build_search_variants(text: str) -> list[str]:
    text = normalize_space(strip_quotes(text))
    variants: list[str] = []
    candidates = [text]
    without_parens = normalize_space(re.sub(r"\([^)]*\)", "", text))
    if without_parens:
        candidates.append(without_parens)
    if "->" in text:
        left, right = [normalize_space(part) for part in text.split("->", 1)]
        candidates.extend([left, right])
    for candidate in candidates:
        candidate = normalize_space(candidate.strip(" \"'"))
        if candidate and candidate not in variants:
            variants.append(candidate)
    return variants


def build_variant_regex(variant: str) -> str:
    pieces = [re.escape(piece) for piece in variant.split()]
    if re.fullmatch(r"[A-Za-z'.-]+(?:\s+[A-Za-z'.-]+)*", variant):
        joined = r"\s+".join(pieces)
        return rf"(?<![A-Za-z]){joined}(?![A-Za-z])"
    return re.escape(variant)


def detect_capstone_target(example: str, variants: list[str]) -> str | None:
    example = strip_quotes(example)
    for variant in variants:
        if re.search(build_variant_regex(variant), example, flags=re.IGNORECASE):
            return variant
    return None


def is_template_example(example: str) -> bool:
    lowered = strip_quotes(example).lower().strip()
    if any(lowered.startswith(prefix) for prefix in TEMPLATE_PREFIXES):
        return True
    return any(fragment in lowered for fragment in TEMPLATE_PHRASES)


def detect_difficulty(text: str, example: str, category: str, item_type: str, search_text: str) -> tuple[str, int]:
    letters = len(re.sub(r"[^A-Za-z]", "", search_text or text))
    token_count = len(re.findall(r"[A-Za-z]+(?:'[A-Za-z]+)?", search_text or text))
    example_words = len(example.split())

    score = 0
    if item_type == "phrase":
        score += 1
    if token_count > 2:
        score += 1
    if letters > 5:
        score += 1
    if letters > 9:
        score += 1
    if any(symbol in text for symbol in "()/-") or "->" in text:
        score += 1
    if example_words > 8:
        score += 1
    if category in {"grammar", "properNoun", "fullSentence", "irregularForm"}:
        score += 1

    if score <= 1:
        return "easy", 1
    if score <= 3:
        return "medium", 2
    return "hard", 3


def row_to_item(row_number: int, row: dict[str, str]) -> CourseItem:
    word = normalize_space(row.get("单词", ""))
    phrase = normalize_space(row.get("词组", ""))
    text = word or phrase
    cn_hint = normalize_space(row.get("中文", "") or row.get("词组中文", ""))
    example = normalize_space(row.get("例句", ""))
    item_type = "word" if word else "phrase"
    category = detect_category(text, cn_hint)
    variants = build_search_variants(text)
    search_text = variants[0] if variants else text
    example_natural = not is_template_example(example)
    capstone_target = detect_capstone_target(example, variants)
    capstone_eligible = bool(
        example
        and example_natural
        and capstone_target
        and category not in {"grammar", "fullSentence", "properNoun"}
    )
    difficulty, difficulty_rank = detect_difficulty(text, example, category, item_type, search_text)
    return CourseItem(
        id=f"{item_type[:2]}-{row_number:04d}",
        rowNumber=row_number,
        text=text,
        cnHint=cn_hint,
        itemType=item_type,
        example=example,
        category=category,
        difficulty=difficulty,
        difficultyRank=difficulty_rank,
        practiceEligible=True,
        capstoneEligible=capstone_eligible,
        exampleNatural=example_natural,
        searchText=search_text,
        capstoneTarget=capstone_target,
    )


def build_course_revision(rows: list[dict[str, str]]) -> str:
    normalized_rows = [
        {field: normalize_space(row.get(field, "")) for field in CSV_FIELDS}
        for row in rows
    ]
    payload = json.dumps(normalized_rows, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]


def main() -> int:
    if len(sys.argv) < 3:
        print(
            "Usage: python3 scripts/prepare_course.py "
            "/path/to/source.csv /path/to/output/course.json",
            file=sys.stderr,
        )
        return 1

    source_csv = Path(sys.argv[1]).expanduser().resolve()
    output_json = Path(sys.argv[2]).expanduser().resolve()
    output_js = output_json.with_suffix(".js")

    rows: list[dict[str, str]] = []
    items: list[CourseItem] = []
    with source_csv.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for row_number, row in enumerate(reader, start=1):
            if not (row.get("单词") or row.get("词组")):
                continue
            rows.append(row)
            items.append(row_to_item(row_number, row))

    category_counts = Counter(item.category for item in items)
    difficulty_counts = Counter(item.difficulty for item in items)
    type_counts = Counter(item.itemType for item in items)

    payload = {
        "meta": {
            "courseRevision": build_course_revision(rows),
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "sourceCsv": str(source_csv),
            "totalItems": len(items),
            "practiceEligible": sum(item.practiceEligible for item in items),
            "capstoneEligible": sum(item.capstoneEligible for item in items),
            "typeCounts": dict(type_counts),
            "categoryCounts": dict(category_counts),
            "difficultyCounts": dict(difficulty_counts),
            "routeSize": 12,
            "capstoneBatchSize": 20,
        },
        "items": [asdict(item) for item in items],
    }

    output_json.parent.mkdir(parents=True, exist_ok=True)
    output_json.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    output_js.write_text(
        "window.WORD_QUEUE_COURSE = "
        + json.dumps(payload, ensure_ascii=False)
        + ";\n",
        encoding="utf-8",
    )

    print(f"Wrote {len(items)} items to {output_json}")
    print(f"Wrote JS fallback to {output_js}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
