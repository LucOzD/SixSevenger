# gen_lexicon.py — one-off: export NLTK's VADER lexicon as a JS module so the
# Cloudflare Worker can score sentiment identically without Python.
import json
import os
from nltk.sentiment.vader import SentimentIntensityAnalyzer

analyzer = SentimentIntensityAnalyzer()
lexicon = {k: round(float(v), 3) for k, v in analyzer.lexicon.items()}

out_path = os.path.join('worker', 'src', 'vader-lexicon.js')
os.makedirs(os.path.dirname(out_path), exist_ok=True)

with open(out_path, 'w', encoding='utf-8') as f:
    f.write('// vader-lexicon.js\n')
    f.write('// AUTO-GENERATED from NLTK\'s vader_lexicon by gen_lexicon.py.\n')
    f.write('// Do not edit by hand. %d entries, word -> valence (-4.0 to 4.0).\n' % len(lexicon))
    f.write('\nexport const VADER_LEXICON = ')
    json.dump(lexicon, f, ensure_ascii=False, separators=(',', ':'), sort_keys=True)
    f.write(';\n')

size_kb = round(os.path.getsize(out_path) / 1024)
print(f'Wrote {out_path}: {len(lexicon)} entries, {size_kb} KB')
