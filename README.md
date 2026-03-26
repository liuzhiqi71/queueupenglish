# Queue Up English

A static iPad-friendly English learning game built with plain HTML, CSS, and JavaScript.

## Local preview

```bash
cd /Users/weiliu/word-queue-english
python3 -m http.server 4174
```

Then open `http://127.0.0.1:4174/`.

## Data

The runtime course data lives in `data/course.json` and `data/course.js`.

To rebuild it from CSV:

```bash
python3 scripts/prepare_course.py "/Users/weiliu/Downloads/四册合并去重_单词词组_加例句.csv" "./data/course.json"
```
