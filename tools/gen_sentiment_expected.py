# gen_sentiment_expected.py — score a set of phrases with NLTK's VADER and
# write the results, so the JavaScript port can be verified against them.
import json
import os
import sqlite3
from nltk.sentiment.vader import SentimentIntensityAnalyzer

analyzer = SentimentIntensityAnalyzer()

# Hand-picked cases exercising each branch of the algorithm
phrases = [
    "i love geometry dash",
    "i HATE geometry dash",
    "geometry dash is literally AMAZING",
    "not good at all",
    "coca cola is the WORST thing ever",
    "six seven is pretty cool I guess",
    "this is not bad",
    "this is extremely good",
    "this is barely good",
    "the food was great but the service was terrible",
    "the service was terrible but the food was great",
    "that movie was the shit",
    "yeah right, brilliant idea",
    "at least it was cheap",
    "least favourite thing ever",
    "never so good",
    "never this bad",
    "AMAZING!!!",
    "amazing",
    "amazing!!!!!!!!",
    "really??",
    "what???",
    "kind of good",
    "sort of terrible",
    "GREAT job everyone",
    "great job everyone",
    "I don't like it",
    "I can't stand this",
    "without doubt the best",
    "bad ass performance",
    "",
    "a",
    "12345",
    "😍😍",
    "i LOVE geometry dash 😍😍",
    "he is a hard worker",
]

# Add real posts from the database so the test reflects actual content
db_path = 'database.db'
if os.path.exists(db_path):
    try:
        conn = sqlite3.connect(db_path)
        rows = conn.execute(
            'SELECT text FROM posts WHERE deleted = 0 ORDER BY timestamp DESC LIMIT 60'
        ).fetchall()
        conn.close()
        phrases.extend(r[0] for r in rows)
        print(f'Included {len(rows)} real posts from database.db')
    except Exception as e:
        print(f'Could not read posts ({e}); using hand-picked cases only')

expected = []
for text in phrases:
    scores = analyzer.polarity_scores(text)
    expected.append({'text': text, 'scores': scores})

with open('sentiment_expected.json', 'w', encoding='utf-8') as f:
    json.dump(expected, f, ensure_ascii=False, indent=1)

print(f'Wrote sentiment_expected.json with {len(expected)} cases')
